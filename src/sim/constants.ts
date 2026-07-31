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
  olrAWm2: 203.5,
  /** OLR の温度感度(W/m²/°C)。水蒸気フィードバック込みの実効値 */
  olrBWm2PerC: 2.1,
  /** 温室効果強度 g に対する OLR 低下(W/m² per log2(g)) */
  greenhouseDeltaAWm2: 22,
  /**
   * 南北拡散熱輸送係数(W/m²/K、単位球面ラプラシアン基準)。極向き熱輸送の主役
   * (傾圧渦)を表し、帯状平均の子午面プロファイルを支配する。
   */
  diffusionWm2PerK: 0.5484,
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
  hadleyDiffusionBoost: 0.7244,
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
  albedoIce: 0.3552,
  /** 雪氷アルベドへの遷移開始温度(°C、陸)と遷移幅(°C) */
  iceOnsetC: -6,
  iceRampWidthC: 5,
  /** 恒常氷床の地表アルベドと判定(パス1の年平均・最暖月の複合条件) */
  permanentIceAlbedo: 0.612,
  permanentIceAnnualMeanC: -8,
  permanentIceWarmestMonthC: 2,
  /**
   * 周極海峡(陸を含まない緯度行)を跨ぐ南北拡散の低減率。
   * 遮られない地衡流水路は南北熱交換を抑える(南極周極流の効果、地理中立)。
   */
  circumpolarChannelFactor: 0.374,
  /**
   * 周極海峡行の海上の雲増強(実在の南大洋は惑星で最も雲が多い海域。
   * 遮られない西風の吹送距離 → 常時ストーム雲。トポロジー判定で地理中立)
   */
  channelCloudBoost: 0.667,
  /** 雲アルベドの循環変調: 沈降域(亜熱帯高圧帯)での低減率と ITCZ での増加率 */
  subsidenceCloudReduction: 0.6038,
  /** 沈降晴天の海上での効き(貿易風積雲・層積雲が残るため陸より弱い) */
  subsidenceOceanFactor: 0.37,
  convectiveCloudBoost: 0.4546,
  /** ストームトラック帯(海上)の雲増加率と雲アルベド上限 */
  stormTrackCloudBoost: 0.584,
  cloudAlbedoMax: 0.4,
  /** 夏半球のストーム雲の海上残存率(陸側ジェットは弱まるが海は夏も曇天) */
  stormCloudSummerOcean: 0.7507,
  /** 雲変調に使う ITCZ 幅の倍率(実物の雲帯は降水影響圏より狭い) */
  itczCloudWidthFactor: 0.778,
  /** 寒流(SST 負偏差)上の層積雲デッキ: 偏差 -2°C で雲 +この比率 */
  stratocumulusBoostPerNegC: 0.574,
  /** 冬(月日射 < 年平均)の陸上における移流結合の低減率(接地逆転層) */
  winterInversionAdvectionFactor: 0.35,
  /**
   * 冬の接地逆転層は移流だけでなく拡散(自由大気との混合)も絶縁する。
   * 内陸度 1 の冬に拡散をこの係数まで低減(シベリア・南極内陸の冬の冷え込み)
   */
  winterInversionDiffusionFactor: 0.5643,
  /** 周極海峡行の海洋混合層の増深倍率(遮られない流路の深い鉛直混合) */
  channelMixedLayerBoost: 3.0,
  /** 気温減率(°C/km、標高降尺度と OLR 標高補正に使用) */
  lapseRateCPerKm: 5.8,
  /** 海流 SST 偏差を EBM に注入する結合係数(W/m²/K) */
  sstAnomalyCouplingWm2PerK: 26,
  /**
   * 蒸発冷却の係数(W/m² per mm/日の陸平均偏差)。潜熱の完全値は 29、
   * 実効コントラストとしてその約半分。偏差式なので全球平均は不変 */
  evapCoolingWm2PerMmDay: 0,
  /**
   * 帯状移流の地表結合(W/m²/K、基準風速 4 m/s 時)。大気が上流の温度を運び、
   * 地表と有限の強さで熱交換する表現。セル熱容量に移流を掛けると海面が風速で
   * 流される誤った物理になる(較正ログ 2026-07-29)。到達距離 ≈ 結合/(B+Dk²)
   * 換算で 1500〜2500 km 相当。
   */
  zonalAdvectionCouplingWm2PerK: 40.6,
  /** EBM 積分年数と 1 年のステップ数 */
  ebmYears: 4,
  ebmStepsPerYear: 240,
  /** EBM 格子分解能(度) */
  ebmResolutionDeg: 2,

  // ---- Step 1 ITCZ (docs/spec/01_ITCZ.md) ----
  /** 熱赤道の赤緯追従率(海上基準) */
  itczDeclinationFollowRatio: 0.2996,
  /**
   * 半球間非対称による ITCZ の恒常オフセット(度 per °C。暖かい半球へ寄る。
   * 文献値 ~3°/K。SST 非対称はプレパスで測定、オフセットは ±6° クランプ) */
  itczHemisOffsetPerC: 5,
  /**
   * 海上の季節追従の減衰(Log/Pasta: ITCZ は海上でほとんど動かない)。
   * 経度列の帯内陸率 0 のときの追従率倍率(1 = 減衰なし) */
  itczOceanFollowDamp: 0.4798,
  /** 大陸モンスーンによる追加引き寄せ(度、夏半球の陸割合 1.0 のとき) */
  itczMonsoonPullDeg: 7.792,
  /**
   * 高所加熱によるモンスーン増強(帯内の陸平均標高 1km あたりの引き寄せ倍率増)。
   * チベット高原型の熱源が水蒸気トラフを大きく北上させる効果(WL#32 の趣旨)。
   */
  itczMonsoonElevBoostPerKm: 0.55,
  /**
   * 高原引き寄せ(度)。帯内の ≥1,500m の陸(チベット型プラトー)は平均標高
   * より強くトラフを北上させる(WL#27/#32: 高所加熱)。標高 1.5→4km で
   * 0→1 に立ち上がり、高原の帯内占有率で重み付け
   */
  itczPlateauPullDeg: 14,
  /** 経度平滑化後に混ぜ戻す生値の割合(0 = 完全平滑)。モンスーンの経度局所性を保つ */
  itczSmoothLocalBlend: 0.322,
  /** ITCZ 影響帯の半幅(度) */
  itczHalfWidthDeg: 9,
  /**
   * 降水影響圏の幅倍率(WL#31 の ±15° 規則に対応する差込口)。1.15 でも
   * 全球 −0.5pt・1.4 で −2.8pt と実測否定(2026-07-30)のため 1.0 に据え置き。
   * Log の ±15° は「wet→very wet 昇格」の質的規則で、リフト幅ではない模様
   */
  itczPrecipWidthFactor: 1.0,
  /**
   * 赤道常湿帯: 年平均 ITCZ 線の残留影響(0〜1)。実物の熱赤道近傍は年 2 回の
   * 通過と近接で乾季にも雨が残る(赤道 = 雨林の定量化)。幅は半幅 ×0.7
   */
  equatorialItczResidual: 0.666,
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
  /**
   * 冬の亜寒帯海上低気圧の深さ(hPa。WL#32/#34: 寒候期、海氷縁近くの海上に
   * 半永続低気圧 — アリューシャン/アイスランド低相当)。海氷は後段のため
   * 極前線相対で配置。回転成分を通じて冬の西岸への暖気移流を生む
   */
  subpolarWinterLowHpa: 6.558,
  /**
   * 亜熱帯高気圧の離散セル化(WL#29): 帯ではなく海盆ごとのセルで、
   * 「自転方向の東」に大陸が近い側(= 寒流の流れる海盆東縁)ほど強い。
   * 海上の基準重みへの加算倍率と、その減衰距離(km)
   */
  subtropicalCellEastBoost: 0.552,
  subtropicalCellEastScaleKm: 2200,
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
  tradeWindMs: 6.92,
  westerlyWindMs: 7.7,
  polarEasterlyMs: 3,
  /** 気圧勾配風の結合係数(m/s per hPa/1000km): 回転成分と横断成分 */
  pressureGradientRotationalMsPerHpaPerMm: 3.2,
  pressureGradientCrossMsPerHpaPerMm: 1.6,

  // ---- Step 6 降水 (docs/spec/06_降水.md) ----
  /** 水蒸気供給の海上減衰距離(km) */
  moistureDecayOceanKm: 1758,
  /** 陸上減衰距離(km、再循環なしの素の値) */
  moistureDecayLandKm: 1804,
  /** 陸面再蒸発の強さ(0〜1、二回目のパスで局所降水に比例) */
  landRecyclingStrength: 0.35,
  /**
   * 再循環の反復回数。1 だと海から遠い赤道内陸の雨林が立ち上がれない
   * (実物は降水の 5〜8 割が再循環の自己保持 — 仮想大陸で実測)
   */
  recyclingIterations: 2,
  /**
   * R3 土壌水分(地域降水 FB §7): 根群域の植物利用可能水量(mm)。
   * 0 = 無効(旧来の「当月降水に比例」へ戻す)。熱帯林の深根系は 2〜3m 級で
   * 300mm 前後。記憶の時定数 ≈ 容量 / 可能蒸発散(300/140 ≈ 2 か月)
   */
  soilWaterCapacityMm: 600,
  /**
   * 20°C 基準の可能蒸発散(mm/月)。実際の可能蒸発散は飽和水蒸気圧比で
   * スケールする(26°C で約 1.5 倍)。0°C 以下は 0(凍結)
   */
  soilPetScaleMmPerMonth: 90,
  /**
   * 土壌水分の空回し年数の**上限**(数値パラメータ — 較正対象ではない)。
   * 実際は年間貯水変化が SOIL_SPINUP_TOLERANCE_MM を下回った時点で打ち切る。
   * 極寒・極乾の惑星は蒸発散が小さく収束が遅いため上限を大きく取る
   * (バケツ収支は風上追跡を含まないため 1 年あたりの計算は安価)。
   * 実測(2026-07-31): 地球 1° は 191 年で打切り、極寒惑星(光度 0.55)は
   * 956 年を要した(4° で 0.3 秒)。閾値を緩めるのではなく上限で担保する
   */
  soilSpinupYears: 2000,
  /**
   * 降水の月ブレンド(陸のみ、3 点平滑の翼重み)。風向の月替わりで遷移月
   * (特に春)が 0 に陥没し、タイガが夏乾 Ds に誤判定される対策。
   * 乾季が連続する所(サバナ等)は隣接月も乾いており不変
   */
  precipMonthBlend: 0.1952,
  /** 風上追跡の最大距離(km) */
  moistureTraceMaxKm: 5200,
  /**
   * Fetch 則(WL#32): 閉じた内海・湖(面積 < 1.2M km² の海成分)の湿潤が
   * 内陸へ届く距離 = その水域の風上幅(Fetch)。この値はその実効上限。
   * 外洋(海峡で繋がる縁辺海を含む)は対象外で、到達は減衰長が決める。
   */
  fetchOpenOceanCapKm: 2000,
  /** ITCZ 収束の降水増幅(中心で ×(1+この値)) */
  itczLiftBoost: 1.912,
  /**
   * ITCZ 傘の海洋性ゲート: 供給(無次元)がこの値で傘が全開。乾燥内陸の
   * トラフ直下(アラビア型)では傘が開かず、湿潤収束(ベンガル型)では開く
   */
  itczLiftSupplyNorm: 1.35,
  /** ストームトラック(温帯低気圧帯)の増幅 */
  stormTrackBoost: 0.705,
  /** 寒候期のストームトラック追加増幅 */
  stormTrackWinterBoost: 0.15,
  /** 地形性上昇の増幅(基準勾配あたり) */
  orographicBoost: 1.184,
  /** 風下雨陰の最大抑制(0〜1 が残存率の下限) */
  rainShadowFloor: 0.2562,
  /** 亜熱帯高圧帯(沈降域)の抑制率(0〜1)。下降枝全域(リッジ−16°〜+5°)に適用 */
  subsidenceSuppression: 0.7632,
  /** 沈降抑制に対する ITCZ 影響の防護係数(1 = 完全防護) */
  subsidenceItczProtection: 0.8587,
  /**
   * 亜熱帯高気圧の西翼(大陸東岸側)の湿潤化: 順行自転では東に海が近いセルほど
   * 沈降抑制を緩める(バミューダ高気圧西縁の湿潤流の相当物)。減衰距離 km。
   */
  eastCoastSubsidenceRelief: 0.764,
  eastCoastSubsidenceDecayKm: 844,
  /** \u6771\u5cb8\u7de9\u548c\u306e\u4f9b\u7d66\u5b9f\u7e3e\u30b2\u30fc\u30c8(\u3053\u306e\u4f9b\u7d66\u3067\u5168\u958b\u3002\u4e7e\u3044\u305f\u6d41\u5165\u306e\u6d77\u3092\u9664\u5916) */
  eastReliefSupplyNorm: 0.476,
  /** 寒候期でも残る前線性の最低水蒸気(qRel の下限。弱い前線雪の表現) */
  stormMinQRel: 0.55,
  /** 高温湿潤の陸での対流性増幅(T≥22°C かつ供給豊富で最大 +この倍率) */
  warmHumidConvectiveBoost: 0,
  /** 対流性増幅の供給正規化(この供給で全開。二乗で立ち上げ半乾燥を除外) */
  warmHumidSupplyNorm: 2.8,
  /**
   * 前線収束の持ち上げ(WL#29 セル衝突線の定量化)。湿潤空気の極向き移流 ×
   * 供給の極向き勾配に比例。ITCZ 傘とストーム帯の間(梅雨帯)を埋める
   */
  frontalLiftBoost: 0.864,
  /**
   * 寒候期の弱前線の床: 冬のストーム帯内の最乾月に残る降水
   * (最多雨月のこの割合、上限 mm)。年総量は保存(湿潤月から比例控除)。
   * タイガの Dw 化(実物は Df)と Cwa 最多/最少比 276 への対策
   */
  winterFloorFracOfWettest: 0.3908,
  winterFloorMaxMm: 34,
  /** 夏半球の偏西風移流の弱化率(ジェットの季節弱化) */
  summerAdvectionFactor: 0.5932,
  /**
   * ストームトラック帯の渦による水蒸気供給(月平均風では運べない移動性低気圧の
   * 混合を表す)。海岸距離の減衰長と強度。derle 教訓 §8.2「月平均風だけでは
   * 中緯度の冬雨・内陸湿潤が出ない」への対応。
   */
  stormMoistureSupply: 1.964,
  stormMoistureDecayKm: 1768,
  /**
   * 経路上昇の脱水スケール(m)。風上追跡の前方経路で空気がこの高度を上るごとに
   * 水蒸気が e 分の 1 に減る(風上斜面で雨として落ちた分。パタゴニア・チベット
   * 風下の雨陰の主機構 — 2026-07-30 レビュー P1)
   */
  orographicDepletionM: 2600,
  /** \u7a1c\u7dda\u63a8\u5b9a: \u96a3\u63a5\u3068\u306e\u6bd4\u9ad8\u306b\u639b\u3051\u308b\u4fc2\u6570(\u72ed\u3044\u5c71\u8108\u306e 1\u00b0 \u5e73\u5747\u5747\u3057\u5bfe\u7b56\u3002\u906e\u853d/\u969c\u58c1\u306e\u307f) */
  crestProminenceFactor: 0,
  /** 風上山脈による遮蔽: この比高(m)以上で最大遮蔽、遮蔽時の残存率 */
  upwindBlockReliefM: 1800,
  upwindBlockScanKm: 900,
  upwindBlockFloor: 0.1826,
  /** 寒流沿岸の追加抑制率 */
  coldCoastSuppression: 0.415,
  /** 全球スケール係数(供給×持ち上げ → mm/月) */
  precipScaleMmPerUnit: 8.2,

  // ---- 共通 ----
  /** 海面凍結温度(°C) */
  seaFreezeC: -1.9,
  /**
   * 海氷の断熱係数: 氷結した海面は混合層を大気から切り離し、実効熱容量が
   * 陸並みに落ちる(氷量 1 のとき容量を 1−この値 に縮小)。これが無いと
   * 極域の季節振幅が 1/3 になる(80N: モデル 9°C vs 実測 30°C — 2026-07-30)
   */
  seaIceInsulationFactor: 0.9432,
  /**
   * 0 層海氷: 成長率(m/°C/日、凍結点以下 1°C あたり)・最大氷厚(m)・
   * 融解潜熱(J/m³)。融解中の海面は凍結点に固定される(北極の夏 −0.3°C の再現)
   */
  seaIceGrowthMPerDegDay: 0.0006,
  seaIceMaxThicknessM: 2.5,
  seaIceLatentJPerM3: 3.0e8,
} as const;

export type ModelConstants = typeof MODEL_CONSTANTS;
