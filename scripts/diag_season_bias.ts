// 季節量ごとの観測差分を、地域を決め打ちせずに出す。
//
// 発端(利用者の地図比較 2026-08-01):
//   「大陸内部は夏が暑すぎ、沿岸・島嶼は寒すぎる」「熱帯の乾季が弱すぎる」
//   といった所見が、単一の全球バイアスでは説明できない形で並んでいた。
//   年平均だけを見ていると、暖側の過大と寒側の過小が打ち消して見えなくなる
//   (教訓 §9: 平均は壊れ方の向きを隠す)。
//
// そこで**季節の端**を別々に測る:
//   最暖月気温 / 最寒月気温 / 年平均気温 / 年較差
//   最少月降水 / 最多月降水 / 年降水
// を観測と差分し、
//   (a) 全球の分布(平均・分位)
//   (b) 内陸度別(海岸からの距離)—「海洋性 vs 大陸性の振幅」の検証
//   (c) 標高別 — 高原の気温補正の検証
//   (d) 緯度帯別
// に切って報告する。地域名の決め打ちはしない(教訓 §1 地理中立)。
//
// 実行: npx tsx scripts/diag_season_bias.ts

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { openAccel } from './accel_cli';
import { areaWeightOfRow, latDegOfRow } from '../src/domain/grid';

interface ClimJson {
  widthCells: number;
  heightCells: number;
  monthlyTemperatureDeciC: number[][];
  monthlyPrecipitationMm: number[][];
}

const clim = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/earth_climate_2deg.json'), 'utf8'),
) as ClimJson;

const accel = await openAccel();
const r = await runPipeline(EARTH_PARAMS, accel.opts);
accel.close();

const grid = r.context.grid;
const W = grid.widthCells;
const H = grid.heightCells;
const land = r.context.terrain.landMask;
const elev = r.context.terrain.elevationMeters;
const coastKm = r.context.landDistToCoastKm;
const OW = clim.widthCells;
const OH = clim.heightCells;
const scale = Math.round(W / OW); // 1° モデル / 2° 観測 → 2 セルで 1 観測セル

/** モデル 1° セル i に対応する観測 2° セルの添字 */
const obsIndexOf = (row: number, col: number): number => {
  const orow = Math.min(OH - 1, Math.floor(row / scale));
  const ocol = Math.min(OW - 1, Math.floor(col / scale));
  return orow * OW + ocol;
};

interface Cell {
  i: number;
  lat: number;
  weight: number;
  elevM: number;
  coastKm: number;
  /** モデル - 観測 */
  dTHot: number;
  dTCold: number;
  dTMean: number;
  dTRange: number;
  dPDry: number;
  dPWet: number;
  dPAnnual: number;
  obsTHot: number;
  obsTCold: number;
}

const cells: Cell[] = [];
for (let row = 0; row < H; row++) {
  const lat = latDegOfRow(grid, row);
  const w = areaWeightOfRow(grid, row);
  for (let col = 0; col < W; col++) {
    const i = row * W + col;
    if (!land[i]) continue;
    const oi = obsIndexOf(row, col);
    let obsTHot = -1e9;
    let obsTCold = 1e9;
    let obsTSum = 0;
    let obsPDry = 1e9;
    let obsPWet = -1e9;
    let obsPSum = 0;
    let bad = false;
    for (let m = 0; m < 12; m++) {
      const tv = clim.monthlyTemperatureDeciC[m]?.[oi] ?? -9999;
      const pv = clim.monthlyPrecipitationMm[m]?.[oi] ?? -9999;
      if (tv <= -9000 || pv <= -9000) {
        bad = true;
        break;
      }
      const t = tv / 10;
      const p = Math.max(0, pv);
      if (t > obsTHot) obsTHot = t;
      if (t < obsTCold) obsTCold = t;
      obsTSum += t;
      if (p < obsPDry) obsPDry = p;
      if (p > obsPWet) obsPWet = p;
      obsPSum += p;
    }
    if (bad) continue;
    let modTHot = -1e9;
    let modTCold = 1e9;
    let modTSum = 0;
    let modPDry = 1e9;
    let modPWet = -1e9;
    let modPSum = 0;
    for (let m = 0; m < 12; m++) {
      const t = r.temperature.monthlyTemperatureC[m]?.[i] ?? 0;
      const p = Math.max(0, r.precipitation.monthlyPrecipMm[m]?.[i] ?? 0);
      if (t > modTHot) modTHot = t;
      if (t < modTCold) modTCold = t;
      modTSum += t;
      if (p < modPDry) modPDry = p;
      if (p > modPWet) modPWet = p;
      modPSum += p;
    }
    cells.push({
      i,
      lat,
      weight: w,
      elevM: Math.max(0, elev[i] ?? 0),
      coastKm: coastKm[i] ?? 0,
      dTHot: modTHot - obsTHot,
      dTCold: modTCold - obsTCold,
      dTMean: modTSum / 12 - obsTSum / 12,
      dTRange: modTHot - modTCold - (obsTHot - obsTCold),
      dPDry: modPDry - obsPDry,
      dPWet: modPWet - obsPWet,
      dPAnnual: modPSum - obsPSum,
      obsTHot,
      obsTCold,
    });
  }
}

const wMean = (sel: (c: Cell) => number, subset = cells): number => {
  let s = 0;
  let w = 0;
  for (const c of subset) {
    s += c.weight * sel(c);
    w += c.weight;
  }
  return w > 0 ? s / w : 0;
};
const quantile = (sel: (c: Cell) => number, q: number, subset = cells): number => {
  const v = subset.map(sel).sort((a, b) => a - b);
  if (v.length === 0) return 0;
  return v[Math.min(v.length - 1, Math.floor(q * v.length))] ?? 0;
};

const METRICS: { label: string; sel: (c: Cell) => number; unit: string }[] = [
  { label: '最暖月気温', sel: (c) => c.dTHot, unit: '°C' },
  { label: '最寒月気温', sel: (c) => c.dTCold, unit: '°C' },
  { label: '年平均気温', sel: (c) => c.dTMean, unit: '°C' },
  { label: '年較差(暖−寒)', sel: (c) => c.dTRange, unit: '°C' },
  { label: '最少月降水', sel: (c) => c.dPDry, unit: 'mm' },
  { label: '最多月降水', sel: (c) => c.dPWet, unit: 'mm' },
  { label: '年降水', sel: (c) => c.dPAnnual, unit: 'mm' },
];

console.log(`陸セル ${cells.length.toLocaleString()}(モデル − 観測)\n`);
console.log('=== 全球 ===');
console.log('指標              面積平均      p10      p25      中央     p75      p90');
for (const m of METRICS) {
  console.log(
    `${m.label.padEnd(16, '　')}${wMean(m.sel).toFixed(1).padStart(8)}` +
      `${quantile(m.sel, 0.1).toFixed(1).padStart(9)}${quantile(m.sel, 0.25).toFixed(1).padStart(9)}` +
      `${quantile(m.sel, 0.5).toFixed(1).padStart(9)}${quantile(m.sel, 0.75).toFixed(1).padStart(9)}` +
      `${quantile(m.sel, 0.9).toFixed(1).padStart(9)}  ${m.unit}`,
  );
}

const buckets = (
  title: string,
  edges: number[],
  key: (c: Cell) => number,
  fmt: (lo: number, hi: number) => string,
): void => {
  console.log(`\n=== ${title} ===`);
  console.log(
    '区分               n    ' + METRICS.map((m) => m.label.slice(0, 5).padStart(8)).join(''),
  );
  for (let b = 0; b < edges.length - 1; b++) {
    const lo = edges[b]!;
    const hi = edges[b + 1]!;
    const sub = cells.filter((c) => key(c) >= lo && key(c) < hi);
    if (sub.length < 30) continue;
    console.log(
      fmt(lo, hi).padEnd(16, '　') +
        String(sub.length).padStart(6) +
        '  ' +
        METRICS.map((m) => wMean(m.sel, sub).toFixed(1).padStart(8)).join(''),
    );
  }
};

buckets(
  '内陸度(海岸からの距離)— 海洋性 vs 大陸性の振幅',
  [0, 100, 300, 600, 1000, 1500, 2500, 1e9],
  (c) => c.coastKm,
  (lo, hi) => (hi > 1e8 ? `${lo}km 以上` : `${lo}〜${hi}km`),
);
buckets(
  '標高 — 高原の気温補正',
  [0, 200, 500, 1000, 2000, 3000, 1e9],
  (c) => c.elevM,
  (lo, hi) => (hi > 1e8 ? `${lo}m 以上` : `${lo}〜${hi}m`),
);
buckets(
  '緯度帯',
  [-90, -60, -40, -23.5, 0, 23.5, 40, 60, 90],
  (c) => c.lat,
  (lo, hi) => `${lo}〜${hi}°`,
);

// ---- 差分 PNG(青 = モデルが低い、赤 = 高い)----
const OUT = path.join(process.cwd(), 'out', 'diag');
fs.mkdirSync(OUT, { recursive: true });
const byIndex = new Map(cells.map((c) => [c.i, c]));
const writeDiff = (name: string, sel: (c: Cell) => number, scaleV: number): void => {
  const png = new PNG({ width: W, height: H });
  for (let i = 0; i < W * H; i++) {
    const c = byIndex.get(i);
    let R = 24;
    let G = 28;
    let B = 36;
    if (c) {
      const x = Math.max(-1, Math.min(1, sel(c) / scaleV));
      if (x >= 0) {
        R = 255;
        G = Math.round(255 * (1 - x));
        B = Math.round(255 * (1 - x));
      } else {
        R = Math.round(255 * (1 + x));
        G = Math.round(255 * (1 + x));
        B = 255;
      }
    }
    png.data[i * 4] = R;
    png.data[i * 4 + 1] = G;
    png.data[i * 4 + 2] = B;
    png.data[i * 4 + 3] = 255;
  }
  fs.writeFileSync(path.join(OUT, name), PNG.sync.write(png));
};
writeDiff('d_thot.png', (c) => c.dTHot, 10);
writeDiff('d_tcold.png', (c) => c.dTCold, 10);
writeDiff('d_trange.png', (c) => c.dTRange, 10);
writeDiff('d_pdry.png', (c) => c.dPDry, 50);
writeDiff('d_pwet.png', (c) => c.dPWet, 150);
console.log(`\n差分 PNG(赤 = モデルが高い / 青 = 低い): ${OUT}`);
