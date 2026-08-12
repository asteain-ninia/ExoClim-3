// 診断: 1° 平均で山はどれだけ低く出ているか。
//
// 利用者の指摘(2026-08-12): 「たっかい山でも周囲が低ければ、解像度のせいで
// 低く出ている可能性がある」。地形性の持ち上げは**平均標高の勾配**で
// 計算されているので、平均に溶けた山は風上で水を絞れない。
//
// セル内 p95(earth_crest_1deg.json、2026-08-02 に生 ETOPO から作成済み)と
// 平均標高の差を、山地の地域ごとに出す。GPU 不使用・パイプライン不使用。
//
// 実行: npx tsx scripts/diag_crest_vs_mean.ts

import { createGrid, latDegOfRow, lonDegOfCol } from '../src/domain/grid';
import { resolveTerrain } from '../src/domain/terrain';
import { EARTH_PARAMS } from '../src/domain/planetParams';

/** 見る箱(緯度南北・経度西東)。**判定には使わない — 見るためだけ** */
const BOXES: Array<[string, number, number, number, number]> = [
  ['アンデス（パタゴニア）', -50, -38, -75, -68],
  ['アンデス（熱帯）', -20, -5, -78, -65],
  ['ヒマラヤ・チベット', 27, 38, 75, 95],
  ['ロッキー', 35, 50, -125, -105],
  ['アルプス', 44, 48, 5, 15],
  ['スカンジナビア', 60, 70, 5, 20],
  ['東アジア（華中）', 25, 35, 105, 122],
  ['アマゾン低地（対照）', -10, 0, -70, -55],
];

const grid = createGrid(1);
const terrain = resolveTerrain(grid, EARTH_PARAMS.terrain);
const W = grid.widthCells;

console.log('1° セルの 平均標高 と セル内 p95 標高（m）。陸セルのみ\n');
console.log('地域                     平均    p95    差    比   最大差のセル');
for (const [name, latMin, latMax, lonMin, lonMax] of BOXES) {
  let sm = 0;
  let sc = 0;
  let n = 0;
  let worst = 0;
  let worstAt = '';
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    if (lat < latMin || lat > latMax) continue;
    for (let col = 0; col < W; col++) {
      const lon = lonDegOfCol(grid, col);
      const inLon = lonMin <= lonMax ? lon >= lonMin && lon <= lonMax : lon >= lonMin || lon <= lonMax;
      if (!inLon) continue;
      const i = row * W + col;
      if (!terrain.landMask[i]) continue;
      const m = Math.max(0, terrain.elevationMeters[i] ?? 0);
      const c = Math.max(m, terrain.crestElevationMeters[i] ?? 0);
      sm += m;
      sc += c;
      n++;
      if (c - m > worst) {
        worst = c - m;
        worstAt = `${lat.toFixed(0)}°,${lon.toFixed(0)}°`;
      }
    }
  }
  if (n === 0) continue;
  const mm = sm / n;
  const cc = sc / n;
  console.log(
    `${name.padEnd(22)} ${mm.toFixed(0).padStart(6)} ${cc.toFixed(0).padStart(6)} ` +
      `${(cc - mm).toFixed(0).padStart(6)} ${(cc / Math.max(1, mm)).toFixed(2).padStart(5)}   ` +
      `+${worst.toFixed(0)}m (${worstAt})`,
  );
}
console.log(
  '\n読み: 比が 1 に近ければ 1° でも山は消えていない。' +
    '大きければ、平均標高で作った勾配は実際の峰より緩い。',
);
