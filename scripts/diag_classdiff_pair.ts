// 診断: **2 つの定数集合の間で、大分類がどの型・どこで入れ替わるか。**
// 使い方: npx tsx scripts/diag_classdiff_pair.ts <基準.json> <比較.json>
// 例: v30(採用中)対 v32(v7b 較正)で「どの地域の地図を売ったか」を分解する。
import * as fs from 'node:fs';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { latDegOfRow, lonDegOfCol } from '../src/domain/grid';
import { majorClassOf } from '../src/domain/koppen';
import { getKoppenObs } from './scoring';
import { openAccel } from './accel_cli';

const K = MODEL_CONSTANTS as unknown as Record<string, number>;
const MAJOR_NAME = ['A', 'B', 'C', 'D', 'E'];
const apply = (p: string): void => {
  const j = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, number>;
  for (const [k, v] of Object.entries(j)) if (k in K) K[k] = v;
};

async function main(): Promise<void> {
  const [basePath, altPath] = [process.argv[2], process.argv[3]];
  if (!basePath || !altPath) throw new Error('使い方: diag_classdiff_pair.ts <基準.json> <比較.json>');
  const accel = await openAccel(true);
  let base, alt, grid, land;
  try {
    apply(basePath);
    const r0 = await runPipeline(EARTH_PARAMS, accel.opts);
    base = r0.koppen.classId; grid = r0.context.grid; land = r0.context.terrain.landMask;
    apply(altPath);
    const r1 = await runPipeline(EARTH_PARAMS, accel.opts);
    alt = r1.koppen.classId;
  } finally { accel.close(); }
  const kobs = getKoppenObs();
  const W = grid.widthCells;
  const worse = new Map<string, { w: number; lats: number[]; lons: number[] }>();
  const better = new Map<string, number>();
  let wW = 0, wB = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    const cw = Math.cos((lat * Math.PI) / 180);
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      if (!land[i]) continue;
      const obsId = kobs.classRaster[i] ?? 0;
      if (obsId === 0) continue;
      const om = majorClassOf(obsId), b = majorClassOf(base[i] ?? 0), c = majorClassOf(alt[i] ?? 0);
      if (b === c) continue;
      const key = `${MAJOR_NAME[om]}: ${MAJOR_NAME[b]}→${MAJOR_NAME[c]}`;
      if (b === om && c !== om) {
        const e = worse.get(key) ?? { w: 0, lats: [], lons: [] };
        let lon = lonDegOfCol(grid, col); if (lon > 180) lon -= 360;
        e.w += cw; e.lats.push(lat); e.lons.push(lon); worse.set(key, e); wW += cw;
      } else if (b !== om && c === om) { better.set(key, (better.get(key) ?? 0) + cw); wB += cw; }
    }
  }
  const med = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
  console.log('');
  console.log(`改善 ${wB.toFixed(1)} / 悪化 ${wW.toFixed(1)}(${basePath} → ${altPath})`);
  console.log('');
  console.log('悪化(正解→不正解)');
  for (const [k, e] of [...worse.entries()].sort((a, b2) => b2[1].w - a[1].w).slice(0, 8))
    console.log(`  ${k.padEnd(12)} 重み ${e.w.toFixed(1).padStart(6)}  中央 (${med(e.lats).toFixed(0)}°, ${med(e.lons).toFixed(0)}°)  n=${e.lats.length}`);
  console.log('');
  console.log('改善(不正解→正解)');
  for (const [k, w] of [...better.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 8))
    console.log(`  ${k.padEnd(12)} 重み ${w.toFixed(1)}`);
}
void main();
