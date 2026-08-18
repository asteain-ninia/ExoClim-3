// Step 2: 風帯と気圧場。docs/spec/02_風帯.md
// 大循環セル境界(亜熱帯高圧帯・極前線)を自転周期と季節でスケールし、
// 気圧偏差場(亜熱帯高気圧・大陸熱的高低気圧・ITCZ トラフ)を月別に構築する。

import { MONTHS_PER_YEAR } from '@/domain/insolation';
import { latDegOfRow, cellWidthKm } from '@/domain/grid';
import { MODEL_CONSTANTS as K } from './constants';
import type { ItczResult, SimContext, WindBeltResult } from './types';

/**
 * @param priorTemperatureC 前パスの月別地表気温(°C)。渡すと**温度 → 気圧の
 *   帰還**が入る(docs/事前登録_温度から気圧への帰還_2026-08-10.md)。
 *   既存の熱的高低気圧は日射と海岸距離だけで書かれており、モデル自身の気温を
 *   まったく見ていない。渡さなければ従来と厳密に一致する。
 */
export function computeWindBelt(
  ctx: SimContext,
  itcz: ItczResult,
  priorTemperatureC?: Float32Array[],
  priorWetness01?: Float32Array[],
): WindBeltResult {
  const { grid, params, terrain, insolation, landDistToCoastKm } = ctx;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const tilt = Math.max(params.body.axialTiltDeg, 1e-6);

  // ハドレー端: 自転が遅いほど極側へ広がる(P^n)。[18°, 78°] にクランプ
  const rotFactor = Math.pow(params.body.rotationPeriodHours / 24, K.hadleyRotationExponent);
  const ridgeBase = Math.min(78, Math.max(18, K.hadleyEdgeBaseDeg * rotFactor));
  const polarFrontBase = Math.min(
    85,
    Math.max(ridgeBase + 12, K.polarFrontBaseDeg * Math.sqrt(rotFactor)),
  );

  const monthlyRidgeLatNDeg: number[] = [];
  const monthlyRidgeLatSDeg: number[] = [];
  const monthlyRidgeShiftDegByCol: Float32Array[] = [];
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
          const j = row * W + ((((col + dir * d) % W) + W) % W);
          if (terrain.landMask[j]) {
            eastLandKm[i] = d * dxKm;
            break;
          }
        }
      }
    }
  }

  // 海セルから「自転方向の逆(西)」の陸までの距離(km)。eastLandKm の鏡像。
  // 夏の高気圧の西方張り出し(段 39)に使う: 海盆の西縁 = 大陸東岸の沖。
  // 逆行自転では dir が反転するので東西が自動的に入れ替わる(地理中立)
  const westLandKm = new Float32Array(grid.cellCount).fill(1e9);
  if (K.subtropicalCellWestSummerBoost > 0) {
    const dir = params.body.rotationDirection >= 0 ? 1 : -1;
    for (let row = 0; row < H; row++) {
      const dxKm = Math.max(20, cellWidthKm(grid, row, params.body.radiusKm));
      const maxScan = Math.min(W - 1, Math.max(10, Math.round(6000 / dxKm)));
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        if (terrain.landMask[i]) {
          westLandKm[i] = 0;
          continue;
        }
        for (let d = 1; d <= maxScan; d++) {
          const j = row * W + ((((col - dir * d) % W) + W) % W);
          if (terrain.landMask[j]) {
            westLandKm[i] = d * dxKm;
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
    const decl = laggedDeclinationDeg(insolation.monthlyDeclinationDeg, m, K.circulationLagMonths);
    const declNorm = Math.max(-1.5, Math.min(1.5, decl / tilt)); // -1..1(高離心率で ±1.5)
    const shift = K.ridgeSeasonalShiftDeg * declNorm;
    const ridgeN = ridgeBase + shift;
    const ridgeS = -ridgeBase + shift;
    monthlyRidgeLatNDeg.push(ridgeN);
    monthlyRidgeLatSDeg.push(ridgeS);
    // **リッジの経度別の押し上げ**(段 16)。夏半球でのみ、その経度列の
    // 熱帯陸割合に比例して極側へ動かす。実物では大陸上の亜熱帯高圧帯が
    // 熱的低気圧に置き換わってリッジが極側へ逃げる(チベット高気圧)一方、
    // 海上のリッジは低緯度に留まる。帯状一様だと中緯度東岸が夏でも
    // 沈降帯の下に入りっぱなしになり、凝結率が半減する(2026-08-12 の診断)。
    // 使うのは troughLandFrac だけで、緯度も経度も名指ししない
    const ridgeShift = new Float32Array(W);
    if (K.ridgeLandShiftDeg > 0) {
      const summer = Math.min(1, Math.abs(declNorm));
      for (let col = 0; col < W; col++) {
        ridgeShift[col] = K.ridgeLandShiftDeg * (troughLandFrac[col] ?? 0) * summer;
      }
    }
    monthlyRidgeShiftDegByCol.push(ridgeShift);
    monthlyPolarFrontLatNDeg.push(polarFrontBase + shift * 0.8);
    monthlyPolarFrontLatSDeg.push(-polarFrontBase + shift * 0.8);

    const p = new Float32Array(grid.cellCount);
    const centers = itcz.monthlyCenterLatDegByCol[m];
    // 季節の熱的コントラスト: 月日射 − 年平均日射(行ごと)を規格化
    const insMonth = insolation.monthlyByRow[m];
    const insAnnual = insolation.annualMeanByRow;
    const tMonth = priorTemperatureC?.[m];
    const wetMonth = priorWetness01?.[m];
    for (let row = 0; row < H; row++) {
      const lat = latDegOfRow(grid, row);
      const seasonalHeating = ((insMonth?.[row] ?? 0) - (insAnnual[row] ?? 0)) / 120; // ±1 程度
      // 温度 → 気圧の帰還の基準点: **同じ緯度円の平均気温**。
      // 緯度円からの偏差なので水惑星では自動的に 0 になり、大陸も緯度帯も
      // 名指しせずに済む(教訓 §1 地理中立)
      let rowMeanT = 0;
      if (tMonth) {
        let s = 0;
        for (let col = 0; col < W; col++) s += tMonth[row * W + col] ?? 0;
        rowMeanT = s / W;
      }
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        let v = 0;
        // 亜熱帯高気圧(海上で強い)。離散セル化(WL#29): 帯を一様にせず、
        // 海盆の東縁(自転方向の東に大陸が近い側 = 寒流側)ほど強いセルにする
        const shiftCol = ridgeShift[col] ?? 0;
        const dN = (lat - (ridgeN + shiftCol)) / 7;
        const dS = (lat - (ridgeS - shiftCol)) / 7;
        let oceanW: number;
        if (terrain.landMask[i]) {
          oceanW = 0.35;
        } else {
          const cell = Math.exp(-(eastLandKm[i] ?? 1e9) / K.subtropicalCellEastScaleKm);
          oceanW = 0.8 + K.subtropicalCellEastBoost * cell;
          // 夏の西方張り出し(段 39): 海盆の西縁(大陸東岸の沖)を夏にだけ強める。
          // その西縁の回転成分が沿岸の陸に**極向きの湿潤流**を作る。
          // 既定 0 = この項は厳密に 0 で従来とビット一致
          if (K.subtropicalCellWestSummerBoost > 0) {
            const summerW = Math.max(0, Math.min(1.2, seasonalHeating));
            const wcell = Math.exp(-(westLandKm[i] ?? 1e9) / K.subtropicalCellWestScaleKm);
            oceanW += K.subtropicalCellWestSummerBoost * wcell * summerW;
          }
        }
        v += K.subtropicalHighHpa * oceanW * (Math.exp(-dN * dN) + Math.exp(-dS * dS));
        // 大陸の熱的高低気圧: 夏に低圧・冬に高圧(内陸ほど強い)
        v += -K.continentalThermalHpa * (interiorness[i] ?? 0) * seasonalHeating;
        // ITCZ トラフ(陸の多い経度では深いモンスーントラフになる)
        const c = centers?.[col] ?? 0;
        const dI = (lat - c) / (itcz.halfWidthDeg * 1.2);
        const troughDepth =
          K.itczTroughHpa * (1 + K.monsoonTroughDeepening * (troughLandFrac[col] ?? 0));
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
        // 温度 → 気圧の帰還(静水圧の一次近似): 緯度円平均より暑い柱は
        // 気圧が下がる。**既定 0 = 無効**で、そのとき従来と 1 ビットも変わらない。
        // 上限は実物のシベリア高気圧(+30hPa 級)を目安に置く — EBM の外れ値が
        // そのまま風速上限まで突き抜けるのを防ぐための箍であって、機構ではない
        if (tMonth && K.thermalLowHpaPerK > 0) {
          // **厚みは湿りで決まる**(段 9 第 2 版)。乾いた柱の暖偏差は境界層に
          // 閉じ込められ、気柱として軽くならないので低気圧は浅い。
          // 湿潤対流は加熱を上まで運ぶので気柱全体が軽くなり、低気圧が深い。
          // 第 1 版はこの区別が無く、乾いた内陸に一番深い低気圧を作っていた
          const wet = terrain.landMask[i] ? (wetMonth?.[i] ?? 0) : 1;
          const depth = K.thermalLowDryDepth + (1 - K.thermalLowDryDepth) * wet;
          const dp = -K.thermalLowHpaPerK * ((tMonth[i] ?? rowMeanT) - rowMeanT) * depth;
          v += Math.max(-30, Math.min(30, dp));
        }
        p[i] = v;
      }
    }
    monthlyPressureAnomalyHpa.push(p);
  }

  return {
    monthlyRidgeLatNDeg,
    monthlyRidgeLatSDeg,
    monthlyRidgeShiftDegByCol,
    monthlyPolarFrontLatNDeg,
    monthlyPolarFrontLatSDeg,
    monthlyPressureAnomalyHpa,
  };
}

/**
 * 段 46: 循環が参照する赤緯(暦の遅れつき)。lag = 0 なら配列参照と厳密一致。
 * 円環の線形補間(月 11.5 と 0.5 の間も正しく繋ぐ)
 */
function laggedDeclinationDeg(monthlyDeclinationDeg: ArrayLike<number>, m: number, lagMonths: number): number {
  if (lagMonths === 0) return monthlyDeclinationDeg[m] ?? 0;
  const n = 12;
  let t = m - lagMonths;
  while (t < 0) t += n;
  const i0 = Math.floor(t) % n;
  const i1 = (i0 + 1) % n;
  const f = t - Math.floor(t);
  return (monthlyDeclinationDeg[i0] ?? 0) * (1 - f) + (monthlyDeclinationDeg[i1] ?? 0) * f;
}
