// 既定設定(GPU・512 反復)で線形解が許容差を満たしているかだけを確かめる。
//
// exp_ebm_gpu_iters.ts の軽量版。較正を回している最中でも GPU をほとんど
// 奪わずに「今の設定で収束しているか」を検査できる。
//
// 実行: npx tsx scripts/check_ebm_residual.ts [惑星]
//   惑星: earth(既定)/ aqua / allland — 極端な地形でも足りるかを見る

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import {
  EBM_SOLVER_STATS,
  EBM_SOLVE_TOLERANCE_C,
  EBM_PERIODIC_TOLERANCE_C,
} from '../src/sim/step05_temperature';
import { openAccel } from './accel_cli';
import type { PlanetParams } from '../src/domain/planetParams';

const which = process.argv[2] ?? 'earth';
const PRESETS: Record<string, PlanetParams> = {
  earth: EARTH_PARAMS,
  aqua: { ...EARTH_PARAMS, terrain: { kind: 'preset', preset: 'aquaplanet' } },
  allland: { ...EARTH_PARAMS, terrain: { kind: 'preset', preset: 'all_land' } },
  twocont: { ...EARTH_PARAMS, terrain: { kind: 'preset', preset: 'two_continents' } },
  // 熱容量が小さい = 対角が弱い = 反復が効きにくい極端条件
  thinocean: {
    ...EARTH_PARAMS,
    atmosphere: { ...EARTH_PARAMS.atmosphere, oceanMixedLayerDepthM: 5 },
  },
};
const params = PRESETS[which] ?? EARTH_PARAMS;

const accel = await openAccel();
EBM_SOLVER_STATS.maxResidualC = 0;
EBM_SOLVER_STATS.capHits = 0;
EBM_SOLVER_STATS.maxYearDriftC = 0;
EBM_SOLVER_STATS.meanYearDriftC = 0;
await runPipeline(params, accel.opts);
accel.close();

const r = EBM_SOLVER_STATS.maxResidualC;
const ok = r <= EBM_SOLVE_TOLERANCE_C;
const yearOk = EBM_SOLVER_STATS.meanYearDriftC <= EBM_PERIODIC_TOLERANCE_C;
console.log(
  `${which.padEnd(10)}: 反復 ${String(EBM_SOLVER_STATS.maxSweeps).padStart(5)} / ` +
    `残差 ${r.toExponential(3)}°C ${ok ? '✅' : '❌'} / ` +
    `全熱容量 ${String(EBM_SOLVER_STATS.fullCapacityYears).padStart(3)} 年 / ` +
    `年次ドリフト 平均 ${EBM_SOLVER_STATS.meanYearDriftC.toExponential(3)} / 最大 ${EBM_SOLVER_STATS.maxYearDriftC.toExponential(2)}°C ` +
    `(許容差 ${EBM_PERIODIC_TOLERANCE_C})${yearOk ? ' ✅' : ' ❌'}` +
    `${EBM_SOLVER_STATS.capHits > 0 ? ` / 未収束 ${EBM_SOLVER_STATS.capHits}` : ''}`,
);
process.exit(ok ? 0 : 1);
