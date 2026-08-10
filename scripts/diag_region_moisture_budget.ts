// 診断: 地域ごとの水蒸気収支 — 「降らない」のは**運ばれてこない**からか、
// **凝結していない**からかを分ける。
//
// 対応 spec: docs/計画_保存則の段階的置換_2026-08-09.md
//
// なぜ要るか(2026-08-09):
//   保存型へ移したあと、未達の地域ゲートが揃って「降水が足りない」になった:
//     east_asia 観測の 11% / us_southeast 16% / india 39%
//   非保存の到達可能性指数では「海が近ければ供給がある」で済んでいたが、
//   保存型では**水が実際に運ばれてこないと降らない**。
//
//   だが「運ばれてこない」と「運ばれてきても凝結しない」は別の話で、
//   打つ手がまったく違う:
//     運ばれてこない → 風(段 4 の気流)の問題。降水の定数では直らない
//     凝結しない     → 凝結率 G の問題。較正の対象
//
//   **地域の水収支 P = E + 正味流入 を分解すれば、どちらかが分かる。**
//
// GPU 不使用。`dump_transport_inputs.ts` が書き出した場を読む。
// (書き出しは seed_v13evap のパラメータなので絶対値は現行と一致しないが、
//  「運ばれてくる量が観測の降水に足りるか」という構造の問いには答えられる)
//
// 実行: npx tsx scripts/diag_region_moisture_budget.ts

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createGrid, latDegOfRow, lonDegOfCol } from '../src/domain/grid';
import { solveMoistureTransport, SECONDS_PER_MONTH } from '../src/sim/moisture_transport';
import { saturationSpecificHumidity } from '../src/sim/evaporation';
import { MODEL_CONSTANTS as K } from '../src/sim/constants';
import { REGION_GATES } from './scoring';

const DIR = 'out/exp';
const MONTHS = 12;
const FIELDS = 6;

interface Meta {
  widthCells: number;
  heightCells: number;
  cellCount: number;
  resolutionDeg: number;
  radiusKm: number;
  offsets: { monthly: number; landMask: number; precipMm: number };
}

const meta = JSON.parse(
  fs.readFileSync(path.join(DIR, 'transport_inputs.json'), 'utf8'),
) as Meta;
const raw = fs.readFileSync(path.join(DIR, 'transport_inputs.bin'));
const all = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const N = meta.cellCount;
const W = meta.widthCells;
const H = meta.heightCells;
const grid = createGrid(meta.resolutionDeg);
const land = all.subarray(meta.offsets.landMask, meta.offsets.landMask + N);

// 観測降水(2° → 1° へ最近傍)
const clim = JSON.parse(
  fs.readFileSync('tests/fixtures/earth_climate_2deg.json', 'utf8'),
) as { widthCells: number; monthlyPrecipitationMm: number[][] };
const obsAnnual = new Float32Array(N);
for (let i = 0; i < N; i++) {
  const oi = Math.floor(Math.floor(i / W) / 2) * clim.widthCells + Math.floor((i % W) / 2);
  let sum = 0;
  let ok = true;
  for (let m = 0; m < MONTHS; m++) {
    const v = clim.monthlyPrecipitationMm[m]?.[oi] ?? -9999;
    if (v < 0) {
      ok = false;
      break;
    }
    sum += v;
  }
  obsAnnual[i] = ok ? sum : -1;
}

// 各月を解いて、年積算の降水・源泉を貯める
const annualP = new Float32Array(N);
const annualE = new Float32Array(N);
let unconverged = 0;
const travelKmPerMonth = (K.condensationRefWindMs * SECONDS_PER_MONTH) / 1000;
for (let m = 0; m < MONTHS; m++) {
  const base = meta.offsets.monthly + m * FIELDS * N;
  const u = all.subarray(base, base + N);
  const v = all.subarray(base + N, base + 2 * N);
  const t = all.subarray(base + 2 * N, base + 3 * N);
  const et = all.subarray(base + 3 * N, base + 4 * N);
  const g = all.subarray(base + 4 * N, base + 5 * N);
  const src = new Float32Array(N);
  const rate = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (land[i]) {
      src[i] = et[i] ?? 0;
    } else {
      const spd = Math.max(K.evapMinWindMs, Math.hypot(u[i] ?? 0, v[i] ?? 0));
      const qs = saturationSpecificHumidity(t[i] ?? 0, 1013.25);
      src[i] = Math.max(
        0,
        1.2 * K.evapBulkCoef * spd * qs * (1 - K.evapOceanRelHumidity) * SECONDS_PER_MONTH,
      );
    }
    const lKm = land[i] ? K.moistureDecayLandKm : K.moistureDecayOceanKm;
    rate[i] = Math.max(0.05, (travelKmPerMonth / lKm) * Math.max(0.02, g[i] ?? 1));
  }
  const r = solveMoistureTransport(grid, meta.radiusKm, u, v, src, rate, {
    diffusivityM2PerS: K.moistureEddyDiffusivityM2PerS,
    maxIterations: 40000,
  });
  if (!r.converged) unconverged++;
  for (let i = 0; i < N; i++) {
    annualP[i] = (annualP[i] ?? 0) + (r.condensationMm[i] ?? 0);
    annualE[i] = (annualE[i] ?? 0) + (src[i] ?? 0);
  }
}

/** 面積重み平均(mm/年)。cells は格子番号 */
function mean(field: ArrayLike<number>, cells: number[]): number {
  let s = 0;
  let w = 0;
  for (const i of cells) {
    const cw = Math.cos((latDegOfRow(grid, Math.floor(i / W)) * Math.PI) / 180);
    s += cw * (field[i] ?? 0);
    w += cw;
  }
  return s / Math.max(1e-9, w);
}

console.log(`未収束の月 ${unconverged} 件（0 でなければ以下は読まない）\n`);
console.log(
  '地域                  観測P   モデルP    E(局所)  正味流入  流入/観測P  読み',
);
for (const gate of REGION_GATES) {
  const cells: number[] = [];
  for (let row = 0; row < H; row++) {
    const lat = latDegOfRow(grid, row);
    if (lat < gate.latMin || lat > gate.latMax) continue;
    for (let col = 0; col < W; col++) {
      const lon = lonDegOfCol(grid, col);
      const inLon =
        gate.lonMin <= gate.lonMax
          ? lon >= gate.lonMin && lon <= gate.lonMax
          : lon >= gate.lonMin || lon <= gate.lonMax;
      if (!inLon) continue;
      const i = row * W + col;
      if (land[i] && (obsAnnual[i] ?? -1) >= 0) cells.push(i);
    }
  }
  if (cells.length === 0) continue;
  const obs = mean(obsAnnual, cells);
  const p = mean(annualP, cells);
  const e = mean(annualE, cells);
  // 正味流入 = P − E（定常なので、その地域で降った水のうち局所蒸発で
  // 賄えないぶんは、外から運ばれてきたことになる）
  const imp = p - e;
  // 観測の降水を賄うのに必要な流入(局所 E は同じと仮定した下限の見積り)
  const need = obs - e;
  const ratio = need > 0 ? imp / need : NaN;
  const verdict =
    Number.isNaN(ratio)
      ? '局所 E だけで観測を賄える'
      : ratio < 0.5
        ? '**運ばれてきていない**（風の問題）'
        : ratio < 0.9
          ? 'やや不足'
          : '流入は足りている（凝結側の問題）';
  console.log(
    `${gate.id.padEnd(24)} ${obs.toFixed(0).padStart(5)} ${p.toFixed(0).padStart(8)} ` +
      `${e.toFixed(0).padStart(8)} ${imp.toFixed(0).padStart(8)} ` +
      `${Number.isNaN(ratio) ? '   —' : ratio.toFixed(2).padStart(9)}  ${verdict}`,
  );
}
console.log(
  '\n読み方: 正味流入 = モデルP − 局所E。**観測を賄うのに必要な流入に対する比**が\n' +
    '        小さければ、水がそもそも運ばれてきていない = 風(段 4)の問題であり、\n' +
    '        降水側の定数を較正しても届かない。',
);
