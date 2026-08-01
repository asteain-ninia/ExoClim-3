// パイプラインの負荷内訳を実測する(GPU 化の対象を決めるため)。
//
// 対応 spec: なし(計測ツール)。
// 2026-08-01 の実測: step6 降水 24.8s(77%)・step5 気温 7.0s(22%)で
// 合計 99%。step6 の中身は土壌水分バケツが支配的で、結合反復が最大 8 回呼ぶ。
//
// 実行: npx tsx scripts/prof_pipeline.ts

import { performance } from 'node:perf_hooks';
import { runPipelineTimed, runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { solveSoilWater } from '../src/sim/step06_precipitation';
import { MODEL_CONSTANTS as K } from '../src/sim/constants';

const t0 = performance.now();
const { result, stepTimingsMs } = runPipelineTimed(EARTH_PARAMS);
const total = performance.now() - t0;

console.log(`パイプライン全体: ${total.toFixed(0)}ms`);
const entries = Object.entries(stepTimingsMs).sort((a, b) => b[1] - a[1]);
for (const [name, ms] of entries) {
  console.log(`  ${name.padEnd(20)} ${ms.toFixed(0).padStart(7)}ms  ${((ms / total) * 100).toFixed(1)}%`);
}

// 結合反復の回数と、土壌 1 回の所要
const { result: r2, soil } = runPipelineWithPrecipDiag(EARTH_PARAMS);
const coupling = (r2.precipitation as unknown as { coupling?: { iterations: number; converged: boolean } })
  .coupling;
console.log(
  `\n結合反復: ${coupling?.iterations ?? '不明'} 回(収束 ${coupling?.converged ?? '不明'})`,
);
console.log(`土壌の空回し: ${soil?.spinupYears ?? '不明'} 年`);

const grid = result.context.grid;
const land = result.context.terrain.landMask;
const precip: Float32Array[] = [];
const temp: Float32Array[] = [];
for (let m = 0; m < 12; m++) {
  precip.push(result.precipitation.monthlyPrecipMm[m]!);
  temp.push(result.temperature.monthlyTemperatureC[m]!);
}
const t1 = performance.now();
solveSoilWater(grid.cellCount, (i) => land[i] === 1, precip, temp, K.soilWaterCapacityMm, 2000, 0);
const soilMs = performance.now() - t1;
console.log(`土壌 1 回(冷えた状態から): ${soilMs.toFixed(0)}ms`);
if (coupling) {
  const est = soilMs * coupling.iterations;
  console.log(
    `土壌の推定合計: ${est.toFixed(0)}ms(step6 の ${((est / (stepTimingsMs.step6_precipitation ?? 1)) * 100).toFixed(0)}%)`,
  );
  console.log(`GPU 化(121 倍)後の推定: ${(est / 121).toFixed(0)}ms`);
}
