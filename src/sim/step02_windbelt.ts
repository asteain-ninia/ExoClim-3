// Step 2: 風帯と気圧場。docs/spec/02_風帯.md
// 大循環セル境界(亜熱帯高圧帯・極前線)を自転周期と季節でスケールし、
// 気圧偏差場(亜熱帯高気圧・大陸熱的高低気圧・ITCZ トラフ)を月別に構築する。

import { MONTHS_PER_YEAR } from '@/domain/insolation';
import { latDegOfRow, cellWidthKm } from '@/domain/grid';
import { MODEL_CONSTANTS as K } from './constants';
import type { ItczResult, SimContext, WindBeltResult } from './types';

export function computeWindBelt(ctx: SimContext, itcz: ItczResult): WindBeltResult {
  const { grid, params, terrain, insolation, landDistToCoastKm } = ctx;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const tilt = Math.max(params.body.axialTiltDeg, 1e-6);

  // ハドレー端: 自転が遅いほど極側へ広がる(P^n)。[18°, 78°] にクランプ
  const rotFactor = Math.pow(params.body.rotationPeriodHours / 24, K.hadleyRotationExponent);
  const ridgeBase = Math.min(78, Math.max(18, K.hadleyEdgeBaseDeg * rotFactor));
  const polarFrontBase = Math.min(85, Math.max(ridgeBase + 12, K.polarFrontBaseDeg * Math.sqrt(rotFactor)));

  const monthlyRidgeLatNDeg: number[] = [];
  const monthlyRidgeLatSDeg: number[] = [];
  const monthlyPolarFrontLatNDeg: number[] = [];
  const monthlyPolarFrontLatSDeg: number[] = [];
  const monthlyPressureAnomalyHpa: Float32Array[] = [];

  // 内陸度(0 = 海岸、1 = 1500km 以上内陸)
  const interiorness = new Float32Array(grid.cellCount);
  for (let i = 0; i < grid.cellCount; i++) {
    interiorness[i] = terrain.landMask[i] ? Math.min(1, (landDistToCoastKm[i] ?? 0) / 1500) : 0;
  }

  // 海セルから「自転方向の東」の陸までの距離(km)。亜熱帯高気圧の離散セル化
  // (WL#29)に使う: 海盆の東縁(寒流側)ほど高気圧が強い。位相規則で地理中立
  const eastLandKm = new Float32Array(grid.cellCount).fill(1e9);
  {
    const dir = params.body.rotationDirection >= 0 ? 1 : -1;
    for (let row = 0; row < H; row++) {
      const dxKm = Math.max(20, cellWidthKm(grid, row, params.body.radiusKm));
      const maxScan = Math.min(W - 1, Math.max(10, Math.round(6000 / dxKm)));
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        if (terrain.landMask[i]) {
          eastLandKm[i] = 0;
          continue;
        }
        for (let d = 1; d <= maxScan; d++) {
          const j = row * W + (((col + dir * d) % W) + W) % W;
          if (terrain.landMask[j]) {
            eastLandKm[i] = d * dxKm;
            break;
          }
        }
      }
    }
  }

  // 経度列ごとの熱帯陸割合(|lat|≤30°)。陸上のモンスーントラフは海上 ITCZ より深い
  const troughLandFrac = new Float64Array(W);
  {
    const rowN30 = Math.max(0, Math.round((90 - 30) / grid.resolutionDeg) - 1);
    const rowS30 = Math.min(H - 1, Math.round((90 + 30) / grid.resolutionDeg));
    for (let col = 0; col < W; col++) {
      let n = 0;
      let nLand = 0;
      for (let row = rowN30; row <= rowS30; row++) {
        n++;
        if (terrain.landMask[row * W + col]) nLand++;
      }
      troughLandFrac[col] = n > 0 ? nLand / n : 0;
    }
  }

  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const decl = insolation.monthlyDeclinationDeg[m] ?? 0;
    const declNorm = Math.max(-1.5, Math.min(1.5, decl / tilt)); // -1..1(高離心率で ±1.5)
    const shift = K.ridgeSeasonalShiftDeg * declNorm;
    const ridgeN = ridgeBase + shift;
    const ridgeS = -ridgeBase + shift;
    monthlyRidgeLatNDeg.push(ridgeN);
    monthlyRidgeLatSDeg.push(ridgeS);
    monthlyPolarFrontLatNDeg.push(polarFrontBase + shift * 0.8);
    monthlyPolarFrontLatSDeg.push(-polarFrontBase + shift * 0.8);

    const p = new Float32Array(grid.cellCount);
    const centers = itcz.monthlyCenterLatDegByCol[m];
    // 季節の熱的コントラスト: 月日射 − 年平均日射(行ごと)を規格化
    const insMonth = insolation.monthlyByRow[m];
    const insAnnual = insolation.annualMeanByRow;
    for (let row = 0; row < H; row++) {
      const lat = latDegOfRow(grid, row);
      const seasonalHeating = ((insMonth?.[row] ?? 0) - (insAnnual[row] ?? 0)) / 120; // ±1 程度
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        let v = 0;
        // 亜熱帯高気圧(海上で強い)。離散セル化(WL#29): 帯を一様にせず、
        // 海盆の東縁(自転方向の東に大陸が近い側 = 寒流側)ほど強いセルにする
        const dN = (lat - ridgeN) / 7;
        const dS = (lat - ridgeS) / 7;
        let oceanW: number;
        if (terrain.landMask[i]) {
          oceanW = 0.35;
        } else {
          const cell = Math.exp(-(eastLandKm[i] ?? 1e9) / K.subtropicalCellEastScaleKm);
          oceanW = 0.8 + K.subtropicalCellEastBoost * cell;
        }
        v += K.subtropicalHighHpa * oceanW * (Math.exp(-dN * dN) + Math.exp(-dS * dS));
        // 大陸の熱的高低気圧: 夏に低圧・冬に高圧(内陸ほど強い)
        v += -K.continentalThermalHpa * (interiorness[i] ?? 0) * seasonalHeating;
        // ITCZ トラフ(陸の多い経度では深いモンスーントラフになる)
        const c = centers?.[col] ?? 0;
        const dI = (lat - c) / (itcz.halfWidthDeg * 1.2);
        const troughDepth = K.itczTroughHpa * (1 + K.monsoonTroughDeepening * (troughLandFrac[col] ?? 0));
        v += -troughDepth * Math.exp(-dI * dI);
        // 冬の亜寒帯海上低気圧(WL#32/#34): 寒候期に極前線付近の海上へ
        // 半永続低気圧(アリューシャン/アイスランド低相当)。海氷縁は
        // Step 5 より後段のため極前線相対で近似(惑星由来値のみ)
        if (!terrain.landMask[i]) {
          const pf = lat >= 0 ? polarFrontBase + shift * 0.8 : -(polarFrontBase - shift * 0.8);
          const dP = (lat - pf) / 8;
          const winterW = Math.max(0, Math.min(1.2, -seasonalHeating));
          v += -K.subpolarWinterLowHpa * Math.exp(-dP * dP) * winterW;
        }
        // 極域の弱い高気圧
        if (Math.abs(lat) > 75) v += 2 * ((Math.abs(lat) - 75) / 15);
        p[i] = v;
      }
    }
    monthlyPressureAnomalyHpa.push(p);
  }

  return {
    monthlyRidgeLatNDeg,
    monthlyRidgeLatSDeg,
    monthlyPolarFrontLatNDeg,
    monthlyPolarFrontLatSDeg,
    monthlyPressureAnomalyHpa,
  };
}
