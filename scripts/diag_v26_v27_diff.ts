// 診断: **v26 と v27 の定数差だけで、大分類がどこで入れ替わるか。**
// 遷移(改善/悪化)の大分類ペアと代表座標、地域箱の年降水を両方で出す。
// 実行: npx tsx scripts/diag_v26_v27_diff.ts
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { latDegOfRow, lonDegOfCol } from '../src/domain/grid';
import { majorClassOf } from '../src/domain/koppen';
import { getKoppenObs } from './scoring';
import { openAccel } from './accel_cli';
import * as fs from 'node:fs';

const K = MODEL_CONSTANTS as unknown as Record<string, number>;
const MAJOR_NAME = ['A', 'B', 'C', 'D', 'E'];

async function main(): Promise<void> {
  const accel = await openAccel(true);
  let base; let alt; let grid; let land;
  try {
    const r0 = await runPipeline(EARTH_PARAMS, accel.opts);
    base = r0.koppen.classId; grid = r0.context.grid; land = r0.context.terrain.landMask;
    const best = JSON.parse(fs.readFileSync('out/optimize/best_v27.json', 'utf8')) as Record<string, number>;
    for (const [k, v] of Object.entries(best)) { if (k in K) K[k] = v; }
    const r1 = await runPipeline(EARTH_PARAMS, accel.opts);
    alt = r1.koppen.classId;
  } finally { accel.close(); }
  const kobs = getKoppenObs();
  const W = grid.widthCells;
  const worse = new Map<string, { w: number; lats: number[]; lons: number[] }>();
  const better = new Map<string, { w: number; lats: number[]; lons: number[] }>();
  let wW = 0; let wB = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    const cw = Math.cos((lat * Math.PI) / 180);
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      if (!land[i]) continue;
      const obsId = kobs.classRaster[i] ?? 0;
      if (obsId === 0) continue;
      const om = majorClassOf(obsId);
      const b = majorClassOf(base[i] ?? 0);
      const c = majorClassOf(alt[i] ?? 0);
      if (b === c) continue;
      const okB = b === om; const okC = c === om;
      let lon = lonDegOfCol(grid, col); if (lon > 180) lon -= 360;
      const key = `${MAJOR_NAME[om]}: ${MAJOR_NAME[b]}→${MAJOR_NAME[c]}`;
      if (okB && !okC) { const e = worse.get(key) ?? { w: 0, lats: [], lons: [] }; e.w += cw; e.lats.push(lat); e.lons.push(lon); worse.set(key, e); wW += cw; }
      else if (!okB && okC) { const e = better.get(key) ?? { w: 0, lats: [], lons: [] }; e.w += cw; e.lats.push(lat); e.lons.push(lon); better.set(key, e); wB += cw; }
    }
  }
  const med = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
  console.log(`改善 ${wB.toFixed(1)} / 悪化 ${wW.toFixed(1)}(v26 → v27、正解基準)`);
  console.log('');
  console.log('改善(不正解→正解)');
  for (const [k, e] of [...better.entries()].sort((a, b2) => b2[1].w - a[1].w).slice(0, 8))
    console.log(`  ${k.padEnd(12)} 重み ${e.w.toFixed(1).padStart(6)}  中央 (${med(e.lats).toFixed(0)}°, ${med(e.lons).toFixed(0)}°)  n=${e.lats.length}`);
  console.log('');
  console.log('悪化(正解→不正解)');
  for (const [k, e] of [...worse.entries()].sort((a, b2) => b2[1].w - a[1].w).slice(0, 8))
    console.log(`  ${k.padEnd(12)} 重み ${e.w.toFixed(1).padStart(6)}  中央 (${med(e.lats).toFixed(0)}°, ${med(e.lons).toFixed(0)}°)  n=${e.lats.length}`);
  // 「中緯度湿潤東岸」帯の検証: 観測 C の緯度帯別の正答率を両方で
  console.log('');
  console.log('観測 C(温帯湿潤)の帯別正答率  v26 → v27');
  const bands: Array<[string, number, number]> = [['亜熱帯東岸帯 25-40', 25, 40], ['中緯度 40-55', 40, 55], ['低緯度 0-25', 0, 25]];
  for (const [name, lo, hi] of bands) {
    let ok0 = 0; let ok1 = 0; let tot = 0;
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = latDegOfRow(grid, row); const aL = Math.abs(lat);
      if (aL < lo || aL >= hi) continue;
      const cw = Math.cos((lat * Math.PI) / 180);
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        if (!land[i]) continue;
        const obsId = kobs.classRaster[i] ?? 0;
        if (obsId === 0 || majorClassOf(obsId) !== 2) continue;
        tot += cw;
        if (majorClassOf(base[i] ?? 0) === 2) ok0 += cw;
        if (majorClassOf(alt[i] ?? 0) === 2) ok1 += cw;
      }
    }
    console.log(`  ${name.padEnd(16)} ${(100 * ok0 / tot).toFixed(1)}% → ${(100 * ok1 / tot).toFixed(1)}%`);
  }
}
void main();
