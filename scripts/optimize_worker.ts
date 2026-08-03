// 較正の評価ワーカー: stdin から JSON 行 {vector} を受け、パイプライン実行 +
// リーン採点して stdout に JSON 行 {scores} を返す。親は scripts/optimize.ts。
//
// パイプラインが非同期になったため、行の処理は**直列**に繋ぐ。
// 並行に走らせると同じ MODEL_CONSTANTS を複数の評価が同時に書き換えてしまい、
// どの定数ベクトルの成績なのか分からなくなる(親は 1 行 1 応答を前提にしている)。

import * as readline from 'node:readline';
import { runPipeline } from '../src/sim/pipeline';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { evaluateResult, UNSOLVED_FITNESS } from './optimize_lib';
import { EBM_SOLVER, EBM_SOLVER_STATS } from '../src/sim/step05_temperature';
import { openAccel } from './accel_cli';

// 較正では反復回数・緩和年数を**自動で増やさない**。
// 増やすと、収束しにくい領域が「高くつく」だけで探索対象に残ってしまう。
// 本来そこは棄却されるべきなので、予算を固定して未収束は失格にする。
EBM_SOLVER.adaptive = false;

// EBM の線形解は既定で収束させる(反復 512、隠しパラメータの除去)。
// CPU 経路だと 1 評価が数分かかり較正が成立しないので、
// GPU が取れなかったら**黙って遅くならずに**はっきり知らせる
const accelReady = openAccel(true).then((a) => {
  if (!a.enabled) {
    process.stderr.write(
      '[較正ワーカー] GPU を取得できなかった。収束させた EBM を CPU で回すと ' +
        '1 評価に数分かかる。EXOCLIM_GPU=0 を外すか、GPU の状態を確認すること。\n',
    );
  }
  return a;
});

const rl = readline.createInterface({ input: process.stdin });
let chain: Promise<void> = Promise.resolve();

rl.on('line', (line) => {
  chain = chain.then(async () => {
    try {
      const msg = JSON.parse(line) as {
        id: number;
        vector: Record<string, number>;
        holdoutFold?: number;
      };
      Object.assign(MODEL_CONSTANTS, msg.vector);
      const accel = await accelReady;
      const t0 = Date.now();
      // 統計は**評価ごとに**ゼロへ戻す。maxSweeps は最大値の累積なので、
      // 戻さないと「この評価が使った反復」ではなく「起動以来の最大」になる
      EBM_SOLVER_STATS.capHits = 0;
      EBM_SOLVER_STATS.maxSweeps = 0;
      EBM_SOLVER_STATS.fullCapacityYears = 0;
      const result = await runPipeline(EARTH_PARAMS, accel.opts);
      const scores = evaluateResult(result, msg.holdoutFold);
      // 予算内で解けなかった定数ベクトルは**失格**にする(減点ではない)
      if (EBM_SOLVER_STATS.capHits > 0) scores.fitness = UNSOLVED_FITNESS;
      process.stdout.write(
        JSON.stringify({
          id: msg.id,
          scores,
          sec: Math.round((Date.now() - t0) / 100) / 10,
          // 収束予算も返す。**費用がパラメータ由来か手掛かり由来かは
          // 所要時間だけでは分からない**(2026-08-03 に 1 評価 307s → 1110s の
          // 増加を「重いパラメータのせい」と読み違えかけた。実体は手掛かりの
          // 払い過ぎだった)。年数と反復を毎回残せば次は log を見るだけで済む
          ebmYears: EBM_SOLVER_STATS.fullCapacityYears,
          ebmIters: EBM_SOLVER_STATS.maxSweeps,
        }) + '\n',
      );
    } catch (e) {
      process.stdout.write(JSON.stringify({ error: String(e) }) + '\n');
    }
  });
});

// GPU デバイスは必ず破棄する(でないと exit 139)
rl.on('close', () => {
  chain = chain.then(async () => {
    (await accelReady).close();
  });
});
