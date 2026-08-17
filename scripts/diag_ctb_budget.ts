// 診断: **C→B 誤分類セル(本丸)の水収支 — 拡散はそこで味方か敵か。**
//
// なぜ要るか(2026-08-17):
//   緯度帯の集計(diag_diffusion_by_latitude)では、亜熱帯の陸で拡散は
//   **排出**(帯平均 −23.7mm/年)だった。ところが拡散を下げる掃引では
//   インド・米南東が**乾いた**(0.45→0.34)。帯平均と限界効果の符号が
//   合わない — 帯平均が縁(排出側)と内陸(受取側)を混ぜているためと
//   考えられる。**設計を決めるのは帯平均ではなく、直したいセルでの収支**である。
//
// 何を出すか:
//   C→B 誤分類セルと、対照(当たっている C)で、年・夏半年の
//     移流流入 / 拡散流入 / 源 E / 降水 P
//   を面積重み平均で並べる。拡散流入が正なら「拡散が命綱」で、
//   下げる設計は C→B を殺す。負なら「拡散が奪っている」で、下げる設計が効く。
//
// 実行: npx tsx scripts/diag_ctb_budget.ts

import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow, cellWidthKm, cellHeightKm, wrapCol } from '../src/domain/grid';
import { SECONDS_PER_MONTH } from '../src/sim/moisture_transport';
import { MAJOR, majorClassOf } from '../src/domain/koppen';
import { getKoppenObs } from './scoring';
import { openAccel } from './accel_cli';

const K = MODEL_CONSTANTS as unknown as Record<string, number>;

// 定数の上書き(組の実験用、diag_monsoon_inflow と同じ書式)。
// DIAG_OVERRIDE='monsoonMeridionalReversal=1.0' のように指定。未知の名前は例外
if (process.env['DIAG_OVERRIDE']) {
  for (const part of process.env['DIAG_OVERRIDE'].split(',')) {
    const [name, raw] = part.split('=');
    const key = (name ?? '').trim();
    const v = Number(raw);
    if (!key || !(key in K)) throw new Error(`DIAG_OVERRIDE: 未知の定数 '${key}'`);
    if (!Number.isFinite(v)) throw new Error(`DIAG_OVERRIDE: '${key}' の値が数値でない`);
    K[key] = v;
    console.log(`[上書き] ${key} = ${v}`);
  }
}

interface Acc { w: number; adv: number; dif: number; src: number; p: number }
const emptyAcc = (): Acc => ({ w: 0, adv: 0, dif: 0, src: 0, p: 0 });

async function main(): Promise<void> {
  const accel = await openAccel(true);
  let out;
  try {
    out = await runPipelineWithPrecipDiag(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }
  const { result: r, precipDiag: d } = out;
  const grid = r.context.grid;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const land = r.context.terrain.landMask;
  const kobs = getKoppenObs();
  const dyKm = cellHeightKm(grid, r.context.params.body.radiusKm);
  const dM2 = K['moistureEddyDiffusivityM2PerS'] ?? 0;
  const dKm2 = (dM2 * SECONDS_PER_MONTH) / 1e6;

  // 群 0 = C→B(誤判定)、1 = C→C(対照)。季節 0 = 年、1 = 夏半年
  const GROUPS = ['C→B(誤判定)', 'C→C(対照)'];
  const SEASONS = ['年', '夏半年'];
  const acc: Acc[][] = SEASONS.map(() => GROUPS.map(() => emptyAcc()));

  for (let row = 1; row < H - 1; row++) {
    const lat = latDegOfRow(grid, row);
    const north = lat >= 0;
    const cw = Math.cos((lat * Math.PI) / 180);
    const dxKm = Math.max(20, cellWidthKm(grid, row, r.context.params.body.radiusKm));
    const summerMonths = north ? [3, 4, 5, 6, 7, 8] : [9, 10, 11, 0, 1, 2];
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      if (!land[i]) continue;
      const obsId = kobs.classRaster[i] ?? 0;
      if (obsId === 0) continue;
      if (majorClassOf(obsId) !== MAJOR.C) continue;
      const modMajor = majorClassOf(r.koppen.classId[i] ?? 0);
      let gi: number;
      if (modMajor === MAJOR.B) gi = 0;
      else if (modMajor === MAJOR.C) gi = 1;
      else continue;

      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        const w = d.waterMm[m];
        const u = r.airflow.monthlyWindU[m];
        const v = r.airflow.monthlyWindV[m];
        if (!w || !u || !v) continue;
        const iE = row * W + wrapCol(grid, col + 1);
        const iW = row * W + wrapCol(grid, col - 1);
        const iN = (row - 1) * W + col;
        const iS = (row + 1) * W + col;
        const kx = SECONDS_PER_MONTH / 1000;
        const fE = 0.5 * (((u[i] ?? 0) * (w[i] ?? 0)) + ((u[iE] ?? 0) * (w[iE] ?? 0))) * kx;
        const fW = 0.5 * (((u[i] ?? 0) * (w[i] ?? 0)) + ((u[iW] ?? 0) * (w[iW] ?? 0))) * kx;
        const fN = 0.5 * (((v[i] ?? 0) * (w[i] ?? 0)) + ((v[iN] ?? 0) * (w[iN] ?? 0))) * kx;
        const fS = 0.5 * (((v[i] ?? 0) * (w[i] ?? 0)) + ((v[iS] ?? 0) * (w[iS] ?? 0))) * kx;
        const adv = -((fE - fW) / dxKm + (fN - fS) / dyKm);
        const lap =
          ((w[iE] ?? 0) + (w[iW] ?? 0) - 2 * (w[i] ?? 0)) / (dxKm * dxKm) +
          ((w[iN] ?? 0) + (w[iS] ?? 0) - 2 * (w[i] ?? 0)) / (dyKm * dyKm);
        const dif = dKm2 * lap;
        const src = r.precipitation.land?.monthlyEtMm?.[m]?.[i] ?? 0;
        const p = r.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;

        const isSummer = summerMonths.includes(m);
        for (const si of isSummer ? [0, 1] : [0]) {
          const a = acc[si]?.[gi];
          if (!a) continue;
          a.w += cw;
          a.adv += cw * adv;
          a.dif += cw * dif;
          a.src += cw * src;
          a.p += cw * p;
        }
      }
    }
  }

  console.log(`拡散係数 D = ${dM2.toExponential(2)} m²/s\n`);
  for (let si = 0; si < SEASONS.length; si++) {
    console.log(`【${SEASONS[si]}】(面積重み平均、mm/年換算)`);
    console.log('群              移流流入  拡散流入   源E    降水P   正味輸入(移流+拡散)');
    for (let gi = 0; gi < GROUPS.length; gi++) {
      const a = acc[si]?.[gi];
      if (!a || a.w <= 0) continue;
      const scale = si === 0 ? 1 : 2;
      const adv = (scale * a.adv) / a.w;
      const dif = (scale * a.dif) / a.w;
      const src = (scale * a.src) / a.w;
      const p = (scale * a.p) / a.w;
      console.log(
        `${GROUPS[gi]?.padEnd(14) ?? ''} ${adv.toFixed(1).padStart(8)} ${dif.toFixed(1).padStart(9)}` +
          ` ${src.toFixed(0).padStart(6)} ${p.toFixed(0).padStart(7)} ${(adv + dif).toFixed(1).padStart(10)}`,
      );
    }
    console.log('');
  }
  console.log(
    '読み: C→B の拡散流入が **正** なら拡散は命綱(下げる設計は C→B を殺す)。\n' +
      '      **負** なら拡散が奪っている(下げる設計が C→B を直す)。\n' +
      '      掃引の実測(D を下げるとインド・米南東が乾く)との整合も確かめること。',
  );
}

void main();
