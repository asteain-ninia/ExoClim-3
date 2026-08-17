// 自動較正の共有部品: 探索空間と目的関数。
// scripts/optimize.ts(親)と scripts/optimize_worker.ts(評価ワーカー)が使う。
// 採点の実体は scripts/scoring.ts に一元化(P0-3)。ここでは複製しない。

import { MODEL_CONSTANTS } from '../src/sim/constants';
import type { PipelineResult } from '../src/sim/types';
import { fieldScore, itczLineRmse, koppenScore, scoreRegionGates } from './scoring';
import { gateFoldAssignments, keepExcludingFold } from './holdout';
import { EBM_SOLVER_STATS } from '../src/sim/step05_temperature';
import { CONSERVATIVE_STATS } from '../src/sim/step06_precipitation';
import { evaluateNumericalSoundness } from './validate_criteria';

export const SPACE: Array<[keyof typeof MODEL_CONSTANTS, number, number]> = [
  // ---- 保存型への移行(段 6、2026-08-09)----
  // 消した定数と理由:
  //   precipScaleMmPerUnit  保存則の中に置き場所が無い(降水量は収支が決める)
  //   orographicDepletionM  段 2 で外して悪化しなかった(保存の欠落を補っていた)
  //   upwindBlockReliefM    段 3 で外したら**改善した**(詳細 +0.59)。
  //   upwindBlockFloor      風上で降ったぶんは収支で既に減っており、二重に乾かしていた
  // 残した定数:
  //   eastCoastSubsidenceRelief  段 4 で外したら悪化(大分類 −0.63)。
  //                              柱収支から出ない物理を代弁している
  //   moistureDecay*Km           保存型では**凝結寿命 λ = U_ref/L そのもの**。
  //                              外す対象ではない(段 5 の実験は設計が誤っていた)
  // 新しく効くようになった定数(範囲は物理から決めた。目的関数は見ていない):
  ['condensationRefWindMs', 4, 14],
  ['moistureEddyDiffusivityM2PerS', 5e5, 3e6],
  // **evap 系は入れない。** 源泉を目的関数で動かせるようにすると、保存則が
  // 「源泉の誤りを増幅する装置」から「源泉の誤りを隠す装置」へ変わる。
  // C_E = 1.0e-3 と海上相対湿度 0.8 は S2 で独立に検証して固定した
  ['moistureDecayOceanKm', 1500, 3200],
  ['moistureDecayLandKm', 1100, 2400],
  ['landRecyclingStrength', 0.2, 0.6],
  ['itczLiftBoost', 1.4, 3.2],
  // **範囲を [0.6, 1.8] → [0.5, 18] へ引き直した(2026-08-17)。**
  // 旧範囲は保存型移行後の供給の分布(5% 分位 0.63 / 中央 7.4 / 95% 19.3)の
  // 下に沈み、ゲートが 95% 常時飽和 = 死んだ範囲だった。掃引で norm 12 のとき
  // 連続部分 +0.09・分位誤差 −0.022・1% 分位 −7mm を確認(インド −0.05 の
  // トレードオフあり — その匙加減を較正に委ねる)。
  // docs/実験記録_ゲート復活と幾何の掃引_2026-08-17.md
  ['itczLiftSupplyNorm', 0.5, 18],
  ['stormTrackBoost', 0.4, 1.1],
  ['stormTrackWinterBoost', 0.15, 0.6],
  ['orographicBoost', 0.9, 2.5],
  ['rainShadowFloor', 0.2, 0.55],
  ['subsidenceSuppression', 0.5, 0.82],
  ['subsidenceItczProtection', 0.6, 0.95],
  ['eastCoastSubsidenceRelief', 0.5, 0.95],
  ['eastCoastSubsidenceDecayKm', 600, 1300],
  // **外した(2026-08-17)**: 範囲 [0.4, 1.2] は供給の分布の下に沈んで
  // ゲートが 96% 常時飽和(死んだ範囲)。掃引で生かすと東岸緩和が絞られて
  // **本丸の C→B 地域(米南東・東アジア)が乾く**逆効果と確認。
  // 現行値 0.51(実質ゲート無効)で固定する。アラビア防護の再設計は
  // モンスーンコンベア(段 45)側の課題。
  // docs/実験記録_ゲート復活と幾何の掃引_2026-08-17.md
  // ['eastReliefSupplyNorm', 0.4, 1.2],
  // **外した(2026-08-17、段 6 の移行漏れ)**: ストーム供給の 3 定数は
  // `stormSupply` が非保存の降水式にしか入っておらず、保存型の源にも凝結率にも
  // 現れないため、**答えに 1 ビットも影響しない**。2026-08-16 の生存性診断で
  // 61 定数を全数測って確認済み(`docs/探索空間の生存性.json`)。
  // 較正はこの 3 定数を振り続け、評価の約 5% を空振りに使っていた。
  // **外すより繋ぐほうが筋**なので、繋いだら戻すこと:
  //   docs/診断_ストーム供給は保存型で死んでいる_2026-08-15.md
  // ['stormMinQRel', 0.25, 0.55],
  // ['stormMoistureSupply', 1.0, 2.4],
  // ['stormMoistureDecayKm', 1000, 2000],
  ['coldCoastSuppression', 0.25, 0.6],
  ['winterFloorFracOfWettest', 0.2, 0.5],
  ['winterFloorMaxMm', 12, 34],
  ['equatorialItczResidual', 0.3, 0.8],
  ['frontalLiftBoost', 0.4, 1.2],
  ['precipMonthBlend', 0.04, 0.2],
  ['warmHumidConvectiveBoost', 0, 0.4],
  // **外した(2026-08-17、親が 0)**: `warmHumidConvectiveBoost` を較正が 0 まで
  // 押し下げた結果、`warmHumidF = 1 + 0 × …` で固定になり、この正規化定数は
  // 答えに影響しなくなった。**較正は自分で殺した機構の正規化定数を振り続けていた。**
  // 親を生き返らせるなら一緒に戻すこと。
  // ['warmHumidSupplyNorm', 2.0, 4.0],
  ['subsidenceCloudReduction', 0.5, 0.75],
  ['subsidenceOceanFactor', 0.25, 0.5],
  ['convectiveCloudBoost', 0.3, 0.6],
  ['stormTrackCloudBoost', 0.4, 0.8],
  ['cloudAlbedoMax', 0.36, 0.46],
  ['stormCloudSummerOcean', 0.5, 0.85],
  ['itczCloudWidthFactor', 0.7, 1.1],
  ['stratocumulusBoostPerNegC', 0.35, 0.75],
  // 陸の対流雲の飽和量(mm/月)。**強さ landCloudBoost は敢えて入れていない。**
  // v3 は boost を上げると単調に下がる(大分類が落ちるため)ので、探索空間へ
  // 入れると座標降下が真っ先に 0 へ戻す — 他の定数が補償を見つける前に。
  // 「座標降下は谷を渡れない」(教訓 §9)の典型なので、強さは構造として固定し、
  // **効く場所の分布だけ**を較正に決めさせる。
  ['landCloudSupplyNormMm', 40, 200],
  ['channelCloudBoost', 0.35, 0.8],
  ['circumpolarChannelFactor', 0.2, 0.5],
  ['winterInversionAdvectionFactor', 0.35, 0.7],
  ['winterInversionDiffusionFactor', 0.5, 0.85],
  ['hadleyDiffusionBoost', 0.5, 1.2],
  ['zonalAdvectionCouplingWm2PerK', 30, 60],
  ['summerAdvectionFactor', 0.3, 0.6],
  ['seaIceInsulationFactor', 0.8, 0.95],
  // 海氷の被覆率が飽和する氷量。アルベドと断熱の**効く範囲**を決める。
  // 強さに当たる物性値(伝導率・潜熱)は物理定数なので入れない
  ['seaIceCoverScaleMm', 100, 800],
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
  // **段 38(2026-08-15): westerlyWindMs を探索空間から外した。**
  // 較正はこの定数を範囲の**下端 6.5 に張り付かせていた**(目的関数が
  // 「均す」方向を報酬にしているため。
  //  docs/診断_較正が探索空間の端に張り付いている_2026-08-15.md)。
  // だが偏西風は**中位の陸を湿らせられる唯一の手**であり(段 32)、
  // 9.0 にすると中位の分位が 468 → 501 へ動く。
  // 探索空間に残すと較正が 6.5 へ戻すので、**9.0 に固定して他を最適化する**。
  // ['westerlyWindMs', 6.5, 9],
];

/**
 * 数値的に解けなかった評価に与える不適合度。
 * 較正が「収束しない領域」へ逃げ込むのを防ぐ(未収束は歴史的に成績を
 * よく見せる方向に働く — GS_SWEEPS の件)。**棄却であって減点ではない**。
 */
export const UNSOLVED_FITNESS = -1e6;

/**
 * 数値的に解けなかった評価を失格にする。**評価する側の経路すべてで呼ぶ。**
 *
 * 2026-08-14 まで、失格の判定は `optimize_worker.ts` の 1 行
 * (`EBM_SOLVER_STATS.capHits > 0`)だけで、**5 系統のうち 1 系統しか
 * 見ていなかった**。しかも逐次経路(`--parallel 1`)には判定が 1 つも無く、
 * 完全に無防備だった。判定を 1 か所へ集約して、経路差を無くす。
 */
export function disqualifyIfUnsound(scores: Scores): Scores {
  if (!scores.numericallySound) scores.fitness = UNSOLVED_FITNESS;
  return scores;
}

export interface Scores {
  majorPct: number;
  detailPct: number;
  gates: number;
  tempRmse: number;
  precipRmse: number;
  landMeanMm: number;
  itczRmse: number;
  /** 目的関数 v3(探索が最大化する量) */
  /** 探索が最大化する量。2026-08-16 以降は v4 */
  fitness: number;
  /** 旧目的関数(2026-08-02〜08-16)。併記のため計算し続ける */
  fitnessV3: number;
  /**
   * ゲート項を除いた連続部分(v3 と v4 で共通)。
   * **目的関数の版をまたいで比べられる唯一の量**なので、
   * 版を変えた前後の比較は必ずこれで行う。
   */
  continuousV3: number;
  /** 期待する気候帯の面積割合の和(0〜17、連続版ゲート) */
  gateShare: number;
  /** 年降水の分布形の誤差(分位の平均対数誤差) */
  precipQuantileLogErr: number;
  /** その内訳 [分位%, モデル mm, 観測 mm] */
  precipQuantiles: Array<[number, number, number]>;
  /** 目的関数 v2(旧定義。比較のために必ず併記する) */
  fitnessV2: number;
  /**
   * **数値的に健全か**(2026-08-14)。`npm run validate` が使うのと
   * まったく同じ凍結済みの関門(`evaluateNumericalSoundness`)で判定する。
   *
   * これが無かったため、較正は 5 系統の収束のうち **EBM の上限到達しか
   * 見ていなかった**(しかも逐次経路では 1 つも見ていなかった)。
   * 未収束の解にも成績はつくので、探索は「収束しない領域」へ逃げ込める。
   * 実測: 鋭さ 4(結合反復の残差が許容の 233 倍)の v3 は 81.781 で、
   * 収束している鋭さ 2 の 78.251 より**良い**。
   */
  numericallySound: boolean;
  /** 健全でないときの理由(ログに残して原因を追えるようにする) */
  numericalFailures: string[];
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

/**
 * 目的関数 v4(2026-08-16、利用者の裁定「GO」を得て事前登録 →
 * `docs/事前登録_目的関数v4_ゲートの崖を外し分布形を入れる_2026-08-16.md`)。
 *
 * v3 からの変更は 2 点だけ:
 *   1. **地域ゲートを離散(合格件数)から連続(面積割合の和)へ**。
 *      外部監査に「50%・10% に崖があり、崖を一つ越えただけの解が
 *      採用されている」と指摘され、v23 の採用を分解して裏が取れた
 *      (ゲート +1.10 に対し、他の連続指標は約 −0.031 悪化していた)。
 *      上限は 17 のままなので**重み 1.1 は据え置く**。
 *   2. **年降水の分布形の項を足す**。本丸である「乾いた端が作れない」
 *      (1% 分位がモデル 64mm 対 観測 9mm)を、目的関数が
 *      まったく測っていなかった。測っていないものは直らない。
 */
export const OBJECTIVE_V4 = {
  ...OBJECTIVE_V3,
  /** 分布形の重み。年降水 RMSE と同じ 3。**現状値を測る前に決めた** */
  wPrecipQuantile: 3,
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
  /** v2・v3 が使う離散のゲート項(合格件数) */
  let gateTerm: number;
  /** v4 が使う連続のゲート項(期待する気候帯の面積割合の和) */
  let gateShareTerm: number;
  let itczTerm: number;
  if (gateFolds === null) {
    gates = gateResults.filter((g) => g.pass).length;
    gateTerm = gates;
    gateShareTerm = gateResults.reduce((s, g) => s + g.share, 0);
    itczTerm = itczRmse;
  } else {
    const training = gateResults.filter((g) => gateFolds[g.id] !== holdoutFold);
    gates = training.filter((g) => g.pass).length;
    gateTerm = (17 * gates) / Math.max(1, training.length);
    // 連続版も同じ規則で正規化する(fold ごとに訓練地域数が違うため)
    gateShareTerm =
      (17 * training.reduce((s, g) => s + g.share, 0)) / Math.max(1, training.length);
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

  // ---- v3(2026-08-02〜2026-08-16 に探索が最大化していた量。以後は併記のみ)----
  // 各誤差を**観測自身の空間ばらつき**で割ってから重みを掛ける。
  const W = OBJECTIVE_V4;
  /** ゲート項を除いた連続部分。v3 と v4 で共通なので一度だけ組む */
  const continuousV3 =
    k.majorPct +
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
  const fitnessV3 = continuousV3 + 1.1 * gateTerm;

  // ---- v4(探索が最大化する量。2026-08-16 の事前登録)----
  // ゲートを連続化し、年降水の分布形を足した。それ以外は v3 と同一。
  const fitness =
    continuousV3 + 1.1 * gateShareTerm - W.wPrecipQuantile * f.precipQuantileLogErr;

  // ---- 数値的健全性(2026-08-14)----
  // `npm run validate` と**同じ凍結済みの関門**を使う。判定の二重定義を作らない。
  // 収束を要する反復は 5 系統ある: EBM の線形解 / EBM の周期定常 /
  // 結合反復 / 土壌の周期定常 / 輸送(と virga)。
  const soundness = evaluateNumericalSoundness({
    ebmMaxResidualC: EBM_SOLVER_STATS.maxResidualC,
    ebmMeanYearDriftC: EBM_SOLVER_STATS.meanYearDriftC,
    precipCouplingConverged: result.precipitation.coupling?.converged ?? true,
    soilConverged: result.precipitation.soil?.converged ?? true,
    moistureTransportNonConverged: CONSERVATIVE_STATS.nonConverged,
    virgaNonConverged: CONSERVATIVE_STATS.virgaNonConverged,
  });

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
    fitnessV3,
    /** ゲート項を除いた連続部分。目的関数をまたいで比べられる唯一の量 */
    continuousV3,
    gateShare: gateShareTerm,
    precipQuantileLogErr: f.precipQuantileLogErr,
    precipQuantiles: f.precipQuantiles,
    numericallySound: soundness.pass,
    numericalFailures: soundness.failures,
    tempRangeRmse: f.tempRangeRmseC,
    tempPhaseRmseDays: f.tempPhaseRmseDays,
    precipDriestRmse: f.precipDriestRmseMm,
    precipWettestRmse: f.precipWettestRmseMm,
  };
}
