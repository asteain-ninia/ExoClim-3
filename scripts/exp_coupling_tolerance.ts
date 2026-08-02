// 降水の結合反復(土壌 ⇄ 再循環 ⇄ 降水)の打ち切りが
// 答えを決めていないかを確かめる。
//
// 動機(2026-08-02):
//   EBM で「反復の打ち切り」「緩和年数」が隠しパラメータだったことが 3 件
//   見つかった。同じ疑いは step6 の結合反復にもある:
//     COUPLING_TOLERANCE_MM_PER_MONTH = 0.2、COUPLING_MAX_ITERATIONS = 8
//   実測では 5 回で収束と報告されているが、**許容差を厳しくしたら答えが
//   動くか**は確かめていない。動くなら、0.2 という値が答えを決めている。
//
//   同じことを土壌の空回し(SOIL_SPINUP_TOLERANCE_MM = 0.05)にも行う。
//
// 実行: npx tsx scripts/exp_coupling_tolerance.ts
//   ※ 較正と同時に走らせない(GPU を奪い合う)

import { performance } from 'node:perf_hooks';
import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { evaluateResult } from './optimize_lib';
import { openAccel } from './accel_cli';
import { areaWeightOfRow } from '../src/domain/grid';
import type { PipelineResult } from '../src/sim/types';

import {
  COUPLING_MAX_ITERATIONS,
  COUPLING_OVERRIDE,
  COUPLING_TOLERANCE_MM_PER_MONTH,
} from '../src/sim/step06_precipitation';

const accel = await openAccel();

const couplingOf = (r: PipelineResult): { iterations: number; converged: boolean } => {
  const c = (
    r.precipitation as unknown as { coupling?: { iterations: number; converged: boolean } }
  ).coupling;
  return { iterations: c?.iterations ?? -1, converged: c?.converged ?? false };
};

console.log(
  `許容差 ${COUPLING_TOLERANCE_MM_PER_MONTH} mm/月 / 既定の上限 ${COUPLING_MAX_ITERATIONS} 回\n`,
);
console.log('上限  大分類   詳細  ゲート 気温RMSE  陸平均  反復  収束  前段との降水差   所要');

let prev: Float32Array | null = null;
for (const cap of [1, 2, 3, 5, 8, 12]) {
  COUPLING_OVERRIDE.maxIterations = cap;
  const t0 = performance.now();
  const { result } = await runPipelineWithPrecipDiag(EARTH_PARAMS, accel.opts);
  const ms = performance.now() - t0;
  const s = evaluateResult(result);
  const c = couplingOf(result);
  const cur = Float32Array.from(result.precipitation.annualPrecipMm);
  let diff = '—';
  if (prev) {
    const grid = result.context.grid;
    let sum = 0;
    let wsum = 0;
    for (let row = 0; row < grid.heightCells; row++) {
      const w = areaWeightOfRow(grid, row);
      for (let col = 0; col < grid.widthCells; col++) {
        const i = row * grid.widthCells + col;
        if (!result.context.terrain.landMask[i]) continue;
        sum += w * Math.abs((cur[i] ?? 0) - (prev[i] ?? 0));
        wsum += w;
      }
    }
    diff = `${(sum / Math.max(1e-9, wsum)).toFixed(2)}mm`;
  }
  prev = cur;
  console.log(
    `${String(cap).padStart(4)}  ${s.majorPct.toFixed(2)}  ${s.detailPct.toFixed(2)}  ` +
      `${String(s.gates).padStart(4)}  ${s.tempRmse.toFixed(3)}  ${Math.round(s.landMeanMm).toString().padStart(6)}  ` +
      `${String(c.iterations).padStart(4)}  ${c.converged ? '✅' : '❌'}  ${diff.padStart(12)}  ` +
      `${(ms / 1000).toFixed(0)}s`,
  );
}
COUPLING_OVERRIDE.maxIterations = 0;
accel.close();
console.log(
  '\n上限を増やして降水が動かなくなっていれば、結合反復は収束している。' +
    '\n動き続けるなら COUPLING_TOLERANCE / MAX_ITERATIONS が答えを決めている。',
);
