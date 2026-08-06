// 診断: C 温帯の大分類一致が 46.8% しかない理由を、判定を決める量まで割る。
//
// 対応 spec: なし(採点の解釈)。R3。
//
// なぜ要るか(2026-08-06 の内訳):
//   大分類ごとに割ると C 温帯だけ 46.8% と唯一の 5 割割れ。混同行列でも
//   「観測 C をモデルが B と答える」が 5.4%(観測 C 全体の 11.7% 中)で、
//   取り違えの最大項になっている。逆向き(B→C)は 1.9% と小さいので、
//   **系統的に乾かしすぎている**。
//
//   ケッペンの B 判定は 1 本の不等式で決まる:
//     年降水 < しきい値、  しきい値 = 10 × (2·年平均気温 + 季節性の項)
//     季節性の項: 夏に 70% 以上降る → +28 / 冬に 70% 以上 → +0 / それ以外 → +14
//   つまり **降水が足りない**のか、**気温が高くてしきい値が上がっている**のか、
//   **季節性を取り違えて +28 側に寄っている**のかを分けられる。
//
//   冷帯のときと同じく、モデルの量を 1 つずつ観測に差し替える仮想実験で、
//   どれを直せば当たるようになるかを直接測る。
//
// Beck(1°)と気候値(2°)の格子違いを避けるため、すべて 2° の気候値の上で計算する。
//
// 実行: npx tsx scripts/diag_temperate.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { classifyKoppenCell } from '../src/sim/step07_koppen';
import { majorClassOf } from '../src/domain/koppen';
import { getClimObs } from './scoring';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

const MAJOR = ['A 熱帯', 'B 乾燥', 'C 温帯', 'D 冷帯', 'E 寒帯'];

/** step07 と同じ式でしきい値(mm/年)を出す。判定の内訳を見るために再現する */
function aridThreshold(t: number[], p: number[], isNorth: boolean): number {
  const mat = t.reduce((a, b) => a + b, 0) / 12;
  const map = p.reduce((a, b) => a + b, 0);
  const summer = isNorth ? [3, 4, 5, 6, 7, 8] : [9, 10, 11, 0, 1, 2];
  const winter = isNorth ? [9, 10, 11, 0, 1, 2] : [3, 4, 5, 6, 7, 8];
  const pS = summer.reduce((s, m) => s + (p[m] ?? 0), 0);
  const pW = winter.reduce((s, m) => s + (p[m] ?? 0), 0);
  let base = 2 * mat + 14;
  if (map > 0) {
    if (pS >= 0.7 * map) base = 2 * mat + 28;
    else if (pW >= 0.7 * map) base = 2 * mat;
  }
  return Math.max(0, base) * 10;
}

interface Cell {
  lat: number;
  tObs: number[];
  pObs: number[];
  tMdl: number[];
  pMdl: number[];
}

async function main(): Promise<void> {
  const accel = await openAccel();
  let result: PipelineResult;
  try {
    result = await runPipeline(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }

  const clim = getClimObs();
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const f = Math.round(2 / grid.resolutionDeg);
  const cells: Cell[] = [];

  for (let cr = 0; cr < clim.heightCells; cr++) {
    const lat = 90 - (cr + 0.5) * 2;
    for (let cc = 0; cc < clim.widthCells; cc++) {
      const ci = cr * clim.widthCells + cc;
      const tObs: number[] = [];
      const pObs: number[] = [];
      let ok = true;
      for (let m = 0; m < 12; m++) {
        const t = clim.monthlyTemperatureDeciC[m]?.[ci] ?? -9999;
        const p = clim.monthlyPrecipitationMm[m]?.[ci] ?? -9999;
        if (t === -9999 || p === -9999) {
          ok = false;
          break;
        }
        tObs.push(t / 10);
        pObs.push(p);
      }
      if (!ok) continue;
      // 観測が C 温帯であるセルだけを見る
      if (majorClassOf(classifyKoppenCell(tObs, pObs, lat >= 0)) !== 2) continue;

      const tMdl = new Array<number>(12).fill(0);
      const pMdl = new Array<number>(12).fill(0);
      let n = 0;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const gr = cr * f + dr;
          const gc = cc * f + dc;
          if (gr >= grid.heightCells || gc >= grid.widthCells) continue;
          const gi = gr * grid.widthCells + gc;
          if (!land[gi]) continue;
          n++;
          for (let m = 0; m < 12; m++) {
            tMdl[m] = (tMdl[m] ?? 0) + (result.temperature.monthlyTemperatureC[m]?.[gi] ?? 0);
            pMdl[m] = (pMdl[m] ?? 0) + (result.precipitation.monthlyPrecipMm[m]?.[gi] ?? 0);
          }
        }
      }
      if (n === 0) continue;
      for (let m = 0; m < 12; m++) {
        tMdl[m] = (tMdl[m] ?? 0) / n;
        pMdl[m] = (pMdl[m] ?? 0) / n;
      }
      cells.push({ lat, tObs, pObs, tMdl, pMdl });
    }
  }

  console.log(`観測が C 温帯の 2° セル: ${cells.length} 個\n`);

  // どの大分類へ流れているか
  const to = new Array<number>(5).fill(0);
  for (const c of cells) {
    const mo = majorClassOf(classifyKoppenCell(c.tMdl, c.pMdl, c.lat >= 0));
    if (mo >= 0) to[mo] = (to[mo] ?? 0) + 1;
  }
  console.log('モデルの答えの内訳');
  for (let k = 0; k < 5; k++)
    console.log(`  ${MAJOR[k]}  ${String(to[k] ?? 0).padStart(5)}  ${(((to[k] ?? 0) / cells.length) * 100).toFixed(1)}%`);

  // 仮想実験: 量を 1 つずつ観測に差し替える
  const hit = (sel: (c: Cell) => { t: number[]; p: number[] }): string => {
    let n = 0;
    for (const c of cells) {
      const { t, p } = sel(c);
      if (majorClassOf(classifyKoppenCell(t, p, c.lat >= 0)) === 2) n++;
    }
    return ((n / cells.length) * 100).toFixed(1) + '%';
  };
  console.log('\n仮想実験: どの量を観測に差し替えると C に戻るか');
  console.log(`  現状                      ${hit((c) => ({ t: c.tMdl, p: c.pMdl }))}`);
  console.log(`  降水だけ観測に             ${hit((c) => ({ t: c.tMdl, p: c.pObs }))}`);
  console.log(`  気温だけ観測に             ${hit((c) => ({ t: c.tObs, p: c.pMdl }))}`);
  console.log(`  全部観測に(上限の検算)     ${hit((c) => ({ t: c.tObs, p: c.pObs }))}`);

  // B へ落ちたセルだけ、不等式の両辺を見る
  const toB = cells.filter(
    (c) => majorClassOf(classifyKoppenCell(c.tMdl, c.pMdl, c.lat >= 0)) === 1,
  );
  console.log(`\nB 乾燥へ落ちた ${toB.length} セルの内訳(年降水 < しきい値 が成立した側)`);
  const avg = (g: Cell[], sel: (c: Cell) => number): number =>
    g.length === 0 ? NaN : g.reduce((a, c) => a + sel(c), 0) / g.length;
  const mapOf = (p: number[]): number => p.reduce((a, b) => a + b, 0);
  console.log(
    `  年降水     観測 ${avg(toB, (c) => mapOf(c.pObs)).toFixed(0)}mm → ` +
      `モデル ${avg(toB, (c) => mapOf(c.pMdl)).toFixed(0)}mm ` +
      `(${((avg(toB, (c) => mapOf(c.pMdl)) / avg(toB, (c) => mapOf(c.pObs)) - 1) * 100).toFixed(0)}%)`,
  );
  console.log(
    `  しきい値   観測 ${avg(toB, (c) => aridThreshold(c.tObs, c.pObs, c.lat >= 0)).toFixed(0)}mm → ` +
      `モデル ${avg(toB, (c) => aridThreshold(c.tMdl, c.pMdl, c.lat >= 0)).toFixed(0)}mm ` +
      `(${((avg(toB, (c) => aridThreshold(c.tMdl, c.pMdl, c.lat >= 0)) / avg(toB, (c) => aridThreshold(c.tObs, c.pObs, c.lat >= 0)) - 1) * 100).toFixed(0)}%)`,
  );
  console.log(
    `  年平均気温 観測 ${avg(toB, (c) => c.tObs.reduce((a, b) => a + b, 0) / 12).toFixed(1)}°C → ` +
      `モデル ${avg(toB, (c) => c.tMdl.reduce((a, b) => a + b, 0) / 12).toFixed(1)}°C`,
  );

  // 季節性の取り違え(しきい値の +28 / +14 / +0 のどれに落ちたか)
  const seasonBucket = (c: Cell, model: boolean): string => {
    const p = model ? c.pMdl : c.pObs;
    const map = mapOf(p);
    if (map <= 0) return '—';
    const summer = c.lat >= 0 ? [3, 4, 5, 6, 7, 8] : [9, 10, 11, 0, 1, 2];
    const pS = summer.reduce((s, m) => s + (p[m] ?? 0), 0);
    if (pS >= 0.7 * map) return '夏型(+28)';
    if (map - pS >= 0.7 * map) return '冬型(+0)';
    return '平均型(+14)';
  };
  const buckets = ['夏型(+28)', '平均型(+14)', '冬型(+0)'];
  console.log('\n季節性の取り違え(しきい値の底上げ項)');
  console.log('              観測    モデル');
  for (const b of buckets) {
    const o = toB.filter((c) => seasonBucket(c, false) === b).length;
    const m = toB.filter((c) => seasonBucket(c, true) === b).length;
    console.log(`  ${b.padEnd(12)} ${String(o).padStart(5)} ${String(m).padStart(9)}`);
  }

  // どれだけ足りないのか(あと何 mm 降れば C に戻るか)
  const deficits = toB
    .map((c) => aridThreshold(c.tMdl, c.pMdl, c.lat >= 0) - mapOf(c.pMdl))
    .sort((a, b) => a - b);
  const q = (f2: number): number => deficits[Math.min(deficits.length - 1, Math.floor(deficits.length * f2))] ?? NaN;
  console.log(
    `\nあと何 mm/年 降れば B から C へ戻るか: 中央値 ${q(0.5).toFixed(0)}mm ` +
      `(下位 25% ${q(0.25).toFixed(0)}mm / 上位 25% ${q(0.75).toFixed(0)}mm)`,
  );
}

void main();
