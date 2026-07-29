// Step 4: 地表風。docs/spec/04_気流.md
// 帯状の卓越風(貿易風・偏西風・極東風)に、気圧偏差場からの勾配風
// (回転成分 + 摩擦による横断成分)を合成する。山岳は風を減衰させる。
// 低緯度では回転成分を弱め、横断(気圧の低い方へ)成分を優先する。

import { MONTHS_PER_YEAR } from '@/domain/insolation';
import { latDegOfRow, cellWidthKm, cellHeightKm, wrapCol } from '@/domain/grid';
import { MODEL_CONSTANTS as K } from './constants';
import type { AirflowResult, ItczResult, SimContext, WindBeltResult } from './types';

export function computeAirflow(
  ctx: SimContext,
  itcz: ItczResult,
  windBelt: WindBeltResult,
): AirflowResult {
  const { grid, params, terrain } = ctx;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const dirSign = params.body.rotationDirection >= 0 ? 1 : -1;
  const dyKm = cellHeightKm(grid, params.body.radiusKm);

  const monthlyWindU: Float32Array[] = [];
  const monthlyWindV: Float32Array[] = [];

  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const u = new Float32Array(grid.cellCount);
    const v = new Float32Array(grid.cellCount);
    const p = windBelt.monthlyPressureAnomalyHpa[m];
    const centers = itcz.monthlyCenterLatDegByCol[m];
    const ridgeN = windBelt.monthlyRidgeLatNDeg[m] ?? 31;
    const ridgeS = windBelt.monthlyRidgeLatSDeg[m] ?? -31;
    const pfN = windBelt.monthlyPolarFrontLatNDeg[m] ?? 60;
    const pfS = windBelt.monthlyPolarFrontLatSDeg[m] ?? -60;

    for (let row = 0; row < H; row++) {
      const lat = latDegOfRow(grid, row);
      const dxKm = Math.max(20, cellWidthKm(grid, row, params.body.radiusKm));
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        const itczLat = centers?.[col] ?? 0;

        // --- 帯状卓越風 ---
        let bu = 0;
        let bv = 0;
        if (lat > itczLat && lat <= ridgeN) {
          // 北半球貿易風(北東風 → 西南西へ吹く: u 負、v は ITCZ へ向かい負)
          const t = bandWeight(lat, itczLat, ridgeN);
          bu = -K.tradeWindMs * t * dirSign;
          bv = -K.tradeWindMs * 0.4 * t;
        } else if (lat <= itczLat && lat >= ridgeS) {
          const t = bandWeight(lat, itczLat, ridgeS);
          bu = -K.tradeWindMs * t * dirSign;
          bv = K.tradeWindMs * 0.4 * t;
        } else if (lat > ridgeN && lat <= pfN) {
          const t = bandWeight(lat, ridgeN, pfN);
          bu = K.westerlyWindMs * t * dirSign;
          bv = K.westerlyWindMs * 0.15 * t;
        } else if (lat < ridgeS && lat >= pfS) {
          const t = bandWeight(lat, ridgeS, pfS);
          bu = K.westerlyWindMs * t * dirSign;
          bv = -K.westerlyWindMs * 0.15 * t;
        } else if (lat > pfN) {
          bu = -K.polarEasterlyMs * dirSign;
          bv = -K.polarEasterlyMs * 0.3;
        } else if (lat < pfS) {
          bu = -K.polarEasterlyMs * dirSign;
          bv = K.polarEasterlyMs * 0.3;
        }

        // --- 気圧勾配風(合計を上限で抑える。実地表風は 5〜10 m/s 級) ---
        if (p) {
          const east = row * W + wrapCol(grid, col + 1);
          const west = row * W + wrapCol(grid, col - 1);
          const north = row > 0 ? (row - 1) * W + col : i;
          const south = row < H - 1 ? (row + 1) * W + col : i;
          // hPa / 1000km
          const dpdx = (((p[east] ?? 0) - (p[west] ?? 0)) / (2 * dxKm)) * 1000;
          const dpdy = (((p[north] ?? 0) - (p[south] ?? 0)) / (2 * dyKm)) * 1000;
          // コリオリの効く緯度では等圧線沿い(回転)、低緯度では横断(気圧の低い方へ)が主。
          // モンスーン流は非地衡なので回転成分は |lat|<30° で滑らかに殺す
          const f = Math.sin((Math.abs(lat) * Math.PI) / 180);
          const rotRamp = Math.min(1, Math.max(0, (Math.abs(lat) - 10) / 20));
          const rotSign = (lat >= 0 ? 1 : -1) * dirSign;
          const rotW = K.pressureGradientRotationalMsPerHpaPerMm * f * rotRamp;
          const crossW = K.pressureGradientCrossMsPerHpaPerMm * (1 - 0.5 * f);
          let pu = rotSign * rotW * -dpdy - crossW * dpdx;
          let pv = rotSign * rotW * dpdx - crossW * dpdy;
          const pMag = Math.hypot(pu, pv);
          const P_MAX = 8;
          if (pMag > P_MAX) {
            pu *= P_MAX / pMag;
            pv *= P_MAX / pMag;
          }
          bu += pu;
          bv += pv;
        }

        // --- 山岳減衰(高地は地表風が地形に削られる) ---
        const elev = terrain.elevationMeters[i] ?? 0;
        if (elev > 1500) {
          const damp = Math.max(0.35, 1 - (elev - 1500) / 4000);
          bu *= damp;
          bv *= damp;
        }
        // 合計風速の上限(地表月平均としての妥当域)
        const mag = Math.hypot(bu, bv);
        const MAX_WIND = 13;
        if (mag > MAX_WIND) {
          bu *= MAX_WIND / mag;
          bv *= MAX_WIND / mag;
        }
        u[i] = bu;
        v[i] = bv;
      }
    }
    monthlyWindU.push(u);
    monthlyWindV.push(v);
  }
  return { monthlyWindU, monthlyWindV };
}

/** 帯の内側で滑らかに 0→1→0(端で弱まる)…中央で最大の重み */
function bandWeight(lat: number, edge0: number, edge1: number): number {
  const t = (lat - edge0) / (edge1 - edge0);
  if (t < 0 || t > 1) return 0;
  return Math.sin(Math.PI * Math.min(1, Math.max(0, t))) * 0.5 + 0.5;
}
