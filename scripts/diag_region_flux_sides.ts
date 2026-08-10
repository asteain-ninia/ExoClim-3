// 診断: 地域の境界 4 面ごとの水蒸気の出入り — **どちらから入り、どちらへ抜けるか**。
//
// 対応 spec: docs/診断_地域の水蒸気収支_2026-08-10.md の続き
//
// 前段で分かったこと: 未達 3 ゲート(india / us_southeast / east_asia)は
// **正味流入が負**、つまりモデルが水を持ち出している。
// だが「正味」だけでは、どの向きの流れが足りないのかが分からない。
//
// ここでは境界の 4 面それぞれについて、面を通る水蒸気の正味流量を出す。
// モンスーンは**夏に南(または海側)から入る**流れなので、季節で分けて見る。
//
// 単位は面積で割って mm/年 に揃える(降水と直接比べられる)。
// 定常なら  P = E + 南 + 北 + 東 + 西  が成り立つはずで、これも表に出して
// **収支が閉じているかを表の中で確かめられる**ようにする。
//
// GPU 不使用。`dump_transport_inputs.ts` の場を読む。
// 実行: npx tsx scripts/diag_region_flux_sides.ts

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
/** 見る地域(前段で「運ばれてこない」と出たものと、対照 2 つ) */
const TARGETS = [
  'india_tropical',
  'us_southeast_humid',
  'east_asia_humid',
  'congo_tropical',
  'europe_russia_continental',
];

interface Meta {
  widthCells: number;
  heightCells: number;
  cellCount: number;
  resolutionDeg: number;
  radiusKm: number;
  offsets: { monthly: number; landMask: number; precipMm: number };
}

const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'transport_inputs.json'), 'utf8')) as Meta;
const raw = fs.readFileSync(path.join(DIR, 'transport_inputs.bin'));
const all = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const N = meta.cellCount;
const W = meta.widthCells;
const H = meta.heightCells;
const grid = createGrid(meta.resolutionDeg);
const land = all.subarray(meta.offsets.landMask, meta.offsets.landMask + N);

const aM = meta.radiusKm * 1000;
const dLam = (meta.resolutionDeg * Math.PI) / 180;
const dPhi = (meta.resolutionDeg * Math.PI) / 180;
const lenMeridionalM = aM * dPhi; // 東西面（経線方向）の辺長
const areaOf = (row: number): number =>
  aM * aM * dLam * dPhi * Math.max(1e-6, Math.cos((latDegOfRow(grid, row) * Math.PI) / 180));
/** 緯度円に沿う面（南北面）の辺長。row と row+1 の境界 */
const lenZonalM = (rowFace: number): number =>
  aM * dLam * Math.max(0, Math.cos(((90 - rowFace * meta.resolutionDeg) * Math.PI) / 180));
/** 東西のセル中心間距離 */
const dxCenterM = (row: number): number =>
  aM * dLam * Math.max(1e-6, Math.cos((latDegOfRow(grid, row) * Math.PI) / 180));
const dyCenterM = aM * dPhi;
/** 拡散係数 m²/月 */
const diffPerMonth = K.moistureEddyDiffusivityM2PerS * SECONDS_PER_MONTH;

interface MonthSolution {
  water: Float32Array;
  cond: Float32Array;
  src: Float32Array;
  u: Float32Array;
  v: Float32Array;
}

const sols: MonthSolution[] = [];
const travelKmPerMonth = (K.condensationRefWindMs * SECONDS_PER_MONTH) / 1000;
let unconverged = 0;
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
  sols.push({ water: r.waterMm, cond: r.condensationMm, src, u, v });
}

console.log(`未収束の月 ${unconverged} 件（0 でなければ以下は読まない）`);
console.log(
  '\n単位は mm/年（地域の面積で割って降水と直接比べられるようにした）。' +
    '\n正 = 地域へ入る向き。**P = E + 南 + 北 + 西 + 東** が閉じていれば表は正しい。\n',
);

for (const id of TARGETS) {
  const gate = REGION_GATES.find((g) => g.id === id);
  if (!gate) continue;
  const rows: number[] = [];
  for (let row = 0; row < H; row++) {
    const lat = latDegOfRow(grid, row);
    if (lat >= gate.latMin && lat <= gate.latMax) rows.push(row);
  }
  const cols: number[] = [];
  for (let col = 0; col < W; col++) {
    const lon = lonDegOfCol(grid, col);
    const inLon =
      gate.lonMin <= gate.lonMax
        ? lon >= gate.lonMin && lon <= gate.lonMax
        : lon >= gate.lonMin || lon <= gate.lonMax;
    if (inLon) cols.push(col);
  }
  if (rows.length === 0 || cols.length === 0) continue;
  const rowTop = Math.min(...rows);
  const rowBot = Math.max(...rows);
  const colL = Math.min(...cols);
  const colR = Math.max(...cols);
  let areaTotal = 0;
  for (const row of rows) areaTotal += areaOf(row) * cols.length;

  // 季節: 北半球なら 6〜8 月が夏。南半球は 12〜2 月
  const north = (gate.latMin + gate.latMax) / 2 >= 0;
  const summer = north ? [5, 6, 7] : [11, 0, 1];
  const winter = north ? [11, 0, 1] : [5, 6, 7];

  /** 指定の月群について、面ごとの正味流入と P・E を mm/年 で返す */
  const budget = (months: number[]): Record<string, number> => {
    let pSum = 0;
    let eSum = 0;
    let fSouth = 0;
    let fNorth = 0;
    let fWest = 0;
    let fEast = 0;
    for (const m of months) {
      const s = sols[m];
      if (!s) continue;
      for (const row of rows) {
        for (const col of cols) {
          const i = row * W + col;
          const a = areaOf(row);
          pSum += (s.cond[i] ?? 0) * a;
          eSum += (s.src[i] ?? 0) * a;
        }
      }
      // 南北面: v の風上流束。row 面 = row-1 と row の境界
      for (const col of cols) {
        // 北の面(rowTop の上側)
        const iIn = rowTop * W + col;
        const iOut = rowTop > 0 ? (rowTop - 1) * W + col : iIn;
        const vn =
          0.5 * ((s.v[iIn] ?? 0) + (s.v[iOut] ?? 0)) * SECONDS_PER_MONTH; // m/月、北向き正
        const lenN = lenZonalM(rowTop);
        // v > 0 は北向き = 地域から出る向き。風上は自セル
        fNorth += -lenN * (Math.max(0, vn) * (s.water[iIn] ?? 0) + Math.min(0, vn) * (s.water[iOut] ?? 0));
        // **拡散も面で数える。** 係数が大きいので無視すると収支が閉じない
        // (最初の版はこれを落として残差が流束と同程度になった)
        fNorth += (lenN * diffPerMonth * ((s.water[iOut] ?? 0) - (s.water[iIn] ?? 0))) / dyCenterM;
        // 南の面(rowBot の下側)
        const jIn = rowBot * W + col;
        const jOut = rowBot < H - 1 ? (rowBot + 1) * W + col : jIn;
        const vs = 0.5 * ((s.v[jIn] ?? 0) + (s.v[jOut] ?? 0)) * SECONDS_PER_MONTH;
        const lenS = lenZonalM(rowBot + 1);
        // v > 0（北向き）は南の面では**入る**向き。風上は南隣
        fSouth += lenS * (Math.max(0, vs) * (s.water[jOut] ?? 0) + Math.min(0, vs) * (s.water[jIn] ?? 0));
        fSouth += (lenS * diffPerMonth * ((s.water[jOut] ?? 0) - (s.water[jIn] ?? 0))) / dyCenterM;
      }
      // 東西面
      for (const row of rows) {
        const iIn = row * W + colL;
        const iOut = row * W + ((colL - 1 + W) % W);
        const uw = 0.5 * ((s.u[iIn] ?? 0) + (s.u[iOut] ?? 0)) * SECONDS_PER_MONTH; // 東向き正
        // u > 0（東向き）は西の面では**入る**向き。風上は西隣
        fWest += lenMeridionalM * (Math.max(0, uw) * (s.water[iOut] ?? 0) + Math.min(0, uw) * (s.water[iIn] ?? 0));
        fWest +=
          (lenMeridionalM * diffPerMonth * ((s.water[iOut] ?? 0) - (s.water[iIn] ?? 0))) /
          dxCenterM(row);
        const jIn = row * W + colR;
        const jOut = row * W + ((colR + 1) % W);
        const ue = 0.5 * ((s.u[jIn] ?? 0) + (s.u[jOut] ?? 0)) * SECONDS_PER_MONTH;
        // u > 0 は東の面では出る向き。風上は自セル
        fEast += -lenMeridionalM * (Math.max(0, ue) * (s.water[jIn] ?? 0) + Math.min(0, ue) * (s.water[jOut] ?? 0));
        fEast +=
          (lenMeridionalM * diffPerMonth * ((s.water[jOut] ?? 0) - (s.water[jIn] ?? 0))) /
          dxCenterM(row);
      }
    }
    const perArea = (x: number): number => (x / areaTotal) * (12 / months.length);
    return {
      P: perArea(pSum),
      E: perArea(eSum),
      南: perArea(fSouth),
      北: perArea(fNorth),
      西: perArea(fWest),
      東: perArea(fEast),
    };
  };

  const yr = budget([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const su = budget(summer);
  const wi = budget(winter);
  const close = (b: Record<string, number>): number =>
    (b.P ?? 0) - ((b.E ?? 0) + (b.南 ?? 0) + (b.北 ?? 0) + (b.西 ?? 0) + (b.東 ?? 0));
  const fmt = (b: Record<string, number>, label: string): string =>
    `${label.padEnd(6)} P=${(b.P ?? 0).toFixed(0).padStart(5)} E=${(b.E ?? 0).toFixed(0).padStart(5)}` +
    `  南 ${(b.南 ?? 0).toFixed(0).padStart(6)}  北 ${(b.北 ?? 0).toFixed(0).padStart(6)}` +
    `  西 ${(b.西 ?? 0).toFixed(0).padStart(6)}  東 ${(b.東 ?? 0).toFixed(0).padStart(6)}` +
    `   残差 ${close(b).toFixed(0).padStart(5)}`;

  console.log(`■ ${id}（${gate.latMin}〜${gate.latMax}°, ${gate.lonMin}〜${gate.lonMax}°）`);
  console.log(`  ${fmt(yr, '年')}`);
  console.log(`  ${fmt(su, '夏')}`);
  console.log(`  ${fmt(wi, '冬')}`);
  console.log('');
}
console.log(
  '読み方: **夏の「南」が正で大きい**のがモンスーンの姿。負なら海からの流入が\n' +
    '        出ていない。残差は境界の離散化の粗さ(拡散項を面で数えていない)ぶん。',
);
