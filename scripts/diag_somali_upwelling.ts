// 診断: ソマリ型湧昇(事前登録 v31 件 1)の発火分布の確認。
// docs/事前登録_v31物理バッチ_2026-08-21.md 件 1 /
// docs/診断_縁海の偽寒流_2026-08-21.md(追記: ソマリ偽暖流の定量)
//
// out/diag_marginal_sea_cold.ts の箱の流儀で、somaliUpwellingC = 0(既定)と
// 比較値(既定 2.5。DIAG_SOMALI_C で変更可)の SST 偏差を並べて出す。
// 判定: ソマリア沖・アラビア南岸の平均が負へ動き、
//       ベンガル湾北岸・ギニア湾は ±0.05°C 以内で動かないこと。
// 実行: npx tsx scripts/diag_somali_upwelling.ts
//       DIAG_OVERRIDE="warmGateWidthCheck=1" npx tsx scripts/diag_somali_upwelling.ts

import fs from 'node:fs';
import path from 'node:path';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { buildSimContext } from '../src/sim/context';
import { computeItcz } from '../src/sim/step01_itcz';
import { computeWindBelt } from '../src/sim/step02_windbelt';
import { computeOceanCurrent } from '../src/sim/step03_ocean';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { latDegOfRow, lonDegOfCol } from '../src/domain/grid';

const best = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'out', 'best_v29_interim.json'), 'utf8'),
) as Record<string, number>;
const K = MODEL_CONSTANTS as unknown as Record<string, number>;
for (const [k, v] of Object.entries(best)) if (k in K) K[k] = v;
// DIAG_OVERRIDE 対応(例: DIAG_OVERRIDE="warmGateWidthCheck=1,boundaryCurrentOpennessGate=1")
if (process.env['DIAG_OVERRIDE']) {
  for (const part of process.env['DIAG_OVERRIDE'].split(',')) {
    const [name, raw] = part.split('=');
    if (name && name.trim() in K) K[name.trim()] = Number(raw);
  }
}
const somaliC = Number(process.env['DIAG_SOMALI_C'] ?? 2.5);

const ctx = buildSimContext({ ...EARTH_PARAMS, gridResolutionDeg: 1 });
const itcz = computeItcz(ctx);
const wind = computeWindBelt(ctx, itcz);
const { grid, terrain } = ctx;
const W = grid.widthCells;
const H = grid.heightCells;
const land = terrain.landMask;

// 実物: ソマリア沖・アラビア南岸は夏の湧昇で冷たい(負へ動くべき)。
// ベンガル湾北岸(モンスーン主供給源)・ギニア湾は保護対象(動かないべき)。
const BOXES = [
  { name: 'ソマリア沖', latMin: 0, latMax: 12, lonMin: 44, lonMax: 55, expect: '負へ' },
  { name: 'アラビア南岸', latMin: 10, latMax: 18, lonMin: 45, lonMax: 60, expect: '負へ' },
  { name: 'ベンガル湾北岸', latMin: 16, latMax: 22, lonMin: 80, lonMax: 95, expect: '±0.05 以内' },
  { name: 'ギニア湾', latMin: -4, latMax: 6, lonMin: -10, lonMax: 8, expect: '±0.05 以内' },
];

const runOcean = (c: number): Float32Array => {
  const keep = K['somaliUpwellingC'] ?? 0;
  K['somaliUpwellingC'] = c;
  const ocean = computeOceanCurrent(ctx, itcz, wind);
  K['somaliUpwellingC'] = keep;
  return ocean.sstAnomalyC;
};

const sst0 = runOcean(0);
const sst1 = runOcean(somaliC);

console.log(
  `ソマリ型湧昇の比較: somaliUpwellingC = 0 対 ${somaliC}` +
    `(warmGateWidthCheck = ${K['warmGateWidthCheck'] ?? 0}、` +
    `boundaryCurrentOpennessGate = ${K['boundaryCurrentOpennessGate'] ?? 0})`,
);
for (const b of BOXES) {
  let n = 0;
  let sum0 = 0;
  let sum1 = 0;
  let min1 = 0;
  let maxAbsDelta = 0;
  for (let row = 0; row < H; row++) {
    const lat = latDegOfRow(grid, row);
    if (lat < b.latMin || lat > b.latMax) continue;
    for (let col = 0; col < W; col++) {
      const lon = lonDegOfCol(grid, col);
      if (lon < b.lonMin || lon > b.lonMax) continue;
      const i = row * W + col;
      if (land[i]) continue;
      n++;
      const a0 = sst0[i] ?? 0;
      const a1 = sst1[i] ?? 0;
      sum0 += a0;
      sum1 += a1;
      min1 = Math.min(min1, a1);
      maxAbsDelta = Math.max(maxAbsDelta, Math.abs(a1 - a0));
    }
  }
  const m0 = sum0 / Math.max(1, n);
  const m1 = sum1 / Math.max(1, n);
  console.log(
    `${b.name}(期待: ${b.expect}): 海セル ${n}、` +
      `平均 ${m0.toFixed(2)} → ${m1.toFixed(2)}°C(差 ${(m1 - m0).toFixed(3)})、` +
      `新の最低 ${min1.toFixed(2)}°C、セル単位の最大変化 ${maxAbsDelta.toFixed(3)}`,
  );
}

// 副作用の全球監視: 箱の外でどこがどれだけ動いたか(±0.05°C 超のセル)
let changed = 0;
let strongest = 0;
let strongestLat = 0;
let strongestLon = 0;
for (let row = 0; row < H; row++) {
  for (let col = 0; col < W; col++) {
    const i = row * W + col;
    if (land[i]) continue;
    const d = (sst1[i] ?? 0) - (sst0[i] ?? 0);
    if (Math.abs(d) > 0.05) changed++;
    if (Math.abs(d) > Math.abs(strongest)) {
      strongest = d;
      strongestLat = latDegOfRow(grid, row);
      strongestLon = lonDegOfCol(grid, col);
    }
  }
}
console.log(
  `全球: ±0.05°C 超で動いた海セル ${changed}、` +
    `最大変化 ${strongest.toFixed(2)}°C @(lat ${strongestLat.toFixed(1)}, lon ${strongestLon.toFixed(1)})`,
);
