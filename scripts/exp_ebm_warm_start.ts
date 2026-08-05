// 検査: EBM の収束解は**開始点に依らない**か(ウォームスタートの前提の検査)。
//
// 対応 spec: なし(数値の検査)。**採用の判断はまだしていない**
// (2026-08-02 の利用者判断: 実装は保留、検査だけ先に済ませる)。
//
// なぜ検査が要るか:
//   費用の 97.9% は EBM の時間積分にある(scripts/prof_stage_cost.ts の実測)。
//   前回の収束温度場から始められれば緩和年数が大きく減るはずで、これが
//   **唯一残っている大きな速度レバー**である(外挿・線緩和は棄却済み、
//   多重格子は未着手 — docs/計算費用の課題_2026-08-02.md)。
//
//   ただしウォームスタートは**決定性規約に触れる**: 「同じ入力に同じ答え」が
//   直前の操作履歴に依存しうる。理屈の上では、周期定常の判定
//   (meanYearDriftC ≤ 0.05°C)を満たす限り答えは開始点に依らないはずだが、
//   **これは仮説であって実測ではない**。仮説のまま実装すると、
//   「速いが答えが履歴で変わる」という最悪の形になる。
//
// 何をどう測るか — **この設計は 2026-08-02 の実行で失敗と判明した。下の注記を読むこと。**
//   加速期の年数(熱容量 1/16 で回す期間、budget.ebmSpinupAccelYears)を
//   2 / 6 / 10 年と変えれば、全熱容量の緩和が始まる時点の温度場が変わり、
//   「同じ物理・同じ収束条件・違う開始点」を作れる — と考えた。
//
//   **誤りだった。** 9 ケースすべてで差が**厳密に 0.000°C**(ビット一致)に
//   なった。一致したのではなく、**開始点が一つも変わっていなかった**のである。
//   加速期の時定数は τ' ≈ 0.2 年なので、2 年(= 10τ')で既に自分の周期解へ
//   落ち着いている。6 年でも 10 年でもそこに留まるだけで、全熱容量の相へ入る
//   ときの状態は同一。だから出力もビット一致した。
//
//   これは docs/教訓.md §9 に**先に記録されている落とし穴そのもの**である
//   (「増やしても変わらない」を言う前に、増えているのが何かを確かめる)。
//   記録があるのに同じ形で踏んだ。**ビット一致は「頑健」ではなく
//   「何も変えていない」の徴候**として読むこと。
//
//   正しく測るには **initialT を外から差し込む口**が要る。step05 の
//   integrate/integrateAny は既に initialT を受け取れる(パス 2 が
//   パス 1 の finalT を使う)が、computeTemperature の外へは出ていない。
//   その口を開けるのは「検査だけ」の範囲を超えるので、利用者の判断を待つ。
//
// 事前に登録する判定:
//   不成立 … 全ケースの差が厳密に 0 → 開始点が変わっていない。**合格にしない**
//   合格   … 差が 0 でなく、かつ全ケースで面積重み平均差 ≤ 0.05°C
//   棄却   … 1 ケースでも許容差を超えたら不採用。
//            「だいたい合っているから」で通さない(隠しパラメータと同じ構造)。
//
// 費用の見積もり(先に読むこと):
//   **2° にしても安くならない**。EBM は表示格子に関わらず自前の粗格子
//   (MODEL_CONSTANTS.ebmResolutionDeg = 2°、16,200 セル)で解くので、
//   gridResolutionDeg を 1° → 2° に落として安くなるのは降水(全体の 2%)だけ。
//   この検査は「収束した解」どうしを比べる必要があるので予算も削れない。
//   1 実行 ≈ 確定計算 1 回ぶん(実測 570 秒、GPU 競合時)× 惑星 3 × 開始点 3
//   = **1〜2 時間**。較正と同時に走らせないこと(互いに GPU を奪い合う)。
//
// 実行: npx tsx scripts/exp_ebm_warm_start.ts

import { performance } from 'node:perf_hooks';
import { computeTemperature, EBM_SOLVER_STATS } from '../src/sim/step05_temperature';
import { buildSimContext } from '../src/sim/context';
import { computeItcz } from '../src/sim/step01_itcz';
import { computeWindBelt } from '../src/sim/step02_windbelt';
import { computeOceanCurrent } from '../src/sim/step03_ocean';
import { computeAirflow } from '../src/sim/step04_airflow';
import { EARTH_PARAMS, type PlanetParams } from '../src/domain/planetParams';
import { createGrid, latDegOfRow } from '../src/domain/grid';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { openAccel } from './accel_cli';
import type { RunOptions } from '../src/sim/accel';
import type { ConvergenceBudget } from '../src/sim/run_control';
import type { TemperatureResult } from '../src/sim/types';

/** 周期定常の許容差(step05 の EBM_PERIODIC_TOLERANCE_C と揃える) */
const TOLERANCE_C = 0.05;

const BASE: PlanetParams = { ...EARTH_PARAMS, gridResolutionDeg: 2 };
const GRID = createGrid(BASE.gridResolutionDeg);

/** 惑星を変えても成り立つかを見る(地球だけで判断しない) */
const PLANETS: Array<{ label: string; params: PlanetParams }> = [
  { label: '地球', params: BASE },
  {
    label: '全陸(収束しにくい)',
    params: { ...BASE, terrain: { kind: 'preset', preset: 'all_land' } },
  },
  {
    label: '寒冷(光度 0.9)',
    params: { ...BASE, orbital: { ...BASE.orbital, starLuminositySolar: 0.9 } },
  },
];

/**
 * 開始点だけが違う 3 通り(加速期の年数を変える)。
 *
 * 上限に注意: GPU 経路は MAX_STEPS = 8192 なので、240 刻みだと
 * **合計 34 年**までしか回せない。全熱容量 24 年 + 加速期 10 年 = 34 年で
 * ちょうど上限。これを超えると「時間ステップ数が上限を超えた」で落ちる
 * (2026-08-02 に実際に踏んだ)。
 */
const STARTS = [2, 6, 10];

async function solveTemperature(
  params: PlanetParams,
  opts: RunOptions,
): Promise<TemperatureResult> {
  const ctx = buildSimContext(params);
  const itcz = computeItcz(ctx);
  const wb = computeWindBelt(ctx, itcz);
  const ocean = computeOceanCurrent(ctx, itcz, wb);
  const air = computeAirflow(ctx, itcz, wb);
  return computeTemperature(ctx, itcz, wb, ocean, air, undefined, opts);
}

/** 面積重み平均の絶対差(°C)。周期定常の判定と同じ物差しで測る */
function meanAbsDiffC(a: TemperatureResult, b: TemperatureResult): number {
  let sum = 0;
  let wSum = 0;
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const am = a.monthlyTemperatureC[m];
    const bm = b.monthlyTemperatureC[m];
    if (!am || !bm) continue;
    for (let row = 0; row < GRID.heightCells; row++) {
      const w = Math.cos((latDegOfRow(GRID, row) * Math.PI) / 180);
      for (let col = 0; col < GRID.widthCells; col++) {
        const i = row * GRID.widthCells + col;
        sum += w * Math.abs((am[i] ?? 0) - (bm[i] ?? 0));
        wSum += w;
      }
    }
  }
  return wSum > 0 ? sum / wSum : 0;
}

function maxAbsDiffC(a: TemperatureResult, b: TemperatureResult): number {
  let max = 0;
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const am = a.monthlyTemperatureC[m];
    const bm = b.monthlyTemperatureC[m];
    if (!am || !bm) continue;
    for (let i = 0; i < am.length; i++) {
      const d = Math.abs((am[i] ?? 0) - (bm[i] ?? 0));
      if (d > max) max = d;
    }
  }
  return max;
}

const accel = await openAccel();
let verdict: 'pass' | 'fail' = 'pass';
/** 一度でも「基準と違う結果」が出たか。出なければ開始点を変えられていない */
let anyDifference = false;
try {
  console.log('=== EBM: 収束解は開始点に依るか(2°、ウォームスタートの前提の検査)===');
  console.log(`判定の許容差 = ${TOLERANCE_C}°C(周期定常の許容差と同じ物差し)`);
  console.log(`開始点の作り分け: 加速期の年数 ${STARTS.join(' / ')} 年\n`);

  for (const planet of PLANETS) {
    console.log(`--- ${planet.label} ---`);
    const runs: Array<{ years: number; r: TemperatureResult; ms: number; drift: number }> = [];
    for (const years of STARTS) {
      const budget: ConvergenceBudget = { ebmSpinupAccelYears: years };
      const t = performance.now();
      try {
        const r = await solveTemperature(planet.params, { ...accel.opts, budget });
        const ms = performance.now() - t;
        runs.push({ years, r, ms, drift: EBM_SOLVER_STATS.meanYearDriftC });
      } catch (e) {
        // 収束しない惑星は年数を倍にしようとして GPU の步数上限に当たる。
        // 検査そのものは続けたいので、落ちた事実を記録して次へ進む
        console.log(`  加速期 ${years} 年: 実行できず — ${e instanceof Error ? e.message : e}`);
      }
    }
    const ref = runs[0];
    if (!ref || runs.length < 2) {
      console.log('  比較対象が足りないため判定できない\n');
      continue;
    }
    for (const run of runs) {
      const mean = meanAbsDiffC(ref.r, run.r);
      const max = maxAbsDiffC(ref.r, run.r);
      const ok = mean <= TOLERANCE_C;
      if (!ok) verdict = 'fail';
      if (run.years !== ref.years && max > 0) anyDifference = true;
      console.log(
        `  加速期 ${String(run.years).padStart(2)} 年  ${(run.ms / 1000).toFixed(1).padStart(6)}s  ` +
          `平均差 ${mean.toFixed(4)}°C  最大差 ${max.toFixed(3)}°C  ` +
          `${run.years === ref.years ? '(基準)' : ok ? '✓' : '✗ 許容差超え'}`,
      );
    }
    console.log('');
  }

  console.log('=== 判定 ===');
  if (!anyDifference) {
    // **合格にしない**。全ケースがビット一致するのは「頑健」ではなく
    // 「独立変数が動いていない」の徴候(docs/教訓.md §9)
    console.log('✗ 検査不成立 — 全ケースがビット一致した。');
    console.log('  一致したのではなく、**開始点が一つも変わっていない**。');
    console.log('  加速期の時定数は τ\' ≈ 0.2 年なので、2 年で既に自分の周期解へ');
    console.log('  落ち着く。6 年でも 10 年でもそこに留まるだけで、全熱容量の相へ');
    console.log('  入るときの状態は同一 — だから出力もビット一致する。');
    console.log('');
    console.log('  この方法では「収束解が開始点に依るか」は測れない。');
    console.log('  正しく測るには computeTemperature に initialT を差し込む口が要る。');
    console.log('  → ウォームスタートの可否は**未判定のまま**。採用してはいけない。');
  } else if (verdict === 'pass') {
    console.log('✓ 収束解は開始点に依らない(全ケースで許容差以下、かつ差はゼロでない)。');
    console.log('  → ウォームスタートを入れても答えは変わらない、という主張の裏付けになる。');
    console.log('  次の一手: computeTemperature に前回の finalT を渡す口を開け、');
    console.log('  「同じ答え・少ない年数」を実測して採用を判断する。');
  } else {
    console.log('✗ 開始点によって答えが変わった。**ウォームスタートは不採用**。');
    console.log('  周期定常の判定(meanYearDriftC)が実際には収束を保証していない、');
    console.log('  ということなので、そちらを先に調べること。');
  }
} finally {
  accel.close();
}
