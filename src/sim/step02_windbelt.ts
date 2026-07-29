// Step 2: 風帯と気圧場。docs/spec/02_風帯.md
// 大循環セル境界(亜熱帯高圧帯・極前線)を自転周期と季節でスケールし、
// 気圧偏差場(亜熱帯高気圧・大陸熱的高低気圧・ITCZ トラフ)を月別に構築する。

import { MONTHS_PER_YEAR } from '@/domain/insolation';
import { latDegOfRow } from '@/domain/grid';
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
        // 亜熱帯高気圧(海上で強い)
        const dN = (lat - ridgeN) / 7;
        const dS = (lat - ridgeS) / 7;
        const oceanW = terrain.landMask[i] ? 0.35 : 1;
        v += K.subtropicalHighHpa * oceanW * (Math.exp(-dN * dN) + Math.exp(-dS * dS));
        // 大陸の熱的高低気圧: 夏に低圧・冬に高圧(内陸ほど強い)
        v += -K.continentalThermalHpa * (interiorness[i] ?? 0) * seasonalHeating;
        // ITCZ トラフ
        const c = centers?.[col] ?? 0;
        const dI = (lat - c) / (itcz.halfWidthDeg * 1.2);
        v += -K.itczTroughHpa * Math.exp(-dI * dI);
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
