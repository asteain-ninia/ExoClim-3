// step6(降水、全体の 81%)の内訳を、定数の切り替えだけで切り分ける。
// コードを触らずに測れる範囲で「どこを GPU 化すべきか」を決めるため。
//
// 切り分けの原理:
//   反復 1 回 vs 既定回数 → 1 反復あたりの費用
//   土壌容量 0(土壌無効)  → 土壌の取り分
//
// 実行: npx tsx scripts/prof_step6_parts.ts

import { performance } from 'node:perf_hooks';
import { runPipelineTimed } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';

const K = MODEL_CONSTANTS as unknown as Record<string, number>;
const baseCapacity = K['soilWaterCapacityMm'] ?? 600;

const run = async (label: string): Promise<number> => {
  const t = performance.now();
  const { stepTimingsMs } = await runPipelineTimed(EARTH_PARAMS);
  const ms = stepTimingsMs.step6_precipitation ?? 0;
  console.log(`${label.padEnd(28)} step6 = ${ms.toFixed(0).padStart(7)}ms  (全体 ${(performance.now() - t).toFixed(0)}ms)`);
  return ms;
};

// 暖機(JIT)
await run('暖機(捨てる)');

const full = await run('既定');
K['soilWaterCapacityMm'] = 0;
const noSoil = await run('土壌無効(容量 0)');
K['soilWaterCapacityMm'] = baseCapacity;

console.log(`\n土壌の取り分: ${(full - noSoil).toFixed(0)}ms(step6 の ${(((full - noSoil) / full) * 100).toFixed(0)}%)`);
console.log(
  `土壌以外(風上追跡 + 変換 + 収束指数など): ${noSoil.toFixed(0)}ms(${((noSoil / full) * 100).toFixed(0)}%)`,
);
console.log('\n→ GPU 化の優先順位はこの比率で決める。');
