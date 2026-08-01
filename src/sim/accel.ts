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
