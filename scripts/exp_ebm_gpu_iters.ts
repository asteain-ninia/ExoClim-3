// GPU 経路で、1 ステップあたりの反復回数と残差・採点の関係を測る。
//
// 目的: EBM_GPU_ITERATIONS を「決め打ちの魔法数」ではなく
// 「許容差 EBM_SOLVE_TOLERANCE_C を満たすことを確かめた値」にする。
//
// 実行: npx tsx scripts/exp_ebm_gpu_iters.ts

import { performance } from 'node:perf_hooks';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { evaluateResult } from './optimize_lib';
import { EBM_SOLVER, EBM_SOLVER_STATS, EBM_SOLVE_TOLERANCE_C } from '../src/sim/step05_temperature';
import { openAccel } from './accel_cli';
import { areaWeightOfRow } from '../src/domain/grid';

const accel = await openAccel();
if (!accel.enabled) {
  console.error('GPU が使えない');
  process.exit(1);
}

const ITERS = [8, 16, 32, 64, 128, 256, 512, 1024];
console.log(`許容差 ${EBM_SOLVE_TOLERANCE_C.toExponential(1)}°C\n`);
console.log('反復   大分類   詳細  ゲート 気温RMSE   最大残差(°C)   前段との気温差   所要');

let prev: Float32Array | null = null;
for (const n of ITERS) {
  EBM_SOLVER.sweeps = n;
  EBM_SOLVER_STATS.maxResidualC = 0;
  const t0 = performance.now();
  const r = await runPipeline(EARTH_PARAMS, accel.opts);
  const ms = performance.now() - t0;
  const s = evaluateResult(r);
  const cur = Float32Array.from(r.temperature.annualMeanC);
  let diff = '—';
  if (prev) {
    const grid = r.context.grid;
    let sum = 0;
    let wsum = 0;
    for (let row = 0; row < grid.heightCells; row++) {
      const w = areaWeightOfRow(grid, row);
      for (let col = 0; col < grid.widthCells; col++) {
        const i = row * grid.widthCells + col;
        sum += w * Math.abs((cur[i] ?? 0) - (prev[i] ?? 0));
        wsum += w;
      }
    }
    diff = `${(sum / wsum).toFixed(4)}°C`;
  }
  prev = cur;
  const ok = EBM_SOLVER_STATS.maxResidualC <= EBM_SOLVE_TOLERANCE_C ? '✅' : '  ';
  console.log(
    `${String(n).padStart(4)}  ${s.majorPct.toFixed(2)}  ${s.detailPct.toFixed(2)}  ` +
      `${String(s.gates).padStart(4)}  ${s.tempRmse.toFixed(3)}   ` +
      `${EBM_SOLVER_STATS.maxResidualC.toExponential(2)} ${ok}   ` +
      `${diff.padStart(12)}   ${(ms / 1000).toFixed(1)}s`,
  );
}
accel.close();
EBM_SOLVER.sweeps = 8;
