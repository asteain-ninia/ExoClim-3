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

import type {
  CancelToken,
  ConvergenceBudget,
  ProgressSink,
  StageCache,
  StageProgressSink,
} from './run_control';

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
  /**
   * 全熱容量で積分する年数(末尾から数える)。それ以前は熱容量 1/16 で加速。
   * **CPU と GPU で必ず同じ値を使うこと** — 片方にベタ書きすると、
   * 定数を振ったつもりの実験が無効になる(2026-08-02 に実際に踏んだ)。
   */
  fullCapacityYears: number;
  /**
   * 加速期の熱容量倍率(既定 1/16)。**同じ理由で CPU と GPU に別々に
   * 書かない** — 2026-08-11 まで両方にベタ書きされていた。
   * 出どころは step05_temperature.ts の EBM_SPINUP
   */
  spinupCapacityFraction: number;
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
  /**
   * [month][cell] 蒸発帰還 ∂LE/∂T(W/m²/K)と、その線形化の基準温度 °C。
   * 対角へ k、右辺へ k·T_ref を足す。無ければ null(帰還なし)。
   * **両方揃って初めて意味を持つ**ので 1 つの組で渡す
   */
  evapFeedback: { k: Float32Array[]; refTempC: Float32Array[] } | null;
  /** [month] リッジ緯度(北/南)と、その年平均(夏判定用) */
  ridgeLatN: Float32Array;
  ridgeLatS: Float32Array;
  meanRidgeN: number;
  meanRidgeS: number;
  /** [cell] 初期温度。null なら緯度からの既定値 */
  initialT: Float32Array | null;
  /** [cell] 初期氷厚(水等価 mm)。null なら 0 から。0 層模型のときだけ意味を持つ */
  initialIce: Float32Array | null;
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
  /**
   * 0 層海氷模型を使うか。**CPU 経路と同じ式が GPU にも入っている**ことが前提。
   * 片方だけに入れると加速器の有無で物理が変わる
   */
  slabIce: boolean;
  seaFreezeC: number;
  seaIceConductivityWmK: number;
  seaIceLatentJPerMm: number;
  seaIceMinThicknessMm: number;
  seaIceCoverScaleMm: number;
}

export interface EbmAccelResult {
  /** [month][cell] 最終年の月別温度の積算 */
  monthAccum: Float32Array[];
  /** [month] 積算した回数 */
  monthCount: number[];
  /** [cell] パス終了時の温度(次パスのウォームスタート用) */
  finalT: Float32Array;
  /** [cell] パス終了時の氷厚(水等価 mm)。0 層模型のときだけ意味を持つ */
  finalIce: Float32Array;
  /** 全時間ステップを通じた最大残差(°C)。許容差を超えたら収束していない */
  maxResidualC: number;
  /**
   * [step] 各時間ステップの残差(°C)。**最大値だけでは「全ステップが
   * 一番苦しい 1 ステップに引きずられている」かどうかが分からない。**
   * 反復回数を削れるかの判断に使う(scripts/diag_ebm_step_residual.ts)
   */
  stepResidualsC?: Float32Array | undefined;
  /** 全ステップで許容差を満たしたか。false なら反復回数が足りない */
  converged: boolean;
  /** 最終年と前年の年平均の最大差(°C)。参考値(極の小さなセルに支配される) */
  maxYearDriftC: number;
  /**
   * 同・**面積重み平均**(°C)。周期定常への到達度の判定はこちらで行う。
   * 時間離散化の誤差(0.13°C)を同じ物差しで測っており、許容差はそれと
   * 比べて決めているので揃える必要がある。
   */
  meanYearDriftC: number;
}

export interface EbmAccel {
  run(
    fields: EbmStaticFields,
    constants: EbmConstants,
    control?: AccelControl,
  ): Promise<EbmAccelResult>;
  /**
   * 回せる時間ステップ数の上限。**呼び出し側はこれを見て年数を伸ばすのを止める**。
   *
   * 2026-08-02 に前セッションが見つけた不整合(未修正のまま申し送られていた):
   * 上限を超えると例外で死ぬため、step05 が「周期定常に達しないので年数を
   * 倍増する」適応をすると、収束しにくい惑星で**未収束と診断される前に落ちる**。
   * 地球では起きず他の惑星でだけ起きる — 惑星デザイナとして最悪の壊れ方。
   * 上限は診断へ落とすべきものであって、例外にすべきものではない。
   */
  readonly maxSteps: number;
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
  /** EBM は粗格子(既定 2°)のセル数で常駐する */
  ebm(cellCount: number): EbmAccel | null;
  /** 常駐資源をすべて解放する */
  destroy(): void;
}

/**
 * 実行オプション。**何も渡さなければ従来どおり**、加速も中断も進捗も無い
 * 素の純粋関数として走る(確定品質・全段計算)。
 */
export interface RunOptions {
  accel?: SimAccelerator | undefined;
  /** 中断要求の受け口。中断は例外(ComputeCancelledError)で抜ける */
  signal?: CancelToken | undefined;
  /** 収束予算。省略した項目は各段の既定定数(= 確定品質)に落ちる */
  budget?: ConvergenceBudget | undefined;
  /** 実行全体の進捗。**パイプラインだけが呼ぶ**(段の内側からは使わない) */
  onProgress?: ProgressSink | undefined;
  /** 段キャッシュ。渡さなければ毎回全段を計算する(従来どおり) */
  cache?: StageCache | undefined;
  /**
   * 段の内側からの進捗通知。パイプラインが段ごとに差し替えて渡すので、
   * 呼び出し側(scripts/・テスト)が直接埋めることは無い。
   */
  progress?: StageProgressSink | undefined;
  /**
   * EBM のウォームスタート用の受け渡し箱(**較正のためだけの高速化**)。
   *
   * 較正は近いパラメータを次々に評価するので、**直前の収束温度場は非常に良い
   * 初期推定**である。渡すと EBM はそこから始め、全熱容量で回す年数を
   * 短い出発点から試す(足りなければ従来どおり倍々に増やす)。
   * 実行後、この箱には**その実行の収束温度場**(EBM 粗格子)が書き戻される。
   *
   * **答えは変わらない**。倍化のたびに残差と年次ドリフトを検査するので、
   * 得られる解は出発点に依らない — これは実測で確かめてある(2026-08-04:
   * 同じパラメータを別プロセス・別予算で回して v3=85.666 が完全一致した。
   * scripts/diag_hint_ratchet.ts)。
   *
   * **セル数が違えば無視する**(解像度を変えたときに前の場を使い回さない)。
   */
  ebmWarmStart?: { field: Float32Array | null } | undefined;
}

/** 加速器の run() に渡す制御(物理入力とは分けて渡す — 混ぜると結果の同一性が曖昧になる) */
export interface AccelControl {
  signal?: CancelToken | undefined;
  progress?: StageProgressSink | undefined;
  /**
   * 積分の途中の温度場(**EBM 粗格子・その瞬間のモデル時刻**)を渡す。
   *
   * 加速器は「素のスナップショット + それがどの月・何年目か」だけを渡し、
   * 表示用の組み立て(12 か月ぶんを溜めて表示格子へ落とす)は呼び出し側が行う。
   * 加速器が表示の都合を知らずに済むようにするための分担。
   *
   * 呼ばれる間隔は 1 か月ぶんの時間ステップごと(= stepsPerYear / 12)。
   * valuesC は呼び出しの直後に上書きされうるので、保持するなら複製すること。
   */
  onCoarseSnapshot?:
    | ((s: {
        valuesC: Float32Array;
        /** 0〜11。この間隔で呼ぶので各月ちょうど 1 回ずつ埋まる */
        monthIndex: number;
        /** 何年目か(1 始まり) */
        year: number;
      }) => void)
    | undefined;
}
