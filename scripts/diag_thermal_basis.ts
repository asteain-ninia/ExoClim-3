// 診断(段 9): 温度 → 気圧の帰還で、**どの基準点から測るか**を確かめる。
//
// 段 9 の第 1 版は「同じ緯度円の平均気温」からの偏差で気圧を下げた。
// 未達 3 地域のうちインドだけが改善し、米南東・東アジアは悪化した。
//
// 疑い: 緯度円の平均は**その緯度で一番暑い大陸**に引きずられる。
//   30〜35°N の緯度円にはサハラとアラビアが乗っているので、米南東は
//   平均より**低温**になり、低気圧ではなく**高気圧**が立つ。
//   だとすれば基準点が間違っているのであって、機構が間違っているのではない。
//
// 実物のモンスーンを駆動するのは**海陸の温度差**なので、同じ緯度の
// **海の平均**を基準にするのが筋。両方を測って比べる。
//
// 実行: npx tsx scripts/diag_thermal_basis.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { latDegOfRow, lonDegOfCol } from '../src/domain/grid';
import { REGION_GATES } from './scoring';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

const TARGETS = [
  'india_tropical',
  'us_southeast_humid',
  'east_asia_humid',
  'congo_tropical',
  'europe_russia_continental',
  'sahara_arid',
];

function regionCells(r: PipelineResult, id: string): number[] {
  const gate = REGION_GATES.find((g) => g.id === id);
  const grid = r.context.grid;
  const land = r.context.terrain.landMask;
  const out: number[] = [];
  if (!gate) return out;
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    if (lat < gate.latMin || lat > gate.latMax) continue;
    for (let col = 0; col < grid.widthCells; col++) {
      const lon = lonDegOfCol(grid, col);
      const inLon =
        gate.lonMin <= gate.lonMax
          ? lon >= gate.lonMin && lon <= gate.lonMax
          : lon >= gate.lonMin || lon <= gate.lonMax;
      if (!inLon) continue;
      const i = row * grid.widthCells + col;
      if (land[i]) out.push(i);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const accel = await openAccel(true);
  let r: PipelineResult;
  try {
    r = await runPipeline(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }
  const grid = r.context.grid;
  const W = grid.widthCells;
  const land = r.context.terrain.landMask;

  console.log('夏の陸上気温が、2 つの基準からどれだけ暖かいか(°C)\n');
  console.log('地域            緯度円平均から   同緯度の海から   → 帰還の符号');

  for (const id of TARGETS) {
    const cells = regionCells(r, id);
    const gate = REGION_GATES.find((g) => g.id === id);
    const north = gate ? (gate.latMin + gate.latMax) / 2 >= 0 : true;
    const months = north ? [5, 6, 7] : [11, 0, 1];
    let sRow = 0;
    let sOcean = 0;
    let w = 0;
    for (const m of months) {
      const T = r.temperature.monthlyTemperatureC[m];
      if (!T) continue;
      // 行ごとの平均(全セル)と、海だけの平均
      const rowMean = new Float64Array(grid.heightCells);
      const oceanMean = new Float64Array(grid.heightCells);
      for (let row = 0; row < grid.heightCells; row++) {
        let a = 0;
        let o = 0;
        let no = 0;
        for (let col = 0; col < W; col++) {
          const i = row * W + col;
          a += T[i] ?? 0;
          if (!land[i]) {
            o += T[i] ?? 0;
            no++;
          }
        }
        rowMean[row] = a / W;
        oceanMean[row] = no > 0 ? o / no : a / W; // 海が無い緯度は行平均へ落とす
      }
      for (const i of cells) {
        const row = Math.floor(i / W);
        const cw = Math.cos((latDegOfRow(grid, row) * Math.PI) / 180);
        sRow += cw * ((T[i] ?? 0) - (rowMean[row] ?? 0));
        sOcean += cw * ((T[i] ?? 0) - (oceanMean[row] ?? 0));
        w += cw;
      }
    }
    const dRow = sRow / Math.max(1e-9, w);
    const dOcean = sOcean / Math.max(1e-9, w);
    const sign = dRow < 0 && dOcean > 0 ? '基準で符号が逆転' : dRow > 0 ? '両方とも低気圧' : '両方とも高気圧';
    console.log(
      `${id.split('_')[0]?.padEnd(14)} ${dRow.toFixed(2).padStart(10)} ` +
        `${dOcean.toFixed(2).padStart(14)}   ${sign}`,
    );
  }
}

void main();
