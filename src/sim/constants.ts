// モデル較正定数。docs/方針.md §3「パラメータの二層化」に基づき、
// 利用者パラメータ(src/domain/planetParams.ts)とは区別する。
// 各定数の根拠は docs/spec/ の該当節に記載。地球検証(npm run validate)で較正し、
// 較正後は原則固定。**利用者スライダーにしない。**

export const MODEL_CONSTANTS = {
  // ---- Step 5 気温 EBM (docs/spec/05_気温.md) ----
  /**
   * 外向き長波放射 OLR = olrA + olrB·T の切片(W/m²、T=0°C 時)。
   * Budyko 系の初期値 208 から、輸送・雲構造確定後に全球平均 14.5°C へ再較正。
   */
  olrAWm2: 203,
  /** OLR の温度感度(W/m²/°C)。水蒸気フィードバック込みの実効値 */
  olrBWm2PerC: 2.1,
  /** 温室効果強度 g に対する OLR 低下(W/m² per log2(g)) */
  greenhouseDeltaAWm2: 22,
  /**
   * 南北拡散熱輸送係数(W/m²/K、単位球面ラプラシアン基準)。極向き熱輸送の主役
   * (傾圧渦)を表し、帯状平均の子午面プロファイルを支配する。
   */
  diffusionWm2PerK: 0.55,
  /**
   * 東西拡散の倍率(南北比)。等方にすると高緯度の計量 1/cos²φ が大陸規模の
   * 季節モードを潰す(較正ログ 2026-07-29: シベリア振幅 1/3 事件)。
   * 東西の実輸送は移流結合(zonalAdvectionCoupling)が担う。
   */
  zonalDiffusionFactor: 0.12,
  /** 東西計量 1/cos²φ の上限(これ以上は高緯度でも増幅しない) */
  zonalMetricCap: 2.0,
  /** 海上の拡散増強倍率(海流・大気湿潤輸送の実効差) */
  oceanDiffusionBoost: 1.2,
  /**
   * ハドレー域(リッジ内側)の南北拡散増強。等方拡散 EBM は熱帯を単調減少に
   * してしまうが、実物はハドレー循環が |lat|<25° を平坦に均す。
   */
  hadleyDiffusionBoost: 1.1,
  /** 周極海峡と見なす緯度行の陸面積率の上限と適用緯度上限(極海の氷蓋下は対象外) */
  channelLandFracMax: 0.04,
  channelMaxAbsLatDeg: 70,
  /**
   * 陸の実効熱容量(水等価深さ m、大気込み)。実大陸の位相遅れ ≈ 27 日
   * (ωτ ≈ 0.5)から τ = C/B で逆算した値。大きすぎると季節振幅が消えて
   * 冷帯 D が生成できない(較正ログ 2026-07-29)。
   */
  landEffectiveWaterDepthM: 1.2,
  /** 地表アルベド: 陸(雲込みの惑星値 ≈ 0.30 相当。植生・土壌の平均) */
  albedoLand: 0.12,
  /** 地表アルベド: 海 */
  albedoOcean: 0.07,
  /**
   * 地表アルベド: 季節雪氷(森林マスキング・融解を織り込んだ実効値)。
   * 高くすると融雪が日射最大期に食い込み北半球の夏が壊れる(較正ログ)。
   */
  albedoIce: 0.33,
  /** 雪氷アルベドへの遷移開始温度(°C、陸)と遷移幅(°C) */
  iceOnsetC: -6,
  iceRampWidthC: 5,
  /** 恒常氷床の地表アルベドと判定(パス1の年平均・最暖月の複合条件) */
  permanentIceAlbedo: 0.62,
  permanentIceAnnualMeanC: -8,
  permanentIceWarmestMonthC: 2,
  /**
   * 周極海峡(陸を含まない緯度行)を跨ぐ南北拡散の低減率。
   * 遮られない地衡流水路は南北熱交換を抑える(南極周極流の効果、地理中立)。
   */
  circumpolarChannelFactor: 0.45,
  /** 雲アルベドの循環変調: 沈降域(亜熱帯高圧帯)での低減率と ITCZ での増加率 */
  subsidenceCloudReduction: 0.55,
  /** 沈降晴天の海上での効き(貿易風積雲・層積雲が残るため陸より弱い) */
  subsidenceOceanFactor: 0.45,
  convectiveCloudBoost: 0.45,
  /** ストームトラック帯(海上)の雲増加率と雲アルベド上限 */
  stormTrackCloudBoost: 0.6,
  cloudAlbedoMax: 0.36,
  /** 寒流(SST 負偏差)上の層積雲デッキ: 偏差 -2°C で雲 +この比率 */
  stratocumulusBoostPerNegC: 0.35,
  /** 冬(月日射 < 年平均)の陸上における移流結合の低減率(接地逆転層) */
  winterInversionAdvectionFactor: 0.5,
  /** 周極海峡行の海洋混合層の増深倍率(遮られない流路の深い鉛直混合) */
  channelMixedLayerBoost: 3.0,
  /** 気温減率(°C/km、標高降尺度と OLR 標高補正に使用) */
  lapseRateCPerKm: 5.8,
  /** 海流 SST 偏差を EBM に注入する結合係数(W/m²/K) */
  sstAnomalyCouplingWm2PerK: 18,
  /**
   * 帯状移流の地表結合(W/m²/K、基準風速 4 m/s 時)。大気が上流の温度を運び、
   * 地表と有限の強さで熱交換する表現。セル熱容量に移流を掛けると海面が風速で
   * 流される誤った物理になる(較正ログ 2026-07-29)。到達距離 ≈ 結合/(B+Dk²)
   * 換算で 1500〜2500 km 相当。
   */
  zonalAdvectionCouplingWm2PerK: 40,
  /** EBM 積分年数と 1 年のステップ数 */
  ebmYears: 4,
  ebmStepsPerYear: 240,
  /** EBM 格子分解能(度) */
  ebmResolutionDeg: 2,

  // ---- Step 1 ITCZ (docs/spec/01_ITCZ.md) ----
  /** 熱赤道の赤緯追従率(海上基準) */
  itczDeclinationFollowRatio: 0.35,
  /** 大陸モンスーンによる追加引き寄せ(度、夏半球の陸割合 1.0 のとき) */
  itczMonsoonPullDeg: 10,
  /**
   * 高所加熱によるモンスーン増強(帯内の陸平均標高 1km あたりの引き寄せ倍率増)。
   * チベット高原型の熱源が水蒸気トラフを大きく北上させる効果(WL#32 の趣旨)。
   */
  itczMonsoonElevBoostPerKm: 0.55,
  /** ITCZ 影響帯の半幅(度) */
  itczHalfWidthDeg: 9,
  /** 経度方向平滑化の半幅(度)。広すぎるとモンスーンの経度応答が希釈される */
  itczSmoothingHalfWidthDeg: 12,

  // ---- Step 2 風帯 (docs/spec/02_風帯.md) ----
  /** 亜熱帯高圧帯(ハドレー端)の基準緯度(地球自転時) */
  hadleyEdgeBaseDeg: 31,
  /** 自転周期に対するハドレー端のスケーリング指数(P^n) */
  hadleyRotationExponent: 0.35,
  /** 季節シフト振幅(度、赤緯正規化 1 あたり) */
  ridgeSeasonalShiftDeg: 6,
  /** 極前線の基準緯度 */
  polarFrontBaseDeg: 60,
  /** 亜熱帯高気圧の振幅(hPa) */
  subtropicalHighHpa: 6,
  /** 大陸熱的高低気圧の振幅(hPa、内陸度 1・季節振幅最大時) */
  continentalThermalHpa: 9,
  /** ITCZ トラフの深さ(hPa) */
  itczTroughHpa: 5,
  /** モンスーントラフの増深: 経度列の熱帯陸割合 1.0 でトラフを +この倍率 */
  monsoonTroughDeepening: 0,

  // ---- Step 3 海流 (docs/spec/03_海流.md) ----
  /** 西岸境界流(大陸東岸沖)の暖偏差(°C) */
  warmBoundaryCurrentC: 3.0,
  /** 東岸境界流(大陸西岸沖)の寒偏差(°C) */
  coldBoundaryCurrentC: -2.2,
  /** 高緯度へ届く暖流吹送域の暖偏差(°C、海盆東端で最大) */
  warmDriftC: 3.2,
  /** 高緯度の海盆西端の寒流偏差(°C) */
  coldReturnC: -1.5,
  /** 赤道湧昇の寒偏差(°C、海盆東側) */
  equatorialUpwellingC: -1.2,
  /** 境界流の海岸からの届き幅(km) */
  boundaryCurrentReachKm: 900,

  // ---- Step 4 気流 (docs/spec/04_気流.md) ----
  /** 貿易風・偏西風・極東風の基準風速(m/s) */
  tradeWindMs: 6,
  westerlyWindMs: 7.5,
  polarEasterlyMs: 3,
  /** 気圧勾配風の結合係数(m/s per hPa/1000km): 回転成分と横断成分 */
  pressureGradientRotationalMsPerHpaPerMm: 3.2,
  pressureGradientCrossMsPerHpaPerMm: 1.6,

  // ---- Step 6 降水 (docs/spec/06_降水.md) ----
  /** 水蒸気供給の海上減衰距離(km) */
  moistureDecayOceanKm: 3000,
  /** 陸上減衰距離(km、再循環なしの素の値) */
  moistureDecayLandKm: 1400,
  /** 陸面再蒸発の強さ(0〜1、二回目のパスで局所降水に比例) */
  landRecyclingStrength: 0.75,
  /** 風上追跡の最大距離(km) */
  moistureTraceMaxKm: 5200,
  /**
   * Fetch 則(WL#32): 閉じた内海・湖(面積 < 1.2M km² の海成分)の湿潤が
   * 内陸へ届く距離 = その水域の風上幅(Fetch)。この値はその実効上限。
   * 外洋(海峡で繋がる縁辺海を含む)は対象外で、到達は減衰長が決める。
   */
  fetchOpenOceanCapKm: 2000,
  /** ITCZ 収束の降水増幅(中心で ×(1+この値)) */
  itczLiftBoost: 2.2,
  /** ストームトラック(温帯低気圧帯)の増幅 */
  stormTrackBoost: 1.1,
  /** 寒候期のストームトラック追加増幅 */
  stormTrackWinterBoost: 0.5,
  /** 地形性上昇の増幅(基準勾配あたり) */
  orographicBoost: 1.6,
  /** 風下雨陰の最大抑制(0〜1 が残存率の下限) */
  rainShadowFloor: 0.35,
  /** 亜熱帯高圧帯(沈降域)の抑制率(0〜1)。下降枝全域(リッジ−16°〜+5°)に適用 */
  subsidenceSuppression: 0.68,
  /** 沈降抑制に対する ITCZ 影響の防護係数(1 = 完全防護) */
  subsidenceItczProtection: 0.85,
  /**
   * 亜熱帯高気圧の西翼(大陸東岸側)の湿潤化: 順行自転では東に海が近いセルほど
   * 沈降抑制を緩める(バミューダ高気圧西縁の湿潤流の相当物)。減衰距離 km。
   */
  eastCoastSubsidenceRelief: 0.8,
  eastCoastSubsidenceDecayKm: 900,
  /** 寒候期でも残る前線性の最低水蒸気(qRel の下限。弱い前線雪の表現) */
  stormMinQRel: 0.3,
  /** 高温湿潤の陸での対流性増幅(T≥22°C かつ供給豊富で最大 +この倍率) */
  warmHumidConvectiveBoost: 0,
  /** 夏半球の偏西風移流の弱化率(ジェットの季節弱化) */
  summerAdvectionFactor: 0.42,
  /**
   * ストームトラック帯の渦による水蒸気供給(月平均風では運べない移動性低気圧の
   * 混合を表す)。海岸距離の減衰長と強度。derle 教訓 §8.2「月平均風だけでは
   * 中緯度の冬雨・内陸湿潤が出ない」への対応。
   */
  stormMoistureSupply: 0.8,
  stormMoistureDecayKm: 1400,
  /** 風上山脈による遮蔽: この比高(m)以上で最大遮蔽、遮蔽時の残存率 */
  upwindBlockReliefM: 1200,
  upwindBlockScanKm: 900,
  upwindBlockFloor: 0.3,
  /** 寒流沿岸の追加抑制率 */
  coldCoastSuppression: 0.45,
  /** 全球スケール係数(供給×持ち上げ → mm/月) */
  precipScaleMmPerUnit: 9.0,

  // ---- 共通 ----
  /** 海面凍結温度(°C) */
  seaFreezeC: -1.9,
} as const;

export type ModelConstants = typeof MODEL_CONSTANTS;
