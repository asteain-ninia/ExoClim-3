// 「観測のみ陸」(採点から外れているセル)がどこに分布しているかを調べる。
//
// diag_obs_alignment.ts の結果: 位置合わせは正しいが、観測の陸面積は
// モデルの 1.21 倍で、観測陸の 18.0% が採点対象外になっている。
// それが沿岸に薄く広がっているだけなら害は小さいが、島嶼や特定地域に
// 集中しているなら、その地域が丸ごと評価から抜けていることになる。
//
// 実行: npx tsx scripts/diag_obs_excluded.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { getKoppenObs } from './scoring';
import { areaWeightOfRow, latDegOfRow, wrapCol } from '../src/domain/grid';
import { KOPPEN_CLASSES, majorClassOf } from '../src/domain/koppen';

const result = runPipeline(EARTH_PARAMS);
const grid = result.context.grid;
const W = grid.widthCells;
const H = grid.heightCells;
const land = result.context.terrain.landMask;
const obs = getKoppenObs().classRaster;

// モデル陸からの距離(セル)。0 = モデルも陸、1 = 陸に隣接、…
const distToModelLand = new Int32Array(W * H).fill(-1);
const queue: number[] = [];
for (let i = 0; i < W * H; i++) {
  if (land[i] === 1) {
    distToModelLand[i] = 0;
    queue.push(i);
  }
}
for (let qi = 0; qi < queue.length; qi++) {
  const i = queue[qi]!;
  const row = Math.floor(i / W);
  const col = i % W;
  const d = distToModelLand[i]!;
  if (d >= 6) continue;
  for (const [dr, dc] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    const r = row + dr;
    if (r < 0 || r >= H) continue;
    const j = r * W + wrapCol(grid, col + dc);
    if (distToModelLand[j] === -1) {
      distToModelLand[j] = d + 1;
      queue.push(j);
    }
  }
}

// 「観測のみ陸」をモデル陸からの距離別に集計
const byDist = new Map<number, number>();
let wExcluded = 0;
const byLatBand = new Map<string, number>();
const byClass = new Map<string, number>();
for (let row = 0; row < H; row++) {
  const w = areaWeightOfRow(grid, row);
  const lat = latDegOfRow(grid, row);
  const band = `${Math.floor(lat / 30) * 30}〜${Math.floor(lat / 30) * 30 + 30}°`;
  for (let col = 0; col < W; col++) {
    const i = row * W + col;
    if (land[i] === 1) continue;
    const o = obs[i] ?? 0;
    if (o === 0) continue;
    wExcluded += w;
    const d = distToModelLand[i]!;
    const key = d < 0 ? 99 : d;
    byDist.set(key, (byDist.get(key) ?? 0) + w);
    byLatBand.set(band, (byLatBand.get(band) ?? 0) + w);
    const sym = KOPPEN_CLASSES[o] ?? '?';
    byClass.set(sym, (byClass.get(sym) ?? 0) + w);
  }
}

console.log('「観測のみ陸」= 採点から外れているセルの分布');
console.log('\nモデル陸からの距離(セル)別:');
for (const d of [...byDist.keys()].sort((a, b) => a - b)) {
  const w = byDist.get(d) ?? 0;
  const label = d === 99 ? '7 セル以上離れている' : `${d} セル`;
  console.log(
    `  ${label.padEnd(22, '　')} ${((w / wExcluded) * 100).toFixed(1).padStart(6)}%`,
  );
}

console.log('\n緯度帯別:');
for (const [band, w] of [...byLatBand.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${band.padEnd(12, '　')} ${((w / wExcluded) * 100).toFixed(1).padStart(6)}%`);
}

console.log('\n観測の気候区分別(上位 8):');
for (const [sym, w] of [...byClass.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${sym.padEnd(6)} ${((w / wExcluded) * 100).toFixed(1).padStart(6)}%`);
}

// 大分類の構成を、採点対象と除外分で比べる(偏りの有無)
const majorNames = ['A 熱帯', 'B 乾燥', 'C 温帯', 'D 冷帯', 'E 寒帯'];
const scored = new Array<number>(5).fill(0);
const excluded = new Array<number>(5).fill(0);
for (let row = 0; row < H; row++) {
  const w = areaWeightOfRow(grid, row);
  for (let col = 0; col < W; col++) {
    const i = row * W + col;
    const o = obs[i] ?? 0;
    if (o === 0) continue;
    const mj = majorClassOf(o);
    if (mj < 0) continue;
    if (land[i] === 1) scored[mj] = (scored[mj] ?? 0) + w;
    else excluded[mj] = (excluded[mj] ?? 0) + w;
  }
}
const sSum = scored.reduce((a, b) => a + b, 0);
const eSum = excluded.reduce((a, b) => a + b, 0);
console.log('\n大分類の構成(観測):');
console.log('  区分      採点対象   除外分   偏り');
for (let m = 0; m < 5; m++) {
  const sp = ((scored[m] ?? 0) / sSum) * 100;
  const ep = ((excluded[m] ?? 0) / eSum) * 100;
  console.log(
    `  ${majorNames[m]!.padEnd(8, '　')} ${sp.toFixed(1).padStart(6)}% ${ep.toFixed(1).padStart(7)}% ` +
      `${(ep - sp >= 0 ? '+' : '') + (ep - sp).toFixed(1).padStart(5)}pt`,
  );
}
