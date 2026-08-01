// GPU 加速と CPU 実装の物理場を突き合わせる。
//
// 方針(2026-08-01 のユーザー裁定): GPU を正・CPU を参照実装とする。
// f32 と f64 の差、および風上追跡の経路分岐(丸めで floor が別セルへ落ちる)で
// **完全一致はしない**。ここで測るのは「どれだけずれるか」であって、
// 一致を主張するためではない。
//
// 実行: npx tsx scripts/check_accel_parity.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { openAccel } from './accel_cli';
import { areaWeightOfRow } from '../src/domain/grid';
import type { PipelineResult } from '../src/sim/types';

const accel = await openAccel();
if (!accel.enabled) {
  console.error('GPU が使えないため突合できない');
  process.exit(1);
}
const gpu = await runPipeline(EARTH_PARAMS, accel.opts);
accel.close();
const cpu = await runPipeline(EARTH_PARAMS);

const grid = cpu.context.grid;
const N = grid.cellCount;
const land = cpu.context.terrain.landMask;

function compare(
  label: string,
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  landOnly = false,
): void {
  let maxAbs = 0;
  let sumAbs = 0;
  let sumRef = 0;
  let n = 0;
  let worst = -1;
  for (let i = 0; i < a.length; i++) {
    if (landOnly && !land[i % N]) continue;
    const d = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    if (d > maxAbs) {
      maxAbs = d;
      worst = i;
    }
    sumAbs += d;
    sumRef += Math.abs(b[i] ?? 0);
    n++;
  }
  const mean = n > 0 ? sumAbs / n : 0;
  const ref = n > 0 ? sumRef / n : 0;
  console.log(
    `${label.padEnd(24, '　')} 平均差 ${mean.toExponential(2)} / 最大差 ${maxAbs.toExponential(2)} ` +
      `/ 参照平均 ${ref.toFixed(3)} / 相対 ${ref > 0 ? ((mean / ref) * 100).toFixed(4) : '—'}%` +
      (worst >= 0 ? ` / 最大の位置 ${worst}` : ''),
  );
}

const flat = (arrs: Float32Array[]): Float32Array => {
  const out = new Float32Array(arrs.length * N);
  for (let m = 0; m < arrs.length; m++) out.set(arrs[m]!, m * N);
  return out;
};

console.log('=== 物理場の差(GPU 正 − CPU 参照)===');
compare('年平均気温', gpu.temperature.annualMeanC, cpu.temperature.annualMeanC);
compare(
  '月別気温',
  flat(gpu.temperature.monthlyTemperatureC),
  flat(cpu.temperature.monthlyTemperatureC),
);
compare('年降水', gpu.precipitation.annualPrecipMm, cpu.precipitation.annualPrecipMm);
compare(
  '月別降水',
  flat(gpu.precipitation.monthlyPrecipMm),
  flat(cpu.precipitation.monthlyPrecipMm),
);
compare('年降水(陸のみ)', gpu.precipitation.annualPrecipMm, cpu.precipitation.annualPrecipMm, true);

// ケッペン分類の不一致セル数(採点に直接効く指標)
let diff = 0;
let landCells = 0;
let wDiff = 0;
let wLand = 0;
for (let row = 0; row < grid.heightCells; row++) {
  const w = areaWeightOfRow(grid, row);
  for (let col = 0; col < grid.widthCells; col++) {
    const i = row * grid.widthCells + col;
    if (!land[i]) continue;
    landCells++;
    wLand += w;
    if (gpu.koppen.classId[i] !== cpu.koppen.classId[i]) {
      diff++;
      wDiff += w;
    }
  }
}
console.log(
  `\nケッペン不一致: ${diff} / ${landCells} 陸セル(${((diff / landCells) * 100).toFixed(3)}%、` +
    `面積重み ${((wDiff / wLand) * 100).toFixed(3)}%)`,
);

const couplingOf = (r: PipelineResult): string => {
  const c = (
    r.precipitation as unknown as { coupling?: { iterations: number; converged: boolean } }
  ).coupling;
  return `${c?.iterations ?? '?'} 回 / 収束 ${c?.converged ?? '?'}`;
};
console.log(`結合反復: GPU ${couplingOf(gpu)} / CPU ${couplingOf(cpu)}`);
