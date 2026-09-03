// 自動較正の共有部品: 探索空間と目的関数。
// scripts/optimize.ts(親)と scripts/optimize_worker.ts(評価ワーカー)が使う。
// 採点の実体は scripts/scoring.ts に一元化(P0-3)。ここでは複製しない。

import { MODEL_CONSTANTS } from '../src/sim/constants';
import type { PipelineResult } from '../src/sim/types';
import { fieldScore, itczLineRmse, koppenScore, scoreRegionGates,
  intermediateFieldScore, precipitableWaterScore, REGION_GATES,
} from './scoring';
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
  // v43b(2026-09-02): G の年平均正規化(段 W-1、Ḡ=2.101)後の**換算範囲**。
  // rate = U_ref/L·G_n なので、旧範囲(未正規化 G 向け)を Ḡ で割ると同じ物理の
  // 排水率範囲になる: 海 [1500,3200]/2.101 → [714,1523]、陸 [1100,2400]/2.101 →
  // [524,1143]。v43 は旧範囲のまま走り、既定 714/898 が下限へクリップされて
  // 両 L が下限に張り付いた(実行漏れの訂正。結果を見た拡張ではなく算術付け替え)。
  // v43b 判定(2026-09-03): 換算範囲は向きが逆だった(較正は正規化後も長い L を
  // 選好、陸は新上限 1143 に張り付き)。v42 復帰に伴い旧範囲へ戻す。
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
  // v45(2026-09-03): 上限 0.82→0.95。8/24 の「均す天井」分類は実測と逆で、
  // 0.95 は乾いた端を作る(1% 分位 76→26・詳細 +0.32・雨林無傷)。実物の沈降域は
  // 降水ほぼ 0。docs/事前登録_v45較正_2026-09-03.md / 事前登録_沈降抑制の上限
  ['subsidenceSuppression', 0.5, 0.95],
  ['subsidenceItczProtection', 0.6, 0.95],
  ['eastCoastSubsidenceRelief', 0.5, 0.95],
  // v33(2026-08-24): 上限 1300→2000。亜熱帯高気圧の西縁は大陸内へ 2000〜3000km
  // 及ぶ(湾流〜ミシシッピ、東シナ海〜四川)。3000 は単独掃引で大分類 −0.84 の
  // ため登録規則で 2000 を上限に(docs/事前登録_東岸沈降緩和の減衰距離)
  ['eastCoastSubsidenceDecayKm', 600, 2000],
  // v34(2026-08-24): 沈降の海盆非対称(descW の源泉側)。単独掃引で単調改善・
  // 守り無傷(a 0→0.6: 東岸 descW 0.97→0.74、continuousV3 +0.33、大分類 +0.25、
  // argentina share 0.079→0.159)。docs/事前登録_沈降の海盆非対称_2026-08-24.md
  // v35(2026-08-25): 上限 0.8→0.95。物理根拠 = 海盆西翼に沈降は実在しない
  // (docs/事前登録_海盆非対称の上限拡張_2026-08-25.md)。v34b は 0.8 上限に張り付いた
  ['subsidenceBasinAsymmetry', 0, 0.95],
  ['subsidenceBasinAsymDecayKm', 800, 3000],
  // v35(2026-08-25): 気柱輸送風(監査 #1)。東岸仮説は棄却されたが乾端形成・
  // 内陸輸送のレバーとして登録(docs/事前登録_気柱輸送風の分離 予測 86〜89)
  ['moistureWindSurfaceBlend', 0.4, 1],
  // v35(2026-08-25): 境界層温の緩和時間(海気分離 段 B 改)。位相 −8.3 日
  // (docs/事前登録_境界層温による蒸発 判定)。上限 10 = 境界層の物理スケール
  ['airSurfaceThermalRelaxationDays', 0, 10],
  // v36(2026-08-26): 凝結閉包の二成分化(監査 #3)。c=0.5/τ_bg=60 で
  // 「W 6.8mm かつ分布誤差 基準同等・continuousV3 基準超え」の両立を実証
  // (docs/事前登録_凝結閉包の二成分化 判定 2・予測 114〜115)。
  // τ_bg 上限 90 = 背景凝結が実質オフの側。τ_conv 下限 0.2 = 数時間スケール
  ['condensationClosureBlend', 0, 1],
  // v43(2026-09-02、W 実寸化章): W の熱力学係留(RH フロア)と cap の減算形。
  // 単独掃引で地中海時計 118→61 日・γ で東岸が開く(96 ○)ことを実証済み。
  // docs/事前登録_Wの熱力学係留_2026-09-02.md(予測 84-99)
  ['condensationRhFloor', 0, 0.85],
  ['capLiftSubtractGamma', 0, 1.8],
  // v43b(2026-09-02): 熱風リンク(段 10)。v43 で W が厚くなった後の再訪 —
  // 35-90 冬雨(移入の暦)が残る最大欠損で、これはこの機構の照準そのもの。
  // docs/事前登録_熱風リンク_2026-09-01.md / 実験記録_v43判定_2026-09-02.md
  ['thermalWindFactor', 0, 1.5],
  ['backgroundCondensationTimeDays', 8, 90],
  ['criticalColumnRelativeHumidity', 0.4, 0.95],
  ['convectiveAdjustmentDays', 0.2, 3],
  // v38(2026-08-27): サブグリッド山岳。refSlope=800 は SPACE 外の殺し屋で
  // 機構が 2 年飢えていた(80 でパタゴニア雨陰 PASS・大分類 −0.1 以内)。
  // docs/事前登録_サブグリッド山岳の凝結_2026-08-27.md 判定 2
  ['orographicRefSlope', 80, 800],
  ['orographicCrestBlend', 0, 1],
  // v40(2026-08-31): 段 C-2(2 温度場)。kx = T_s↔T_a 交換(雪 grip で変調)。
  // 酸性試験: kx=15/grip=0.3 でシベリア 1 月 −36.6°C(単一場 −2.5)
  // docs/事前登録_段C2_二温度場_2026-08-31.md
  ['airSurfaceExchangeWm2PerK', 5, 60],
  ['snowGripFactor', 0.1, 1],
  // v41(2026-09-01): 熱的 SLP の復活(段 9 第 2 版 — T_s で入力が初めて本物)。
  // 掃引: 東岸夏流入が初の正転(us −144→+192)・ゲート 17 歴代最多・
  // RMSE 悪化なし。docs/事前登録_温度から気圧への帰還 追記
  ['thermalLowHpaPerK', 0, 2],
  // v42(2026-09-01): 冬雨機構の再訪。8/23 実装時は「G は立つが W が夏のまま」で
  // 不発だったが、T_bl 冬蒸発・凝結閉包・2 温度場の後の掃引で単独 +0.20
  // (地中海型 RMSE 124.8→118.7、巻き添えなし)。掃引最適 4〜6。
  // docs/事前登録_冬雨機構の再訪_2026-09-01.md
  ['winterStormEquatorwardReachDeg', 0, 8],
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
  // v35(2026-08-25): 上限 1.2→1.6(D 類範囲拡張 3 件、docs/事前登録_D類範囲拡張3件)
  ['frontalLiftBoost', 0.4, 1.6],
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
  // v39(2026-08-28): 下限 201→197。段 C-0 で偽熱源(正味 +1.8°C ≈ B×1.8 ≈
  // 4 W/m² 相当)が消えたため、その分を放射切片が引き受け直す算術的必要
  // (結果を見た緩和ではなく、実測した偽熱の消滅分の付け替え)
  ['olrAWm2', 197, 206],
  ['diffusionWm2PerK', 0.45, 0.65],
  ['itczHemisOffsetPerC', 0, 14],
  ['itczOceanFollowDamp', 0.35, 1.0],
  // v27: 下限を 7→4 へ拡張。高所加熱の分母修正の補償で v26 が下端 7 に張り付いた
  // (docs/実験記録_v26判定_2026-08-18.md 発見 3)
  ['itczMonsoonPullDeg', 4, 13],
  // v35(2026-08-25): 上限 14→20(実在のトラフ北上 15〜20°。同上)
  ['itczPlateauPullDeg', 6, 20],
  ['itczSmoothLocalBlend', 0.25, 0.55],
  ['itczDeclinationFollowRatio', 0.28, 0.42],
  ['subtropicalCellEastBoost', 0.3, 0.9],
  // ---- v27 追加(2026-08-18)----
  // 段 46: ITCZ の暦の遅れ。掃引で熱帯の位相系統誤差がほぼ消えた
  // (−28.6→−3.8 日)。0 を含む = 較正が「不要」を選べる
  ['circulationLagMonths', 0, 1.5],
  // 段 45b: モンスーンコンベア。機構の関門は突破(流入が単調増・閉包維持・
  // 分布誤差は改善)。強度と窓の縁の綱引きは較正が決める
  ['conveyorStrength', 0, 60],
  // v28: 段 44 の沈降置換。45c で「コンベアとの組が超相加・豪州巻き添えゼロ」を
  // 実証済み(docs/事前登録_コンベア沈降の組_2026-08-19.md)。単独でも生きる
  ['monsoonTroughSubsRelief', 0, 0.8],
  // v30(2026-08-21): conveyorLatPolewardDeg を復帰。v27〜v28 では基準点
  // strength=0 で死ぬため外していたが、v29 種で conveyor=15 が生き残り
  // 基準点が変わった。ゴビ B→D(45b-2 の分解)を較正が自分で裁ける
  // v35(2026-08-25): 上限 8→12(大気の川の到達緯度。同上)
  ['conveyorLatPolewardDeg', 0, 12],
  // ---- v31 追加(2026-08-21、利用者 FB 由来。docs/事前登録_v31物理バッチ)----
  // ソマリ型湧昇: 単独掃引は全球中立(気温微改善)。価値は局所実在性
  ['somaliUpwellingC', 0, 4],
  // ITCZ の湿った陸への一般化吸引: 単独中立(マダガスカル・メキシコの局所改善)
  ['itczMoistLandPullDeg', 0, 5],
  // 陸面摩擦: 単独では悪化(凝結率と綱引き)— 組み合わせは較正が決める。
  // v32(2026-08-22): 下限 0.6→0.3。観測の陸上 10m 風 2〜4 m/s 対 モデル 7〜9 m/s
  // (係数 ≈ 0.35 相当)に届く範囲にする — 観測事実からの範囲設定で、
  // 結果を見た緩和ではない(事前登録_目的関数v7 追記 1)
  ['landSurfaceFrictionFactor', 0.3, 1],
  ['subpolarWinterLowHpa', 3, 7],
  ['tradeWindMs', 5, 7.5],
  // v44(2026-09-03、段 W-3): 気圧勾配の横断流係数。較正が一度も触れていない
  // SPACE 外の係数で、亜熱帯の発散の 6 割を作り、×0.25 で argentina PASS・
  // east_asia +0.13(東岸の夏の過剰流入の源)。docs/事前登録_発散輸出の監査 追加登録
  ['pressureGradientCrossMsPerHpaPerMm', 0.4, 2.0],
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
  /** 旧目的関数(2026-08-16〜08-17)。併記のため計算し続ける */
  fitnessV4: number;
  /** v5 の値(全球位相 RMSE 版。v6 移行後は併記のみ) */
  fitnessV5: number;
  /** v6 の値(帯別位相版。v7 移行後は併記のみ) */
  fitnessV6: number;
  /** v7b(SST・風の係留まで。v8 併記用) */
  fitnessV7: number;
  /** W(可降水量)の月別 RMSE mm と観測 SD(v8) */
  waterRmseMm: number;
  obsSdWaterMm: number;
  /** v7: SST 偏差 RMSE(°C)と陸上風速 RMSE(m/s)。無次元化前の生値 */
  sstAnomRmseC: number;
  sstSignErrC: number;
  landWindRmseMs: number;
  /** v6 の位相距離: 帯別 RMSE の平均(日) */
  precipPhaseBandMeanDays: number;
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
  /** 降水の季節位相のずれ(日)。v5 で目的関数に入った(2026-08-17) */
  precipPhaseRmseDays: number;
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

/**
 * 目的関数 v5(2026-08-17、利用者裁定「物差しを先に」→ 事前登録
 * docs/事前登録_目的関数v5_降水位相_2026-08-17.md)。
 *
 * v4 からの追加は 1 項だけ: **降水の季節位相**(雨季の時期のずれ、日)。
 * 2026-08-09 の外部レビュー 2 件がそろって指摘し、採点には実装済みだったのに
 * 目的関数に入っていなかった(現在 71.9 日 ≒ 2.4 か月ずれで無罰。
 * ケッペンの第 2 文字は雨季の時期で決まるので、最大失点源 C→B と直結)。
 * 重みと規格化は気温位相と同じ(2 / 30 日)— 対称性だけで決め、
 * 現状値を見た調整はしない。
 */
export const OBJECTIVE_V5 = {
  ...OBJECTIVE_V4,
  wPrecipPhase: 2,
} as const;

/**
 * 目的関数 v6(2026-08-19 に事前登録)。v5 との違いは**位相の距離だけ**:
 * 全球一本の RMSE(冬雨型少数派が二乗和を独裁し、熱帯の雨季を正しく
 * しても報酬しない — v27 で実測)を、帯別 RMSE の平均に置換する。
 * 重み(wPrecipPhase=2 / 30 日)は動かさない。
 * 事前登録: docs/事前登録_目的関数v6_位相の帯別化_2026-08-19.md
 */
export const OBJECTIVE_V6 = {
  ...OBJECTIVE_V5,
} as const;

/**
 * 目的関数 v7(2026-08-22 に事前登録)。v6 + **中間場の係留** 2 項:
 * SST 偏差(対 NOAA OI SST)と陸上 10m 風速(対 NCEP/NCAR R1)。最終地図しか
 * 見ない物差しは途中の場が嘘でも報酬する(偽寒流への依存 −0.53)ので、
 * 途中の場を観測に係留する。重みは wTempMean との対称性(4)で決め、
 * 現状値を見た調整はしない。
 * 事前登録: docs/事前登録_目的関数v7_中間場の係留_2026-08-22.md
 */
export const OBJECTIVE_V7 = {
  ...OBJECTIVE_V6,
  wSstAnom: 4,
  wLandWind: 4,
} as const;

/**
 * 目的関数 v8(2026-08-26)= v7b + W(可降水量)の係留 1 項。
 * v7 は SST・風を係留したが W を採点せず、「W=4mm の非物理解でも分布を
 * 均せば報酬」の穴が残った(監査指摘 + v35 で τ 機構が捨てられた実測)。
 * 重みは wTempMean と同値の対称性で決め、現状値を見た調整はしない。
 * 事前登録: docs/事前登録_目的関数v8_Wの係留_2026-08-26.md
 */
export const OBJECTIVE_V8 = {
  ...OBJECTIVE_V7,
  wPrecipWater: 4,
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
  // v7: 中間場(海流 SST 偏差・陸上風速)。保留区画は未対応(全球で測る)
  const im = intermediateFieldScore(result);
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
    // ゲート集合 v2(2026-08-24)で 17→21 件になったため、正規化定数は
    // ハードコードせず総数に追随させる(全球較正との尺を揃える意図は不変)
    gateTerm = (REGION_GATES.length * gates) / Math.max(1, training.length);
    // 連続版も同じ規則で正規化する(fold ごとに訓練地域数が違うため)
    gateShareTerm =
      (REGION_GATES.length * training.reduce((s, g) => s + g.share, 0)) /
      Math.max(1, training.length);
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
  const W = OBJECTIVE_V8;
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
  const fitnessV4 =
    continuousV3 + 1.1 * gateShareTerm - W.wPrecipQuantile * f.precipQuantileLogErr;

  // ---- v5(2026-08-17。以後は併記のみ)----
  // v4 に降水の季節位相(全球 RMSE)を足した。
  const fitnessV5 = fitnessV4 - W.wPrecipPhase * (f.precipPhaseRmseDays / W.phaseScaleDays);

  // ---- v6(2026-08-19。以後は併記のみ)----
  // 位相の距離を帯別 RMSE の平均へ置換。それ以外は v5 と同一。
  const fitnessV6 = fitnessV4 - W.wPrecipPhase * (f.precipPhaseBandMeanDays / W.phaseScaleDays);

  // ---- v7(探索が最大化する量。2026-08-22 の事前登録)----
  // v6 + 中間場の係留(SST 偏差・陸上風速、観測 SD で無次元化)。
  // v7b(2026-08-22 追記 3): SST 項に符号矛盾 RMSE を同じ重みで加える。
  // 全球 RMSE では縁海の偽寒流の罰が 0.05 点に希釈された(旧物理が +0.40 勝つ)
  const fitnessV7 =
    fitnessV6 -
    W.wSstAnom * (im.sstAnomRmseC / Math.max(1e-9, im.obsSdSstAnomC)) -
    W.wSstAnom * (im.sstSignErrC / Math.max(1e-9, im.obsSdSstAnomC)) -
    W.wLandWind * (im.landWindRmseMs / Math.max(1e-9, im.obsSdLandWindMs));
  // ---- v8(2026-08-26 の事前登録)= v7b + W の係留 ----
  // **酸性試験 3 本 ✗ のため有効化は保留**(判定: W 項は系統バイアスで飽和
  // しており、固定 λ の即時降雨が W の動的応答を殺している。凝結閉包
  // (台帳 22)が物理側の前提)。閉包実装後に酸性試験を再走してから有効化。
  const pw = precipitableWaterScore(result);
  const fitnessV8 =
    fitnessV7 - W.wPrecipWater * (pw.waterRmseMm / Math.max(1e-9, pw.obsSdWaterMm));
  const fitness = fitnessV7;
  void fitnessV8;

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
    fitnessV4,
    fitnessV5,
    fitnessV6,
    fitnessV7,
    waterRmseMm: pw.waterRmseMm,
    obsSdWaterMm: pw.obsSdWaterMm,
    sstAnomRmseC: im.sstAnomRmseC,
    sstSignErrC: im.sstSignErrC,
    landWindRmseMs: im.landWindRmseMs,
    precipPhaseBandMeanDays: f.precipPhaseBandMeanDays,
    precipPhaseRmseDays: f.precipPhaseRmseDays,
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
