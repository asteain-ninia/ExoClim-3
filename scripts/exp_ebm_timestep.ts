// EBM の時間ステップ数を変えて、答えが動くかを確かめる。
//
// 動機(2026-08-02):
//   反復回数 GS_SWEEPS = 8 は答えを 2.1°C 動かす隠しパラメータだった。
//   同じ疑いが `ebmStepsPerYear = 240` にもある。陰解法なので安定性の制約は
//   無く、刻みは**精度**だけで決まる。240(1.5 日)が必要なのか、
//   それとも答えが刻みに依存しているのかを測る。
//
//   もし 60 でも同じ答えなら 4 倍速くなる(較正の回数を 4 倍にできる)。
//   もし増やすと答えが動くなら、240 は隠しパラメータであり直す必要がある。
//
// 実行: npx tsx scripts/exp_ebm_timestep.ts

import { performance } from 'node:perf_hooks';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { evaluateResult } from './optimize_lib';
import { EBM_SOLVER_STATS, EBM_SOLVE_TOLERANCE_C } from '../src/sim/step05_temperature';
import { openAccel } from './accel_cli';
import { areaWeightOfRow } from '../src/domain/grid';

const K = MODEL_CONSTANTS as unknown as Record<string, number>;
const base = K['ebmStepsPerYear'] ?? 240;
const accel = await openAccel();

console.log('刻み  大分類   詳細  ゲート 気温RMSE  要した反復  最大残差   前段との気温差   所要');
let prev: Float32Array | null = null;
for (const n of [60, 120, 240, 480]) {
  K['ebmStepsPerYear'] = n;
  EBM_SOLVER_STATS.maxResidualC = 0;
  EBM_SOLVER_STATS.maxSweeps = 0;
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
  const ok = EBM_SOLVER_STATS.maxResidualC <= EBM_SOLVE_TOLERANCE_C ? '✅' : '❌';
  console.log(
    `${String(n).padStart(4)}  ${s.majorPct.toFixed(2)}  ${s.detailPct.toFixed(2)}  ` +
      `${String(s.gates).padStart(4)}  ${s.tempRmse.toFixed(3)}  ` +
      `${String(EBM_SOLVER_STATS.maxSweeps).padStart(9)}  ` +
      `${EBM_SOLVER_STATS.maxResidualC.toExponential(2)} ${ok}  ${diff.padStart(12)}  ` +
      `${(ms / 1000).toFixed(1)}s`,
  );
}
K['ebmStepsPerYear'] = base;
accel.close();
console.log(
  '\n刻みを細かくして答えが動かなくなっていれば、時間離散化は収束している。' +
    '\n動き続けるなら ebmStepsPerYear は隠しパラメータであり、答えが刻みに依存している。',
);
