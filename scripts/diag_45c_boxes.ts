// 診断: **45c の組(relief×conveyor)で validate の中国東部箱は何 mm になるか。**
// 事前登録の予測 39(≥330mm)の直接判定。ついでにラプラタ・豪州内陸も出す。
// 実行: DIAG_OVERRIDE='monsoonTroughSubsRelief=0.6,conveyorStrength=30' npx tsx scripts/diag_45c_boxes.ts
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { latDegOfRow, lonDegOfCol } from '../src/domain/grid';
import { majorClassOf } from '../src/domain/koppen';
import { getKoppenObs } from './scoring';
import { openAccel } from './accel_cli';

const K = MODEL_CONSTANTS as unknown as Record<string, number>;
if (process.env['DIAG_OVERRIDE']) {
  for (const part of process.env['DIAG_OVERRIDE'].split(',')) {
    const [name, raw] = part.split('=');
    const key = (name ?? '').trim();
    const v = Number(raw);
    if (!key || !(key in K)) throw new Error(`未知の定数 '${key}'`);
    K[key] = v;
    console.log(`[上書き] ${key} = ${v}`);
  }
}

const BOXES: Array<[string, number, number, number, number]> = [
  ['中国東部', 25, 35, 105, 122],
  ['ラプラタ', -35, -27, -65, -55],
  ['豪州内陸', -30, -22, 120, 140],
];

async function main(): Promise<void> {
  const accel = await openAccel(true);
  let r;
  try { r = await runPipeline(EARTH_PARAMS, accel.opts); } finally { accel.close(); }
  const grid = r.context.grid;
  const W = grid.widthCells;
  const land = r.context.terrain.landMask;
  const kobs = getKoppenObs();
  for (const [name, la0, la1, lo0, lo1] of BOXES) {
    let pSum = 0; let n = 0; let cOk = 0; let cTot = 0; let bWrongC = 0; let bTot = 0;
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = latDegOfRow(grid, row);
      if (lat < la0 || lat > la1) continue;
      for (let col = 0; col < W; col++) {
        let lon = lonDegOfCol(grid, col); if (lon > 180) lon -= 360;
        if (lon < lo0 || lon > lo1) continue;
        const i = row * W + col;
        if (!land[i]) continue;
        pSum += r.precipitation.annualPrecipMm[i] ?? 0; n++;
        const om = majorClassOf(kobs.classRaster[i] ?? 0);
        const mm = majorClassOf(r.koppen.classId[i] ?? 0);
        if (om === 2) { cTot++; if (mm === 2) cOk++; }
        if (om === 1) { bTot++; if (mm === 2) bWrongC++; }
      }
    }
    console.log(`${name}: 年降水 ${(pSum / Math.max(1, n)).toFixed(0)}mm / 観測Cの正答 ${cTot ? (100 * cOk / cTot).toFixed(1) : '-'}% / 観測BのC誤り ${bTot ? (100 * bWrongC / bTot).toFixed(1) : '-'}%`);
  }
}
void main();
