// 較正の探索空間の端で、EBM の線形解が固定 512 反復で収束するかを調べる。
//
// 動機(2026-08-02):
//   全陸惑星は 512 反復で収束しない(残差 3.1e-3)。陸は熱容量が小さく
//   C/dt が効かないため対角優位が弱い。較正の探索空間には
//   landEffectiveWaterDepthM(0.5〜8)が入っているので、**探索中に
//   未収束の領域へ入りうる**。未収束は歴史的に成績を良く見せる方向に働く
//   (GS_SWEEPS の件)ので、較正がそこへ引き寄せられる危険がある。
//
// ここでは輸送と熱容量の端を突いて、必要反復数を実測する。
//
// 実行: npx tsx scripts/check_ebm_residual_space.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { EBM_SOLVER_STATS, EBM_SOLVE_TOLERANCE_C } from '../src/sim/step05_temperature';
import { openAccel } from './accel_cli';

const K = MODEL_CONSTANTS as unknown as Record<string, number>;
const accel = await openAccel();

/** 探索空間の端(optimize_lib.ts の SPACE より) */
const CASES: [string, number][] = [
  ['landEffectiveWaterDepthM', 0.5],
  ['landEffectiveWaterDepthM', 8],
  ['diffusionWm2PerK', 0.65],
  ['hadleyDiffusionBoost', 1.2],
  ['zonalAdvectionCouplingWm2PerK', 60],
  ['zonalDiffusionFactor', 0.12],
];

console.log(`許容差 ${EBM_SOLVE_TOLERANCE_C.toExponential(1)}°C\n`);
console.log('定数                                値   要した反復   最大残差');
for (const [name, value] of CASES) {
  const base = K[name];
  if (base === undefined) continue;
  K[name] = value;
  EBM_SOLVER_STATS.maxResidualC = 0;
  EBM_SOLVER_STATS.maxSweeps = 0;
  EBM_SOLVER_STATS.capHits = 0;
  await runPipeline(EARTH_PARAMS, accel.opts);
  K[name] = base;
  const ok = EBM_SOLVER_STATS.maxResidualC <= EBM_SOLVE_TOLERANCE_C;
  console.log(
    `${name.padEnd(32)}${String(value).padStart(6)}${String(EBM_SOLVER_STATS.maxSweeps).padStart(11)}   ` +
      `${EBM_SOLVER_STATS.maxResidualC.toExponential(2)} ${ok ? '✅' : '❌'}`,
  );
}
accel.close();
console.log(
  '\n「要した反復」が 512 を超える組み合わせがあるなら、' +
    '固定 512 での較正は未収束の領域へ引き寄せられる危険がある。',
);
