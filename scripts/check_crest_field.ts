// 検査: 峰の標高場(セル内 p95)は健全か。
//
// 段 13 は「地形性上昇の勾配を峰寄りにする」実験なので、峰の場が壊れて
// いたら実験そのものが無意味になる。**測る前に入力を検査する。**
//
// 見るもの:
//   1. 峰 < 平均 のセルが無いか(定義上ありえない)
//   2. 海のセルに峰が立っていないか(海底地形が混ざると偽の山ができる)
//   3. 海岸のセルで峰が異常に高くないか(隣の陸の峰が漏れていないか)
//   4. 峰 − 平均 の分布(桁の確認)
//
// 実行: npx tsx scripts/check_crest_field.ts

import { createGrid, latDegOfRow } from '../src/domain/grid';
import { resolveTerrain } from '../src/domain/terrain';
import { EARTH_PARAMS } from '../src/domain/planetParams';

const grid = createGrid(1);
const t = resolveTerrain(grid, EARTH_PARAMS.terrain);
const W = grid.widthCells;
const H = grid.heightCells;

let below = 0;
let oceanCrest = 0;
let oceanCrestMax = 0;
let landN = 0;
const diffs: number[] = [];
let maxDiff = 0;
let maxDiffAt = '';

for (let row = 0; row < H; row++) {
  for (let col = 0; col < W; col++) {
    const i = row * W + col;
    const m = t.elevationMeters[i] ?? 0;
    const c = t.crestElevationMeters[i] ?? 0;
    if (t.landMask[i]) {
      landN++;
      if (c < m - 1) below++;
      const d = Math.max(0, c - m);
      diffs.push(d);
      if (d > maxDiff) {
        maxDiff = d;
        maxDiffAt = `${latDegOfRow(grid, row).toFixed(0)}°`;
      }
    } else {
      if (c > 50) {
        oceanCrest++;
        if (c > oceanCrestMax) oceanCrestMax = c;
      }
    }
  }
}

diffs.sort((a, b) => a - b);
const q = (p: number): number => diffs[Math.floor(p * (diffs.length - 1))] ?? 0;

console.log('峰の標高場(セル内 p95)の検査\n');
console.log(`陸セル ${landN}`);
console.log(`1. 峰 < 平均 のセル: ${below}  ${below === 0 ? '✅' : '❌ 定義上ありえない'}`);
console.log(
  `2. 海セルで峰 > 50m: ${oceanCrest}（最大 ${oceanCrestMax.toFixed(0)}m）` +
    `  ${oceanCrest === 0 ? '✅' : '⚠ 海底地形か島の混入を疑う'}`,
);
console.log('\n3. 峰 − 平均 の分布(陸、m)');
for (const p of [0.5, 0.75, 0.9, 0.95, 0.99, 1.0]) {
  console.log(`   ${(p * 100).toFixed(0).padStart(3)} 分位  ${q(p).toFixed(0).padStart(6)}`);
}
console.log(`   最大 ${maxDiff.toFixed(0)}m（緯度 ${maxDiffAt}）`);
console.log(
  '\n読み: 中央値が数十 m なら平地では平均と峰が一致しており、' +
    '上位分位だけが山地。分布が全体に持ち上がっていたら作り方を疑う。',
);
