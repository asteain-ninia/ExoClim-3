// 反復の収束を律速しているのが**どの結合か**を実測する。
//
// 動機(2026-08-02):
//   1 実行 245 秒のうち大半が「512 反復 × 24 年」。反復を速くしたいが、
//   初期推定の外挿は 2 方式とも棄却された(緩和が単一モードではない)。
//   残る手は反復法そのものの改良(線緩和・多重格子)だが、**どの方向の
//   結合が律速か**が分からないと設計できない。
//
//   赤黒 Gauss-Seidel は 1 反復で情報が 1 セルしか伝わらない。
//   結合が強い方向ほど遠くまで情報を運ぶ必要があり、そこが律速になる。
//   東西が律速なら**行ごとの直接解法(周期三重対角)**が効く。
//   南北が律速なら列方向、両方なら多重格子が要る。
//
// 測り方: 反復回数を**低めに固定**して、各方向の結合を切ったときの残差を比べる。
//   残差が大きく下がる方向が律速(その結合の情報伝播に反復を食われている)。
//   自動延長に任せると 512 で全部足りてしまい差が見えない(最初これで失敗した)。
//
// 実行: npx tsx scripts/exp_ebm_bottleneck.ts

import { performance } from 'node:perf_hooks';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import {
  EBM_SOLVER,
  EBM_SOLVER_STATS,
  EBM_FULL_CAPACITY_YEARS,
  EBM_SOLVE_TOLERANCE_C,
} from '../src/sim/step05_temperature';
import { openAccel } from './accel_cli';

const K = MODEL_CONSTANTS as unknown as Record<string, number>;
const accel = await openAccel();
// 年数は短く固定(ここで見たいのは反復の収束速度だけ)
EBM_FULL_CAPACITY_YEARS.years = 4;
/** 反復回数を低めに固定して残差の差を見る */
const FIXED_SWEEPS = Number(process.argv[2] ?? 48);
EBM_SOLVER.sweeps = FIXED_SWEEPS;

const CASES: { label: string; set: Record<string, number> }[] = [
  { label: '現行(全結合)', set: {} },
  { label: '東西移流 0', set: { zonalAdvectionCouplingWm2PerK: 0 } },
  { label: '東西拡散 0', set: { zonalDiffusionFactor: 0 } },
  { label: '東西 両方 0', set: { zonalAdvectionCouplingWm2PerK: 0, zonalDiffusionFactor: 0 } },
  { label: '南北拡散 半分', set: { diffusionWm2PerK: 0.2742 } },
  { label: 'ハドレー増強 0', set: { hadleyDiffusionBoost: 0 } },
];

console.log(
  `反復 ${FIXED_SWEEPS} 回に固定 / 全熱容量 4 年 / 許容差 ${EBM_SOLVE_TOLERANCE_C.toExponential(1)}°C\n`,
);
console.log('条件                      最大残差   基準比      所要');
let baseRes = 0;
for (const c of CASES) {
  const saved: Record<string, number> = {};
  for (const [k2, v] of Object.entries(c.set)) {
    saved[k2] = K[k2] ?? 0;
    K[k2] = v;
  }
  EBM_SOLVER_STATS.maxResidualC = 0;
  EBM_SOLVER_STATS.maxSweeps = 0;
  const t0 = performance.now();
  await runPipeline(EARTH_PARAMS, accel.opts);
  const sec = (performance.now() - t0) / 1000;
  for (const [k2, v] of Object.entries(saved)) K[k2] = v;
  const res = EBM_SOLVER_STATS.maxResidualC;
  if (baseRes === 0) baseRes = res;
  console.log(
    `${c.label.padEnd(22, '　')}${res.toExponential(2).padStart(10)}   ` +
      `${(res / baseRes).toFixed(2).padStart(6)}   ${sec.toFixed(0).padStart(5)}s`,
  );
}
EBM_FULL_CAPACITY_YEARS.years = 0;
EBM_SOLVER.sweeps = 0;
EBM_SOLVER.adaptive = true;
accel.close();
console.log(
  '\n結合を切って反復数が大きく減る方向が律速。\n' +
    '  東西で減る → 行ごとの周期三重対角解法(線緩和)が効く\n' +
    '  南北で減る → 列方向の線緩和\n' +
    '  どちらでも減らない → 多重格子が要る',
);
