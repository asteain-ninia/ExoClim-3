// EBM の GPU 実装を CPU 実装と突き合わせ、残差が許容差を満たすかを検証する。
//
// 対応: src/sim/gpu/ebm_gpu.ts。
// 反復回数(EBM_GPU_ITERATIONS)は決め打ちではなく「許容差を満たすことを
// 確かめた値」でなければならない。ここがその確認の場。
//
// 実行: npx tsx scripts/check_ebm_gpu.ts [反復回数]

import { performance } from 'node:perf_hooks';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { evaluateResult } from './optimize_lib';
import {
  EBM_SOLVER,
  EBM_SOLVER_STATS,
  EBM_SOLVE_TOLERANCE_C,
  EBM_GPU_ITERATIONS,
} from '../src/sim/step05_temperature';
import { openAccel } from './accel_cli';
import { areaWeightOfRow } from '../src/domain/grid';
import type { PipelineResult } from '../src/sim/types';

const ITERS = Number(process.argv[2] ?? EBM_GPU_ITERATIONS);

const compare = (a: PipelineResult, b: PipelineResult, label: string): void => {
  const grid = a.context.grid;
  let sum = 0;
  let wsum = 0;
  let maxAbs = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const w = areaWeightOfRow(grid, row);
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      const d = Math.abs((a.temperature.annualMeanC[i] ?? 0) - (b.temperature.annualMeanC[i] ?? 0));
      if (d > maxAbs) maxAbs = d;
      sum += w * d;
      wsum += w;
    }
  }
  console.log(
    `${label}: 面積平均 |Δ気温| ${(sum / wsum).toFixed(4)}°C / 最大 ${maxAbs.toFixed(3)}°C`,
  );
};

// ---- GPU(赤黒、指定回数)----
const accel = await openAccel();
if (!accel.enabled) {
  console.error('GPU が使えない');
  process.exit(1);
}
EBM_SOLVER.sweeps = ITERS; // GPU 側の反復回数もこれを見る
EBM_SOLVER_STATS.maxResidualC = 0;
let t0 = performance.now();
const gpu = await runPipeline(EARTH_PARAMS, accel.opts);
const gpuMs = performance.now() - t0;
const gpuResidual = EBM_SOLVER_STATS.maxResidualC;
const sg = evaluateResult(gpu);
accel.close();
console.log(
  `GPU 赤黒 ${ITERS} 反復: 大分類 ${sg.majorPct.toFixed(2)} / 詳細 ${sg.detailPct.toFixed(2)} / ` +
    `ゲート ${sg.gates} / 気温RMSE ${sg.tempRmse.toFixed(3)} (${(gpuMs / 1000).toFixed(1)}s)`,
);
console.log(
  `  全ステップ最大残差 ${gpuResidual.toExponential(3)}°C ` +
    `(許容差 ${EBM_SOLVE_TOLERANCE_C.toExponential(1)}°C)` +
    (gpuResidual <= EBM_SOLVE_TOLERANCE_C ? ' ✅ 収束' : ' ❌ 未収束 — 反復回数を増やすこと'),
);

// ---- CPU 参照(行優先、同じ回数)----
EBM_SOLVER.order = 'gauss-seidel';
EBM_SOLVER.sweeps = ITERS;
t0 = performance.now();
const cpu = await runPipeline(EARTH_PARAMS);
const cpuMs = performance.now() - t0;
const sc = evaluateResult(cpu);
console.log(
  `CPU 行優先 ${ITERS} 反復: 大分類 ${sc.majorPct.toFixed(2)} / 詳細 ${sc.detailPct.toFixed(2)} / ` +
    `ゲート ${sc.gates} / 気温RMSE ${sc.tempRmse.toFixed(3)} (${(cpuMs / 1000).toFixed(1)}s)`,
);
console.log(`\n高速化(全体): ${(cpuMs / gpuMs).toFixed(1)} 倍`);
compare(gpu, cpu, '\nGPU 対 CPU');
console.log(
  '\n収束していれば順序に依らず同じ解になるはず。' +
    '差が残るなら反復回数が足りないか、移植に誤りがある。',
);
EBM_SOLVER.sweeps = 8;
