// 蒸発の源泉(海面蒸発)。**保存型の水収支へ移行するための第 1 段**。
//
// 対応 spec: docs/事前登録_保存則への移行_2026-08-09.md の S1。
//
// なぜ要るか:
//   現行の降水は「風上追跡による供給 q × 乗数の積」で作られている。q は
//   **湿潤源への到達可能性**であって水蒸気量ではないので、水の収支が閉じない。
//   保存型輸送(moisture_transport.ts)は既に実装済みだが、必要な入力
//     S_i = 海面蒸発 + 陸面蒸発散  [mm/月]
//   のうち**海面蒸発がモデルに存在しない**ため接続できていなかった。
//
//   利用者の警告(2026-08-09):
//     「保存ということは、もとの量を見誤れば誤差が非常に大きくなる」
//   そのとおりで、非保存の乗数方式なら局所に留まる誤差が、保存則の下では
//   下流へ運ばれて非局所になる。**だから源泉には独立の関門を置く**
//   (事前登録の S2。全球平均 900〜1100mm/年 など)。
//
// 定式化(バルク空気力学式。地理を一切参照しない):
//
//   E = ρ_a · C_E · |V| · (q_s(T_s) − q_a)          [kg/m²/s]
//   q_a = RH · q_s(T_s)  と近似   →   E = ρ_a · C_E · |V| · q_s(T_s) · (1 − RH)
//
//   q_s(T, p) = ε · e_s(T) / (p − (1−ε)·e_s(T))     ε = 0.622
//
// **気圧に陽に依存する**ので他の惑星でも意味を持つ(薄い大気ほど同じ温度で
// 比湿が大きくなる)。近地表の相対湿度を定数で置くのは粗いが、
// 海上では実測でも 0.75〜0.85 に収まる量である。
//
// この段階では**診断としてのみ**計算し、降水には使わない。
// 事前登録の S2(源泉の検証)を通ってから輸送へ繋ぐ。

import { MODEL_CONSTANTS as K } from './constants';
import { MONTHS_PER_YEAR } from '@/domain/insolation';
import { saturationVaporPressureHpa } from './step06_precipitation';
import type { AirflowResult, SimContext, TemperatureResult } from './types';

/** 乾燥空気の分子量に対する水蒸気の比 */
const EPSILON = 0.622;
/** 1 か月の秒数(30.44 日) */
const SECONDS_PER_MONTH = 30.44 * 86400;

/**
 * 飽和比湿(kg/kg)。**気圧に依存する** — 薄い大気ほど同じ温度で比湿が大きい。
 * `pressureHpa` は地表気圧。
 */
export function saturationSpecificHumidity(tempC: number, pressureHpa: number): number {
  const es = saturationVaporPressureHpa(tempC);
  const denom = Math.max(1e-3, pressureHpa - (1 - EPSILON) * es);
  return (EPSILON * es) / denom;
}

export interface EvaporationResult {
  /** [month][cell] 海面蒸発 mm/月(陸セルは 0) */
  monthlyOceanEvapMm: Float32Array[];
  /** 全球平均の海面蒸発 mm/年(海セルのみ、面積重み) */
  oceanMeanMmPerYear: number;
}

/**
 * 海面蒸発をバルク式で作る。
 *
 * 海セルの表面温度は EBM の解(混合層温度)をそのまま使う。
 * 風速は Step 4 の地表風。どちらも既にある場で、新しい入力は要らない。
 */
export function computeOceanEvaporation(
  ctx: SimContext,
  temperature: TemperatureResult,
  airflow: AirflowResult,
): EvaporationResult {
  const { grid, terrain, params } = ctx;
  const pressureHpa = params.atmosphere.surfacePressureBar * 1013.25;
  // 空気密度は状態方程式から。気圧に比例し、気温に反比例する
  const rhoRef = (1.225 * params.atmosphere.surfacePressureBar * 288.15) / 288.15;

  const monthlyOceanEvapMm: Float32Array[] = [];
  let sumW = 0;
  let sumWE = 0;

  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const field = new Float32Array(grid.cellCount);
    const t = temperature.monthlyTemperatureC[m];
    const u = airflow.monthlyWindU[m];
    const v = airflow.monthlyWindV[m];
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = 90 - (row + 0.5) * grid.resolutionDeg;
      const w = Math.cos((lat * Math.PI) / 180);
      for (let col = 0; col < grid.widthCells; col++) {
        const i = row * grid.widthCells + col;
        if (terrain.landMask[i]) continue;
        const tc = t?.[i] ?? 0;
        // 氷結面からの蒸発は無視できるほど小さい(昇華のみ)。凍結点以下は 0
        if (tc <= K.seaFreezeC) continue;
        const spd = Math.hypot(u?.[i] ?? 0, v?.[i] ?? 0);
        // 静穏時でも自由対流で蒸発するので下限を置く(gustiness)
        const vEff = Math.max(K.evapMinWindMs, spd);
        const rho = (rhoRef * 288.15) / (tc + 273.15);
        const qs = saturationSpecificHumidity(tc, pressureHpa);
        const eKgM2S = rho * K.evapBulkCoef * vEff * qs * (1 - K.evapOceanRelHumidity);
        // kg/m²/s → mm/月(水 1kg/m² = 1mm)
        const mm = Math.max(0, eKgM2S * SECONDS_PER_MONTH);
        field[i] = mm;
        sumW += w;
        sumWE += w * mm;
      }
    }
    monthlyOceanEvapMm.push(field);
  }

  // 月平均 → 年へ(面積重み平均の 12 か月合計)
  const oceanMeanMmPerYear = sumW > 0 ? (sumWE / sumW) * MONTHS_PER_YEAR : 0;
  return { monthlyOceanEvapMm, oceanMeanMmPerYear };
}
