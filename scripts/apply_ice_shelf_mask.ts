// 南極の棚氷(浮いている氷)を陸マスクから外す。
//
// 問題(利用者の指摘 2026-08-02):
//   地形の出所は ETOPO 2022 の **surface(氷の上面)標高**で、陸判定が
//   「標高 > 0」。ロス棚氷(上面 41m)・ロンネ棚氷(63m)などの浮氷は
//   海の上に浮いているのに陸と判定される。実測で南緯 60° 以南の陸が
//   モデル 6,670 セルに対し Beck は 6,040、余分 630 セルの 95% が標高 200m 未満。
//   逆向きのずれ(Beck にあってモデルに無い)は 0 セル。
//
// 本来の判定は静水圧(浮いている ⇔ bedrock < −11.05 × surface)だが、
// ETOPO の bedrock は手元に無い。代わりに **Natural Earth 1:50m の
// 南極棚氷ポリゴン**を使う。観測気候データとは独立な地理データなので、
// 「地形が採点対象に依存する」問題は起きない。
//
// 標本化は ETOPO 由来の陸マスクと同じ**セル中心**で行う(方式を揃える)。
//
// 実行:
//   npx tsx scripts/apply_ice_shelf_mask.ts          (確認のみ)
//   npx tsx scripts/apply_ice_shelf_mask.ts --write  (フィクスチャを書き換える)

import fs from 'node:fs';
import path from 'node:path';

const GEOJSON = path.join(
  process.cwd(),
  '..',
  'derle-climate',
  'data',
  'raw',
  'ne_50m_antarctic_ice_shelves_polys.geojson',
);
const TERRAIN = path.join(process.cwd(), 'src/domain/data/earth_terrain_1deg.json');
const CREST = path.join(process.cwd(), 'src/domain/data/earth_crest_1deg.json');
const WRITE = process.argv.includes('--write');

/** 棚氷の下の水柱の目安(m)。モデルは海の水深を使わないので表示上の値 */
const SUB_SHELF_DEPTH_M = -300;

interface Terrain {
  description: string;
  widthCells: number;
  heightCells: number;
  elevationMeters: number[];
  landMask: number[];
  iceShelfRemoved?: { cells: number; source: string; appliedAt: string };
}
interface Crest {
  description?: string;
  widthCells: number;
  heightCells: number;
  crestMeters: number[];
}
type Ring = [number, number][];
interface Feature {
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] };
}

const terrain = JSON.parse(fs.readFileSync(TERRAIN, 'utf8')) as Terrain;
const crest = JSON.parse(fs.readFileSync(CREST, 'utf8')) as Crest;
const gj = JSON.parse(fs.readFileSync(GEOJSON, 'utf8')) as { features: Feature[] };

if (terrain.iceShelfRemoved) {
  console.log(
    `既に適用済み(${terrain.iceShelfRemoved.cells} セル、${terrain.iceShelfRemoved.appliedAt})。何もしない`,
  );
  process.exit(0);
}

// ---- ポリゴン(穴つき)を集める ----
const polygons: Ring[][] = [];
for (const f of gj.features) {
  if (f.geometry.type === 'Polygon') {
    polygons.push((f.geometry.coordinates as number[][][]).map((r) => r as Ring));
  } else {
    for (const poly of f.geometry.coordinates as number[][][][]) {
      polygons.push(poly.map((r) => r as Ring));
    }
  }
}
console.log(`棚氷ポリゴン ${polygons.length} 個(Natural Earth 1:50m)`);

/** 外環に入り、かつどの穴にも入っていないか */
function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inPolygonWithHoles(lon: number, lat: number, rings: Ring[]): boolean {
  if (rings.length === 0 || !inRing(lon, lat, rings[0]!)) return false;
  for (let k = 1; k < rings.length; k++) if (inRing(lon, lat, rings[k]!)) return false;
  return true;
}

// 事前に緯度範囲で絞る(全ポリゴンを毎セル試すのは無駄)
const bounds = polygons.map((rings) => {
  let minLat = 90;
  let maxLat = -90;
  for (const [, la] of rings[0]!) {
    if (la < minLat) minLat = la;
    if (la > maxLat) maxLat = la;
  }
  return { minLat, maxLat, rings };
});

const W = terrain.widthCells;
const H = terrain.heightCells;
const res = 360 / W;
let flipped = 0;
const flippedRows = new Map<number, number>();
for (let row = 0; row < H; row++) {
  const lat = 90 - (row + 0.5) * res;
  if (lat > -55) continue; // 棚氷は南極のみ
  const cands = bounds.filter((b) => lat >= b.minLat - res && lat <= b.maxLat + res);
  if (cands.length === 0) continue;
  for (let col = 0; col < W; col++) {
    const i = row * W + col;
    if (terrain.landMask[i] !== 1) continue;
    const lon = -180 + (col + 0.5) * res;
    let hit = false;
    for (const b of cands) {
      if (inPolygonWithHoles(lon, lat, b.rings)) {
        hit = true;
        break;
      }
    }
    if (!hit) continue;
    terrain.landMask[i] = 0;
    terrain.elevationMeters[i] = SUB_SHELF_DEPTH_M;
    crest.crestMeters[i] = 0;
    flipped++;
    flippedRows.set(row, (flippedRows.get(row) ?? 0) + 1);
  }
}

// ---- 報告 ----
let wLand = 0;
let wAll = 0;
for (let row = 0; row < H; row++) {
  const lat = 90 - (row + 0.5) * res;
  const w = Math.cos((lat * Math.PI) / 180);
  for (let col = 0; col < W; col++) {
    wAll += w;
    if (terrain.landMask[row * W + col] === 1) wLand += w;
  }
}
console.log(`棚氷として海へ落としたセル: ${flipped}`);
console.log(`修正後の面積重み陸率: ${((wLand / wAll) * 100).toFixed(2)}%(実地球 約 29.2%)`);
const rows = [...flippedRows.entries()].sort((a, b) => a[0] - b[0]);
console.log(
  '緯度別: ' + rows.map(([r, n]) => `${(90 - (r + 0.5) * res).toFixed(1)}°:${n}`).join(' ') ||
    '(なし)',
);

if (!WRITE) {
  console.log('\n--write を付けるとフィクスチャを書き換える(今は確認のみ)');
  process.exit(0);
}
terrain.description +=
  ' 南極の棚氷は Natural Earth 1:50m の棚氷ポリゴンで海へ戻した(ETOPO surface は氷上面なので浮氷が陸に入る)。';
terrain.iceShelfRemoved = {
  cells: flipped,
  source: 'Natural Earth 1:50m ne_50m_antarctic_ice_shelves_polys',
  appliedAt: new Date().toISOString(),
};
fs.writeFileSync(TERRAIN, JSON.stringify(terrain));
fs.writeFileSync(CREST, JSON.stringify(crest));
console.log('書き換えた:', TERRAIN, CREST);
