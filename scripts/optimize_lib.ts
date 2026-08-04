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
  // 陸の実効熱容量(水柱換算 m)。**2026-08-01 に追加**。
  // 追加の根拠(目的関数を見て決めたのではなく、独立した診断から):
  //   モデルの季節振幅を観測と比べると、内陸(海岸 1000km 以上)で +5.2°C 過大、
  //   沿岸ではほぼ誤差なし。大陸度のコントラストが過大という診断
  //   (scripts/exp_season_response.ts)。陸の熱容量はその第一の制御量なのに
  //   探索空間に入っておらず、較正が触れなかった。
  //   下見の走査で 1.2 → 4.0 にすると内陸振幅 5.21 → 2.45°C、
  //   詳細一致率 39.38 → 41.47 と改善する。上限は 4.0 が端に来ないよう 8 まで取る。
  // 実測で**ほぼ効かない**と判明している(2026-08-04、constants.ts の注記)。
  // 移流結合が実効減衰を支配するため ωτ ≈ 0.009。探索に残してあるのは、
  // 移流結合と対で動かす実験のときに同じ空間で扱うため
  ['landEffectiveWaterDepthM', 0.5, 8],
  // 陸面の潜熱帰還(実蒸発散の陸平均偏差 × 係数)。2026-08-04 に降水代用から
  // 実 ET へ繋ぎ替えて事前登録の判定を満たした。**上限は物理値 28.4 の範囲内**に
  // 留める(λρ = 28.4 W/m² per mm/日 が地表から出る潜熱の全量。凝結して同じ場所へ
  // 戻る分があるので実効コントラストはそれより小さい)
  ['evapCoolingWm2PerMmDay', 0, 12],
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

/**
 * 数値的に解けなかった評価に与える不適合度。
 * 較正が「収束しない領域」へ逃げ込むのを防ぐ(未収束は歴史的に成績を
 * よく見せる方向に働く — GS_SWEEPS の件)。**棄却であって減点ではない**。
 */
export const UNSOLVED_FITNESS = -1e6;

export interface Scores {
  majorPct: number;
  detailPct: number;
  gates: number;
  tempRmse: number;
  precipRmse: number;
  landMeanMm: number;
  itczRmse: number;
  /** 目的関数 v3(探索が最大化する量) */
  fitness: number;
  /** 目的関数 v2(旧定義。比較のために必ず併記する) */
  fitnessV2: number;
  // ---- 季節指標(v3 で目的関数に入った量。報告にも使う)----
  tempRangeRmse: number;
  tempPhaseRmseDays: number;
  precipDriestRmse: number;
  precipWettestRmse: number;
}

/**
 * 目的関数 v3 の重みと無次元化(2026-08-02 に事前登録)。
 *
 * ## なぜ変えたか
 * v2 は気温も降水も**年平均/年合計しか見ていなかった**。しかしケッペンの
 * 第 3 文字(a/b/c/d)は最暖月、第 2 文字(s/w/f)は最少月/最多月で決まる。
 * 季節を測らない物差しで季節に依る分類の一致率を上げようとしていたため、
 * 「季節振幅が観測に近づいたのに一致率が下がる」ことが実際に起きた
 * (数値の欠陥を直した 2026-08-02 の実測)。
 *
 * ## 無次元化の方針
 * 各誤差は**観測自身の空間ばらつき(面積重み標準偏差)**で割る。
 * モデルの現状誤差で割ると、成績が変わるたびに重みが動いてしまい、
 * 後から都合よく調整する余地が残る。観測側の量なら動かない。
 * 正規化値 1.0 は「気候値を一様に置いたのと同程度の誤差」を意味する。
 *
 * ## 重みの根拠(ケッペンの判定をどれだけ直接決めるか)
 *   年平均気温 4  : A/C/D/E の境界を決める
 *   年較差     4  : a/b/c/d と C/D 境界を決める
 *   季節位相   2  : どの月が最暖/最少になるかを決める
 *   年降水     3  : B(乾燥)の閾値を決める
 *   最少月降水 3  : Af/Am/Aw と s/w を決める
 *   最多月降水 1.5: s/w の比を決める
 *   陸平均偏差 1  : 全球的な偏り
 *   ITCZ 線    1  : 循環の構造(v2 の重みを踏襲)
 *
 * 現状(2026-08-02、数値修正後・再較正前)での減点合計は約 18.8。
 * v2 の減点合計は約 6.9 だったので、**季節を測るぶん約 2.7 倍**重くなる。
 * ケッペン一致率(0〜100)が主目的である点は変えていない。
 */
export const OBJECTIVE_V3 = {
  wTempMean: 4,
  wTempRange: 4,
  wTempPhase: 2,
  wPrecipAnnual: 3,
  wPrecipDriest: 3,
  wPrecipWettest: 1.5,
  wLandMean: 1,
  wItcz: 1,
  /** 位相の基準(日)。1 か月ずれればケッペンの季節が 1 つ動く */
  phaseScaleDays: 30,
  /** ITCZ 線の基準(度)。季節移動 ~10° に対する意味のある割合 */
  itczScaleDeg: 3,
} as const;

// 目的関数 v3(2026-08-02 に事前登録 — 利用者の許可を得て v2 から改訂)。
// v2 も併記のため計算し続ける。v2 の定義は下記のとおり:
//   fitnessV2 = 大分類% + 1.1×地域ゲート数 + 0.25×詳細%
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
  // ---- v2(旧定義)。比較のために必ず計算して併記する ----
  const fitnessV2 =
    k.majorPct +
    1.1 * gateTerm +
    0.25 * k.detailPct -
    0.35 * f.tempRmseC -
    0.004 * f.precipRmseMm -
    (0.02 * Math.abs(f.landMeanModelMm - f.landMeanObsMm)) / 10 -
    0.3 * itczTerm;

  // ---- v3(探索が最大化する量)----
  // 各誤差を**観測自身の空間ばらつき**で割ってから重みを掛ける。
  const W = OBJECTIVE_V3;
  const fitness =
    k.majorPct +
    1.1 * gateTerm +
    0.25 * k.detailPct -
    W.wTempMean * (f.tempRmseC / f.obsSdTempC) -
    W.wTempRange * (f.tempRangeRmseC / f.obsSdTempRangeC) -
    W.wTempPhase * (f.tempPhaseRmseDays / W.phaseScaleDays) -
    W.wPrecipAnnual * (f.precipRmseMm / f.obsSdPrecipMm) -
    W.wPrecipDriest * (f.precipDriestRmseMm / f.obsSdPrecipDriestMm) -
    W.wPrecipWettest * (f.precipWettestRmseMm / f.obsSdPrecipWettestMm) -
    W.wLandMean *
      (Math.abs(f.landMeanModelMm - f.landMeanObsMm) / Math.max(1e-9, f.landMeanObsMm)) -
    W.wItcz * (itczTerm / W.itczScaleDeg);

  return {
    majorPct: k.majorPct,
    detailPct: k.detailPct,
    gates,
    tempRmse: f.tempRmseC,
    precipRmse: f.precipRmseMm,
    landMeanMm: f.landMeanModelMm,
    itczRmse,
    fitness,
    fitnessV2,
    tempRangeRmse: f.tempRangeRmseC,
    tempPhaseRmseDays: f.tempPhaseRmseDays,
    precipDriestRmse: f.precipDriestRmseMm,
    precipWettestRmse: f.precipWettestRmseMm,
  };
}
