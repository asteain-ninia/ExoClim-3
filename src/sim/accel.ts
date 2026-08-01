// 計算加速器(GPU)の受け口。**このファイルは webgpu を import しない**。
//
// 対応 spec: なし(実行基盤)。
//
// なぜ型だけ分けるか:
//   src/sim/ はブラウザ用バンドルにも入る。GPU 実装(src/sim/gpu/)は Node 専用の
//   `webgpu` パッケージを静的 import しているため、計算層が直接それを参照すると
//   ブラウザのビルドが壊れる。そこで **加速器は呼び出し側から明示的に渡す**形にし、
//   計算層は型しか知らない。渡されなければ全て CPU 実装で動く。
//
// 数値の扱い(2026-08-01 のユーザー判断):
//   GPU を正とし、CPU は参照実装とする。GPU は f32 しか持たないため丸めは
//   一致しないが、同じ入力に対する GPU 同士はビット一致する(atomics と
//   順序不定のリダクションを避けているため)。

/** 風上追跡の静的な場(月に依らないもの) */
export interface TraceStaticFields {
  widthCells: number;
  heightCells: number;
  /** 南北セル寸法(km)。ステップ長の基準 */
  dyKm: number;
  /** 惑星半径(km)。行ごとの東西セル寸法を求めるのに使う */
  radiusKm: number;
  resolutionDeg: number;
  elevationMeters: Float32Array;
  crestElevationMeters: Float32Array;
  /** 1 = 陸 */
  landMask: Float32Array;
  /** 1 = 閉じた内海・湖(Fetch 則の対象) */
  smallWater: Float32Array;
}

/** 風上追跡の月ごとに変わる場 */
export interface TraceMonthlyFields {
  /** [month][cell] 気温 °C */
  temperature: Float32Array[];
  /** [month][cell] 東西風 m/s */
  windU: Float32Array[];
  /** [month][cell] 南北風 m/s */
  windV: Float32Array[];
  /** [month][cell] 陸面供給の強さ。null なら陸は供給源にならない(パス 1) */
  landSource: Float32Array[] | null;
}

/** 風上追跡に渡す較正定数 */
export interface TraceConstants {
  orographicDepletionM: number;
  moistureTraceMaxKm: number;
  moistureDecayLandKm: number;
  moistureDecayOceanKm: number;
  fetchOpenOceanCapKm: number;
}

/** 12 か月ぶんの風上追跡を一度に解く加速器 */
export interface MoistureTraceAccel {
  /** @returns [month][cell] の供給場。返る配列は次回呼び出しで上書きされない */
  run(
    fields: TraceStaticFields,
    constants: TraceConstants,
    monthly: TraceMonthlyFields,
  ): Promise<Float32Array[]>;
  destroy(): void;
}

/**
 * 土壌水分バケツの周期定常解。
 * CPU 実装 step06_precipitation.ts の SoilWaterResult と同じ形
 * (診断・水収支テストがそのまま通るように、流出・湿り度も返す)
 */
export interface SoilAccelResult {
  /** [month][cell] 実蒸発散 mm/月 */
  actualEtMm: Float32Array[];
  /** [month][cell] 月末貯水 mm */
  storageMm: Float32Array[];
  /** [month][cell] 流出 mm/月 */
  runoffMm: Float32Array[];
  /** [month][cell] 利用可能水 / 容量の 0〜1 クランプ */
  wetness01: Float32Array[];
  /** [cell] 記録年の貯水変化 */
  storageChangeMm: Float32Array;
  spinupYears: number;
  meanAnnualStorageDriftMm: number;
  maxAnnualStorageDriftMm: number;
  converged: boolean;
}

export interface SoilWaterAccel {
  run(input: {
    landMask: ArrayLike<number>;
    precipByMonth: Float32Array[];
    tempByMonth: Float32Array[];
    capacityMm: number;
    petScaleMmPerMonth: number;
    maxYears: number;
    toleranceMm: number;
    initialStorage?: ArrayLike<number> | undefined;
  }): Promise<SoilAccelResult>;
  destroy(): void;
}

// ---- EBM(step5 気温)----

/**
 * EBM の時間積分 1 パスぶんの入力。
 * すべて EBM 粗格子(既定 2°)の上の量で、月に依らないものと月別のものを分ける。
 */
export interface EbmStaticFields {
  widthCells: number;
  heightCells: number;
  /** 時間ステップ(秒) */
  dtSeconds: number;
  stepsPerYear: number;
  years: number;
  /** [cell] 熱容量 J/m²/K */
  heatCap: Float32Array;
  /** [cell] 標高補正込みの OLR 切片 */
  aEff: Float32Array;
  /** [cell] 氷なしの地表アルベド */
  surfAlbedoBase: Float32Array;
  /** [cell] 結氷開始温度 °C */
  iceOnset: Float32Array;
  /** [cell] Q フラックス W/m²(中立化済み) */
  qFlux: Float32Array;
  /** [cell] 陸の平均標高 × 陸率(m) */
  elevM: Float32Array;
  /** [cell] 陸率 0〜1 */
  landFrac: Float32Array;
  /** [cell] 海の拡散増強込みの拡散係数倍率 */
  diffFactor: Float32Array;
  /** [cell] 内陸度 0〜1 */
  interior01: Float32Array;
  /** [cell] 1 = 恒常氷床(パス 1 では全 0) */
  permanentIce: Float32Array;
  /** [row] 中心緯度の cos */
  cosCenter: Float32Array;
  /** [row] 東西の計量(cap 済み) */
  metricZonal: Float32Array;
  /** [row] 1 = 周極海峡の行 */
  rowIsChannel: Float32Array;
  /** [month][row] 月平均日射 W/m² を平坦化した 12*CH */
  insolMonthlyByRow: Float32Array;
  /** [row] 年平均日射 W/m² */
  insolAnnualByRow: Float32Array;
  /** [month][cell] 雲アルベド */
  cloudAlbedo: Float32Array[];
  /** [month][cell] EBM 格子上の東西風 m/s */
  windU: Float32Array[];
  /** [month][cell] 同・南北風 */
  windV: Float32Array[];
  /** [month][cell] 蒸発冷却の異常フラックス W/m²(無ければ null) */
  evapAnom: Float32Array[] | null;
  /** [month] リッジ緯度(北/南)と、その年平均(夏判定用) */
  ridgeLatN: Float32Array;
  ridgeLatS: Float32Array;
  meanRidgeN: number;
  meanRidgeS: number;
  /** [cell] 初期温度。null なら緯度からの既定値 */
  initialT: Float32Array | null;
}

/** EBM に渡す較正定数(呼び出し側が MODEL_CONSTANTS から渡す) */
export interface EbmConstants {
  lapseRateGammaCPerM: number;
  iceRampWidthC: number;
  albedoIce: number;
  permanentIceAlbedo: number;
  seaIceInsulationFactor: number;
  olrBWm2PerC: number;
  diffusionBase: number;
  zonalDiffusionFactor: number;
  hadleyDiffusionBoost: number;
  circumpolarChannelFactor: number;
  summerAdvectionFactor: number;
  zonalAdvectionCouplingWm2PerK: number;
  winterInversionDiffusionFactor: number;
  winterInversionAdvectionFactor: number;
  /** 反復の打ち切り(°C)。較正つまみではない — 数値誤差の上限 */
  solveToleranceC: number;
  /** 1 時間ステップあたりの反復回数(残差は記録して検証する) */
  iterationsPerStep: number;
}

export interface EbmAccelResult {
  /** [month][cell] 最終年の月別温度の積算 */
  monthAccum: Float32Array[];
  /** [month] 積算した回数 */
  monthCount: number[];
  /** [cell] パス終了時の温度(次パスのウォームスタート用) */
  finalT: Float32Array;
  /** 全時間ステップを通じた最大残差(°C)。許容差を超えたら収束していない */
  maxResidualC: number;
}

export interface EbmAccel {
  run(fields: EbmStaticFields, constants: EbmConstants): Promise<EbmAccelResult>;
  destroy(): void;
}

/**
 * 計算加速器。セル数ごとに常駐資源を持つ。
 *
 * 常駐にする理由は性能ではなく**動作の必要条件**: バッファを毎回作り直すと
 * 100 回未満でアクセス違反が起きる(src/sim/gpu/device.ts の注記)。
 * 較正は 1 プロセスで数千回パイプラインを回すため、ここが持たないと成立しない。
 */
export interface SimAccelerator {
  /** 使えなければ null(呼び出し側は CPU 実装へ落ちる) */
  moistureTrace(cellCount: number): MoistureTraceAccel | null;
  soilWater(cellCount: number): SoilWaterAccel | null;
  /** 常駐資源をすべて解放する */
  destroy(): void;
}

/** 実行オプション。加速器を渡さなければ全て CPU 実装で動く */
export interface RunOptions {
  accel?: SimAccelerator | undefined;
}
