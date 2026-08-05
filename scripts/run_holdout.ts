// 未見評価(空間ホールドアウト)を 5 区画ぶん通しで回す。
//
// 対応 spec: docs/FB_2026-07-31.md P1-1(空間保留検証)。
//
// 何をするか(区画 f = 0〜4 について):
//   1. **区画 f を目的関数から外して**較正する(訓練)
//   2. 得られた定数を **区画 f のセルだけで**採点する(未見)
//   3. 同じ定数を訓練側でも採点し、訓練と未見の差を見る
//
// なぜ要るか: 全球で較正して全球で採点すると、パラメータが観測へ
// 過剰適合しても気付けない。**未見の区画でも同じ改善が出るか**が、
// 「地球を再現できている」と「地球に合わせ込んだ」を分ける。
//
// 予算: 1 区画あたり `--minutes` 分。5 区画で 5 倍かかるので、
// 通しで回すときは 1 区画 60〜90 分が現実的(1 評価あたり実時間 280 秒)。
//
// 実行: npx tsx scripts/run_holdout.ts <種JSON> <1区画あたりの分> [並列数]
//   例: npx tsx scripts/run_holdout.ts out/optimize/best_v13evap.json 75 2

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const SEED = process.argv[2];
const MINUTES = Number(process.argv[3] ?? 75);
const PARALLEL = Number(process.argv[4] ?? 2);
const OUT_DIR = path.join('out', 'optimize');

if (!SEED || !fs.existsSync(SEED)) {
  console.log('使い方: npx tsx scripts/run_holdout.ts <種JSON> <1区画あたりの分> [並列数]');
  process.exit(1);
}

function main(): void {
  const seed = JSON.parse(fs.readFileSync(SEED!, 'utf8')) as Record<string, number>;
  for (let fold = 0; fold < 5; fold++) {
    const run = `hold${fold}`;
    const statePath = path.join(OUT_DIR, `state_${run}_fold${fold}.json`);
    // 種から状態を作る(既にあれば続きから)
    if (!fs.existsSync(statePath)) {
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          best: seed,
          // **null にしない**。JSON は -Infinity を表せないので、
          // optimize.ts 側で null → -Infinity へ戻す扱いにしてある
          bestFit: null,
          bestScores: null,
          evals: 0,
          sweep: 0,
          cursor: 0,
          stepFrac: 0.12,
          sensitivity: {},
          phase: 'descent',
          screenCursor: 999,
          seed: 42 + fold,
        }),
      );
    }
    console.log(`\n===== 区画 ${fold} の較正(${MINUTES} 分)=====`);
    const r = spawnSync(
      'npx',
      [
        'tsx',
        'scripts/optimize.ts',
        '--run',
        run,
        '--holdout-fold',
        String(fold),
        '--minutes',
        String(MINUTES),
        '--parallel',
        String(PARALLEL),
      ],
      { stdio: 'inherit', shell: true },
    );
    if (r.status !== 0) {
      console.log(`区画 ${fold} の較正が異常終了した(status ${String(r.status)})。ここで止める`);
      return;
    }
  }
  console.log('\n全 5 区画の較正が完了。採点は scripts/score_holdout.ts で行う');
}

main();
