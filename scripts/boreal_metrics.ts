// 冷帯の指標(事前登録の主判定・副判定に使う量)を 1 か所にまとめる。
//
// 対応 spec: docs/事前登録_蒸発帰還_2026-08-07.md の判定条件。
//
// diag_boreal_letters.ts / diag_boreal_summer.ts と**同じ定義**でなければ
// 判定が動いてしまうので、実験側はここを通す。
//
// Beck(1°)と気候値(2°)の格子違いを避けるため、観測の文字も気候値から起こす。

import { getClimObs } from './scoring';
import type { PipelineResult } from '../src/sim/types';

export interface BorealCell {
  tMax: number;
  tMin: number;
  nWarm: number;
  annual: number;
}

export function summarizeMonths(monthly: number[]): BorealCell {
  return {
    tMax: Math.max(...monthly),
    tMin: Math.min(...monthly),
    nWarm: monthly.filter((t) => t >= 10).length,
    annual: monthly.reduce((a, b) => a + b, 0) / 12,
  };
}

/** ケッペン D の第 3 文字(気温だけで決まる) */
export function thirdLetter(c: BorealCell): string {
  if (c.tMin <= -38) return 'd';
  if (c.tMax >= 22) return 'a';
  if (c.nWarm >= 4) return 'b';
  return 'c';
}

/** D 帯の条件(最寒月 ≤ 0°C かつ 最暖月 ≥ 10°C) */
export function isD(c: BorealCell): boolean {
  return c.tMin <= 0 && c.tMax >= 10;
}

export interface BorealMetrics {
  /** 観測 D 帯の 2° セル数 */
  cells: number;
  /** 第 3 文字の一致率 % */
  letterHitPct: number;
  /** 緯度帯ごとの最暖月ずれ(モデル − 観測、°C)。キーは帯の下端 */
  dTmaxByBand: Record<number, number>;
  /** 全帯まとめた最暖月ずれ */
  dTmaxAll: number;
}

export function borealMetrics(result: PipelineResult): BorealMetrics {
  const clim = getClimObs();
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const f = Math.round(2 / grid.resolutionDeg);
  const pairs: Array<{ obs: BorealCell; mdl: BorealCell; lat: number }> = [];

  for (let cr = 0; cr < clim.heightCells; cr++) {
    const lat = 90 - (cr + 0.5) * 2;
    for (let cc = 0; cc < clim.widthCells; cc++) {
      const ci = cr * clim.widthCells + cc;
      const tObs: number[] = [];
      let ok = true;
      for (let m = 0; m < 12; m++) {
        const t = clim.monthlyTemperatureDeciC[m]?.[ci] ?? -9999;
        if (t === -9999) {
          ok = false;
          break;
        }
        tObs.push(t / 10);
      }
      if (!ok) continue;
      const obs = summarizeMonths(tObs);
      if (!isD(obs)) continue;

      const tMdl = new Array<number>(12).fill(0);
      let n = 0;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const gr = cr * f + dr;
          const gc = cc * f + dc;
          if (gr >= grid.heightCells || gc >= grid.widthCells) continue;
          const gi = gr * grid.widthCells + gc;
          if (!land[gi]) continue;
          n++;
          for (let m = 0; m < 12; m++)
            tMdl[m] = (tMdl[m] ?? 0) + (result.temperature.monthlyTemperatureC[m]?.[gi] ?? 0);
        }
      }
      if (n === 0) continue;
      for (let m = 0; m < 12; m++) tMdl[m] = (tMdl[m] ?? 0) / n;
      pairs.push({ obs, mdl: summarizeMonths(tMdl), lat });
    }
  }

  let hit = 0;
  for (const p of pairs) if (isD(p.mdl) && thirdLetter(p.mdl) === thirdLetter(p.obs)) hit++;

  const dTmaxByBand: Record<number, number> = {};
  for (const lo of [30, 40, 50, 60, 70]) {
    const g = pairs.filter((p) => Math.abs(p.lat) >= lo && Math.abs(p.lat) < lo + 10);
    if (g.length > 0)
      dTmaxByBand[lo] = g.reduce((a, p) => a + (p.mdl.tMax - p.obs.tMax), 0) / g.length;
  }

  return {
    cells: pairs.length,
    letterHitPct: pairs.length > 0 ? (hit / pairs.length) * 100 : 0,
    dTmaxByBand,
    dTmaxAll:
      pairs.length > 0 ? pairs.reduce((a, p) => a + (p.mdl.tMax - p.obs.tMax), 0) / pairs.length : 0,
  };
}
