// 軌道幾何と日平均日射の厳密計算。docs/spec/00_基盤.md §3
// 手法: ケプラー方程式(Newton 法)で離心近点角を解き、真近点角 → 太陽黄経 →
// 赤緯・距離を得る。日平均日射は標準の日照時間積分(Berger 1978 と同形)。
// 月の定義: 「北半球冬至を月 0 の開始」とし、平均近点角を 12 等分(等時間分割)。
// これにより任意の惑星で「月 6〜8 = 北半球夏」の直感が保たれる。

import type { OrbitalParams } from './planetParams';
import { stellarConstantWm2 } from './planetParams';
import type { Grid } from './grid';
import { latDegOfRow } from './grid';

const DEG = Math.PI / 180;

export const MONTHS_PER_YEAR = 12;

/** ケプラー方程式 M = E − e·sinE を Newton 法で解く(決定的、最大 32 反復) */
export function solveEccentricAnomaly(meanAnomalyRad: number, eccentricity: number): number {
  let e0 = eccentricity > 0.8 ? Math.PI : meanAnomalyRad;
  for (let i = 0; i < 32; i++) {
    const f = e0 - eccentricity * Math.sin(e0) - meanAnomalyRad;
    const fp = 1 - eccentricity * Math.cos(e0);
    const step = f / fp;
    e0 -= step;
    if (Math.abs(step) < 1e-12) break;
  }
  return e0;
}

export function trueAnomalyFromEccentric(
  eccentricAnomalyRad: number,
  eccentricity: number,
): number {
  const cosE = Math.cos(eccentricAnomalyRad);
  const sinE = Math.sin(eccentricAnomalyRad);
  const denom = 1 - eccentricity * cosE;
  const cosNu = (cosE - eccentricity) / denom;
  const sinNu = (Math.sqrt(1 - eccentricity * eccentricity) * sinE) / denom;
  return Math.atan2(sinNu, cosNu);
}

/** 真近点角 → 平均近点角 */
export function meanAnomalyFromTrue(trueAnomalyRad: number, eccentricity: number): number {
  const cosNu = Math.cos(trueAnomalyRad);
  const sinNu = Math.sin(trueAnomalyRad);
  const denom = 1 + eccentricity * cosNu;
  const cosE = (eccentricity + cosNu) / denom;
  const sinE = (Math.sqrt(1 - eccentricity * eccentricity) * sinNu) / denom;
  const E = Math.atan2(sinE, cosE);
  return E - eccentricity * sinE;
}

export interface OrbitSample {
  /** 太陽黄経(度、0 = 北半球春分) */
  solarLongitudeDeg: number;
  /** 太陽赤緯(度) */
  declinationDeg: number;
  /** 日射の距離係数 (a/r)² */
  distanceFactor: number;
}

/** 平均近点角(冬至起点からの経過、rad)における軌道サンプル */
export function sampleOrbit(
  orbital: OrbitalParams,
  axialTiltDeg: number,
  meanAnomalyFromWinterSolsticeRad: number,
): OrbitSample {
  const e = orbital.eccentricity;
  // 冬至(太陽黄経 270°)の平均近点角
  const nuWinter = (270 - orbital.perihelionSeasonDeg) * DEG;
  const mWinter = meanAnomalyFromTrue(nuWinter, e);
  const m = mWinter + meanAnomalyFromWinterSolsticeRad;
  const E = solveEccentricAnomaly(m, e);
  const nu = trueAnomalyFromEccentric(E, e);
  const solarLongitudeDeg = (((nu / DEG + orbital.perihelionSeasonDeg) % 360) + 360) % 360;
  const declinationDeg =
    Math.asin(Math.sin(axialTiltDeg * DEG) * Math.sin(solarLongitudeDeg * DEG)) / DEG;
  const rOverA = 1 - e * Math.cos(E);
  return { solarLongitudeDeg, declinationDeg, distanceFactor: 1 / (rOverA * rOverA) };
}

/** 日平均日射(W/m²)。S0 は距離補正済みの恒星定数。 */
export function dailyMeanInsolationWm2(
  latDeg: number,
  declinationDeg: number,
  s0Wm2: number,
): number {
  const phi = latDeg * DEG;
  const delta = declinationDeg * DEG;
  const cosH0 = -Math.tan(phi) * Math.tan(delta);
  if (cosH0 >= 1) return 0; // 極夜
  const h0 = cosH0 <= -1 ? Math.PI : Math.acos(cosH0); // 極昼は H0 = π
  return (
    (s0Wm2 / Math.PI) *
    (h0 * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.sin(h0))
  );
}

export interface InsolationField {
  /** [month][row] 日平均日射 W/m² */
  monthlyByRow: Float64Array[];
  /** 月代表の太陽赤緯(度、月内サンプル平均) */
  monthlyDeclinationDeg: number[];
  /** 月代表の距離係数 (a/r)² */
  monthlyDistanceFactor: number[];
  /** 年平均日射 [row] */
  annualMeanByRow: Float64Array;
}

const SUBSAMPLES_PER_MONTH = 4;

/** 月別・緯度別の日平均日射(月内 4 点の等時間サンプル平均) */
export function computeInsolation(
  grid: Grid,
  orbital: OrbitalParams,
  axialTiltDeg: number,
): InsolationField {
  const s0 = stellarConstantWm2(orbital);
  const rows = grid.heightCells;
  const monthlyByRow: Float64Array[] = [];
  const monthlyDeclinationDeg: number[] = [];
  const monthlyDistanceFactor: number[] = [];
  const annual = new Float64Array(rows);

  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const byRow = new Float64Array(rows);
    let declSum = 0;
    let distSum = 0;
    for (let k = 0; k < SUBSAMPLES_PER_MONTH; k++) {
      const frac = (m + (k + 0.5) / SUBSAMPLES_PER_MONTH) / MONTHS_PER_YEAR;
      const sample = sampleOrbit(orbital, axialTiltDeg, frac * 2 * Math.PI);
      declSum += sample.declinationDeg;
      distSum += sample.distanceFactor;
      const s0Adj = s0 * sample.distanceFactor;
      for (let row = 0; row < rows; row++) {
        byRow[row] =
          (byRow[row] ?? 0) +
          dailyMeanInsolationWm2(latDegOfRow(grid, row), sample.declinationDeg, s0Adj) /
            SUBSAMPLES_PER_MONTH;
      }
    }
    monthlyByRow.push(byRow);
    monthlyDeclinationDeg.push(declSum / SUBSAMPLES_PER_MONTH);
    monthlyDistanceFactor.push(distSum / SUBSAMPLES_PER_MONTH);
    for (let row = 0; row < rows; row++)
      annual[row] = (annual[row] ?? 0) + (byRow[row] ?? 0) / MONTHS_PER_YEAR;
  }
  return { monthlyByRow, monthlyDeclinationDeg, monthlyDistanceFactor, annualMeanByRow: annual };
}
