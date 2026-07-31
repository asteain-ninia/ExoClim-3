// 自動較正の共有部品: 探索空間と目的関数。
// scripts/optimize.ts(親)と scripts/optimize_worker.ts(評価ワーカー)が使う。
// 採点の実体は scripts/scoring.ts に一元化(P0-3)。ここでは複製しない。

import { MODEL_CONSTANTS } from '../src/sim/constants';
import type { PipelineResult } from '../src/sim/types';
import { fieldScore, itczLineRmse, koppenScore, scoreRegionGates } from './scoring';
import { gateFoldAssignments, keepExcludingFold } from './holdout';

export const SPACE: Array<[keyof typeof MODEL_CONSTANTS, number, number]> = [
  ['moistureDecayOceanKm', 1500, 3200],
  ['moistureDecayLandKm', 1100, 2400],
  ['landRecyclingStrength', 0.2, 0.6],
  ['itczLiftBoost', 1.4, 3.2],
  ['itczLiftSupplyNorm', 0.6, 1.8],
  ['stormTrackBoost', 0.4, 1.1],
  ['stormTrackWinterBoost', 0.15, 0.6],
  ['orographicBoost', 0.9, 2.5],
  ['rainShadowFloor', 0.2, 0.55],
  ['subsidenceSuppression', 0.5, 0.82],
  ['subsidenceItczProtection', 0.6, 0.95],
  ['eastCoastSubsidenceRelief', 0.5, 0.95],
  ['eastCoastSubsidenceDecayKm', 600, 1300],
  ['eastReliefSupplyNorm', 0.4, 1.2],
  ['stormMinQRel', 0.25, 0.55],
  ['stormMoistureSupply', 1.0, 2.4],
  ['stormMoistureDecayKm', 1000, 2000],
  ['orographicDepletionM', 1000, 2600],
  ['upwindBlockReliefM', 800, 1800],
  ['upwindBlockFloor', 0.08, 0.3],
  ['coldCoastSuppression', 0.25, 0.6],
  ['precipScaleMmPerUnit', 7, 10],
  ['winterFloorFracOfWettest', 0.2, 0.5],
  ['winterFloorMaxMm', 12, 34],
  ['equatorialItczResidual', 0.3, 0.8],
  ['frontalLiftBoost', 0.4, 1.2],
  ['precipMonthBlend', 0.04, 0.2],
  ['warmHumidConvectiveBoost', 0, 0.4],
  ['warmHumidSupplyNorm', 2.0, 4.0],
  ['subsidenceCloudReduction', 0.5, 0.75],
  ['subsidenceOceanFactor', 0.25, 0.5],
  ['convectiveCloudBoost', 0.3, 0.6],
  ['stormTrackCloudBoost', 0.4, 0.8],
  ['cloudAlbedoMax', 0.36, 0.46],
  ['stormCloudSummerOcean', 0.5, 0.85],
  ['itczCloudWidthFactor', 0.7, 1.1],
  ['stratocumulusBoostPerNegC', 0.35, 0.75],
  ['channelCloudBoost', 0.35, 0.8],
  ['circumpolarChannelFactor', 0.2, 0.5],
  ['winterInversionAdvectionFactor', 0.35, 0.7],
  ['winterInversionDiffusionFactor', 0.5, 0.85],
  ['hadleyDiffusionBoost', 0.5, 1.2],
  ['zonalAdvectionCouplingWm2PerK', 30, 60],
  ['summerAdvectionFactor', 0.3, 0.6],
  ['seaIceInsulationFactor', 0.8, 0.95],
  ['albedoIce', 0.28, 0.42],
  ['permanentIceAlbedo', 0.55, 0.75],
  ['sstAnomalyCouplingWm2PerK', 12, 26],
  ['olrAWm2', 201, 206],
  ['diffusionWm2PerK', 0.45, 0.65],
  ['itczHemisOffsetPerC', 0, 14],
  ['itczOceanFollowDamp', 0.35, 1.0],
  ['itczMonsoonPullDeg', 7, 13],
  ['itczPlateauPullDeg', 6, 14],
  ['itczSmoothLocalBlend', 0.25, 0.55],
  ['itczDeclinationFollowRatio', 0.28, 0.42],
  ['subtropicalCellEastBoost', 0.3, 0.9],
  ['subpolarWinterLowHpa', 3, 7],
  ['tradeWindMs', 5, 7.5],
  ['westerlyWindMs', 6.5, 9],
];

export interface Scores {
  majorPct: number;
  detailPct: number;
  gates: number;
  tempRmse: number;
  precipRmse: number;
  landMeanMm: number;
  itczRmse: number;
  fitness: number;
}

// 目的関数 v2(2026-07-31 に事前凍結・再登録 — docs/較正記録.md 参照):
//   fitness = 大分類% + 1.1×地域ゲート数 + 0.25×詳細%
//             − 0.35×気温年RMSE − 0.004×降水年RMSE − 0.02×|陸平均降水偏差|/10
//             − 0.3×ITCZ 線 RMSE(雨量重み付き、度)
// 全指標は scoring.ts の面積重み付き定義(P0-3 で validate と共通化)。
// holdoutFold 指定時(P1-1)は該当区画のセルと、区画に事前登録された
// 地域ゲートを目的関数から除外する(空間保留検証)。未指定 = 従来どおり全球。
//
// 変更レビュー FB P1-2(事前登録 2026-07-31): 保留較正の目的関数から
// ITCZ 項を除外する(案 1 を採用)。理由: 観測 ITCZ 重心は全球の熱帯降水から
// 生成されるため、重心座標への事後フィルタでは保留区画の観測降水の混入
// (漏洩)を除けない。ITCZ RMSE 自体は参考値として全球で報告し続ける。
//
// 変更レビュー FB P1-3(事前登録 2026-07-31): 保留較正のゲート項は絶対数
// ではなく「17 × 合格数 / 訓練対象ゲート数」で正規化する。fold ごとに訓練
// ゲート数(11〜16 件)が異なり、絶対数では fold 間で項の最大値・重みが
// 揃わないため。全球較正(holdoutFold 未指定)は従来どおり絶対数で不変。
export function evaluateResult(result: PipelineResult, holdoutFold?: number): Scores {
  const keep = keepExcludingFold(holdoutFold);
  const gateFolds = holdoutFold === undefined ? null : gateFoldAssignments();
  const k = koppenScore(result, undefined, keep);
  const gateResults = scoreRegionGates(result);
  const itczRmse = itczLineRmse(result);
  const f = fieldScore(result, undefined, keep);
  let gates: number;
  let gateTerm: number;
  let itczTerm: number;
  if (gateFolds === null) {
    gates = gateResults.filter((g) => g.pass).length;
    gateTerm = gates;
    itczTerm = itczRmse;
  } else {
    const training = gateResults.filter((g) => gateFolds[g.id] !== holdoutFold);
    gates = training.filter((g) => g.pass).length;
    gateTerm = (17 * gates) / Math.max(1, training.length);
    itczTerm = 0;
  }
  const fitness =
    k.majorPct +
    1.1 * gateTerm +
    0.25 * k.detailPct -
    0.35 * f.tempRmseC -
    0.004 * f.precipRmseMm -
    (0.02 * Math.abs(f.landMeanModelMm - f.landMeanObsMm)) / 10 -
    0.3 * itczTerm;
  return {
    majorPct: k.majorPct,
    detailPct: k.detailPct,
    gates,
    tempRmse: f.tempRmseC,
    precipRmse: f.precipRmseMm,
    landMeanMm: f.landMeanModelMm,
    itczRmse,
    fitness,
  };
}
