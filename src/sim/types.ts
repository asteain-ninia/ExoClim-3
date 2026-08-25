// パイプラインの入出力契約。docs/要件.md §3 の表に対応。
// 全フィールドは表示格子(cellCount 長のフラット配列)または月別配列 [12]。

import type { Grid } from '@/domain/grid';
import type { InsolationField } from '@/domain/insolation';
import type { PlanetParams } from '@/domain/planetParams';
import type { TerrainField } from '@/domain/terrain';
import type { PipelineDiagnostics } from './diagnostics';

/**
 * 結合反復(土壌水分 ⇄ 再循環)の収束診断。
 * **定義はここに置く**(実装は step06)。types → step06 → run_control → types の
 * 型の循環を避けるため — 途中結果の型がこのファイルを参照するようになったので、
 * ここが依存の末端でないと環になる。
 */
export interface PrecipCouplingDiagnostics {
  /** 実施した結合反復回数 */
  iterations: number;
  maxIterations: number;
  toleranceMmPerMonth: number;
  /** 最終反復での陸面積重み付き平均 |ΔP|(mm/月) */
  finalResidualMmPerMonth: number;
  converged: boolean;
}

/** 全ステップ共通の文脈(パイプライン先頭で構築、以後不変) */
export interface SimContext {
  grid: Grid;
  params: PlanetParams;
  terrain: TerrainField;
  insolation: InsolationField;
  /** 陸セル: 最寄り海岸までの距離 km。海セルは 0 */
  landDistToCoastKm: Float32Array;
  /** 海セル: 最寄り陸までの距離 km。陸セルは 0 */
  oceanDistToLandKm: Float32Array;
}

export interface ItczResult {
  /** [month] 経度列ごとの ITCZ 中心緯度(度) */
  monthlyCenterLatDegByCol: Float32Array[];
  /** 影響帯の半幅(度) */
  halfWidthDeg: number;
}

export interface WindBeltResult {
  /** [month] 北半球・南半球の亜熱帯高圧帯(ハドレー端)緯度(度、N は正) */
  monthlyRidgeLatNDeg: number[];
  monthlyRidgeLatSDeg: number[];
  /**
   * [month][col] 亜熱帯リッジの**経度別の極向き押し上げ量**(度、0 以上)。
   * 実物の夏は大陸上でリッジが極側へ押し上げられる(チベット高気圧)一方、
   * 海上のリッジは低緯度に留まる。帯状一様なリッジだと中緯度東岸が
   * 夏でも沈降帯の下に入りっぱなしになる。
   * 既定 0(`ridgeLandShiftDeg = 0`)で従来と厳密に一致。
   * 事前登録: docs/事前登録_リッジの経度依存_2026-08-13.md
   */
  monthlyRidgeShiftDegByCol: Float32Array[];
  /** [month] 極前線緯度 */
  monthlyPolarFrontLatNDeg: number[];
  monthlyPolarFrontLatSDeg: number[];
  /** [month][cell] 地表気圧偏差 hPa */
  monthlyPressureAnomalyHpa: Float32Array[];
}

/**
 * 海流の流線。points は [lat, lon, lat, lon, …] のフラット配列で、
 * **並び順が流向**(矢印は並び順から描く)。kind は Artifexian/Pasta の
 * 三色区分(赤 = 暖流: 低緯度→高緯度、青 = 寒流: 高緯度→低緯度、
 * 黒 = 中立: 緯度方向でほぼ熱輸送なし)。
 */
export interface OceanStreamline {
  kind: 'warm' | 'cold' | 'neutral';
  points: number[];
}

export interface OceanCurrentResult {
  /** [cell] 海面温度偏差 °C(海流による恒常成分。陸セルは 0) */
  sstAnomalyC: Float32Array;
  /** [cell] 表示用分類: 1 = 暖流域、-1 = 寒流域、0 = 中立/陸 */
  currentClass: Int8Array;
  /** [cell] 沿岸湧昇域(1 = 湧昇。寒流沿岸のエクマン輸送、WL#30) */
  upwellingMask: Uint8Array;
  /** [cell] サンゴ礁候補(1 = 礁。熱帯の暖流沿岸で湧昇を避ける、WL#30) */
  coralReefMask: Uint8Array;
  /** 環流の流線(年平均の帯でトレース)。docs/spec/01-04_循環.md 参照 */
  streamlines: OceanStreamline[];
  /** [month] 月別の流線(季節の転回緯度・海氷縁・ITCZ でトレース。WL#28 の夏冬版の一般化) */
  monthlyStreamlines: OceanStreamline[][];
}

export interface AirflowResult {
  /** [month][cell] 地表風の東西成分 m/s(東向き正) */
  monthlyWindU: Float32Array[];
  /** [month][cell] 南北成分 m/s(北向き正) */
  monthlyWindV: Float32Array[];
  /**
   * [month][cell] 気柱輸送風(陸面摩擦を掛ける前。山岳減衰・上限は適用済み)。
   * 水蒸気の大半が乗る自由大気は陸面粗度で 10m 風ほど減速しない
   * (2026-08-25、外部監査 #1。docs/事前登録_気柱輸送風の分離_2026-08-25.md)。
   * moistureWindSurfaceBlend = 1(既定)では作られない(undefined)。
   */
  monthlyColumnWindU?: Float32Array[];
  monthlyColumnWindV?: Float32Array[];
}

export interface TemperatureResult {
  /** [month][cell] 地表気温 °C */
  monthlyTemperatureC: Float32Array[];
  /** [cell] 年平均気温 */
  annualMeanC: Float32Array;
  /** [cell] 最暖月・最寒月気温 */
  warmestMonthC: Float32Array;
  coldestMonthC: Float32Array;
  /** [month][cell] 雪氷マスク(1 = 雪氷面) */
  monthlyIceMask: Uint8Array[];
}

/**
 * 陸面の水の状態。**降水の副産物ではなく、気温が読む物理量**。
 *
 * 陸の地表エネルギー収支は「どれだけ水が蒸発できるか」で決まる:
 * 蒸発すれば潜熱で夏が冷え(半乾燥)、蒸発する水が無ければ乾熱で暑くなる(砂漠)。
 * 熱容量も同じで、湿った土は水の熱容量を借り、乾いた砂は借りられない。
 *
 * **降水量で代用してはいけない**(2026-07-30 に代用して実測で破綻した:
 * 係数 12 で気温 RMSE 4.85 → 6.76)。降水は月 500mm もあり得るが、
 * 蒸発散は可能蒸発散に頭を押さえられるので振れ幅が桁で違う。
 * 代用すると降水の誤差がそのまま温度へ増幅される。
 */
export interface LandSurfaceState {
  /** [month][cell] 実蒸発散 mm/月(海セルは 0) */
  monthlyEtMm: Float32Array[];
  /** [month][cell] 利用可能水 / 容量 の 0〜1(海セルは 0) */
  monthlyWetness01: Float32Array[];
}

export interface PrecipitationResult {
  /** [month][cell] 降水量 mm/月 */
  monthlyPrecipMm: Float32Array[];
  /**
   * [month][cell] 可降水量 W mm(保存型ソルバの最終反復解。2026-08-26、
   * 目的関数 v8「W の係留」の採点対象。非保存経路では undefined)
   */
  monthlyWaterMm?: Float32Array[];
  /** [cell] 年降水量 mm */
  annualPrecipMm: Float32Array;
  /** 結合反復(土壌水分 ⇄ 再循環)の収束診断 */
  coupling: PrecipCouplingDiagnostics;
  /** 陸面の水の状態(土壌水分が有効なときのみ)。気温の 2 パス目が読む */
  land?: LandSurfaceState;
  /**
   * 土壌水分バケツの周期定常への到達度。**採点の数値的健全性がこれを読む。**
   * 以前は validate.ts が `soilConverged: true` をベタ書きしており、
   * 土壌の収束は一度も検査されていなかった(2026-08-09 の外部レビューで発覚)。
   */
  soil?: {
    converged: boolean;
    spinupYears: number;
    meanAnnualStorageDriftMm: number;
    maxAnnualStorageDriftMm: number;
  };
  /**
   * 保存型の水蒸気輸送の収束(保存型を使ったときだけ入る)。
   *
   * **反復上限を固定値にしない**ための口。2026-08-09 の実測で、同じソルバが
   * 地球の入力では 1500 反復で収束するのに、別の入力では 20000 でも
   * 収束しないことが分かった。上限は「地球で足りる値」でしかなく、
   * **架空の惑星では上限が答えを決めうる**。
   * 収束しなかったときは適用範囲外として扱い、ケッペン分類を有効な
   * 科学出力として出さない(diagnostics 側で error にする)。
   */
  transport?: {
    /** 収束しなかった解の数(月 × 結合反復) */
    nonConvergedSolves: number;
    /** その中での最悪の相対残差 */
    worstResidual: number;
    /** 使った反復上限 */
    maxIterations: number;
  };
}

export interface KoppenResult {
  /**
   * [cell] 気候区分(Beck et al. 2023 の番号体系: 1=Af … 30=EF、0=海)。
   * 番号 → 記号は domain/koppen.ts の KOPPEN_CLASSES を参照。
   */
  classId: Uint8Array;
}

export interface PipelineResult {
  context: SimContext;
  itcz: ItczResult;
  windBelt: WindBeltResult;
  ocean: OceanCurrentResult;
  airflow: AirflowResult;
  temperature: TemperatureResult;
  precipitation: PrecipitationResult;
  koppen: KoppenResult;
  /**
   * 適用範囲診断(P1-3)。status = 'out_of_domain' のとき、ケッペン分類は
   * 有効な科学出力として表示しない(UI・ヘッドレス検証の両方で明示する)
   */
  diagnostics: PipelineDiagnostics;
  // 注(P1-4): ステップ別所要時間は時刻依存のため物理結果に含めない。
  // 必要なら runPipelineTimed の戻り値 stepTimingsMs を使う
}

/**
 * **計算途中の結果**。段が終わるたび(および気温・降水は段の内側でも)
 * 少しずつ埋まっていく。表示はこれを直接描く。
 *
 * context だけが必須なのは、格子と地形が無いと何一つ描けないため。
 * それ以外は「まだ計算されていない」ことがある。
 *
 * **確定結果(PipelineResult)と型を分けているのは意図的**。同じ型にすると
 * 未収束・未計算の場を確定値として扱う経路ができる(教訓 §1)。
 * 表示側は必ず「この層はまだ無い」を扱わなければならない。
 */
export type PartialPipelineResult = { context: SimContext } & Partial<
  Omit<PipelineResult, 'context'>
>;

/**
 * 途中結果の差分。段が自分の出力だけを載せて上へ流す。
 * 表示側が前の差分に重ねていくことで PartialPipelineResult になる。
 */
export interface RunPartial {
  context?: SimContext;
  itcz?: ItczResult;
  windBelt?: WindBeltResult;
  ocean?: OceanCurrentResult;
  airflow?: AirflowResult;
  temperature?: TemperatureResult;
  precipitation?: PrecipitationResult;
  koppen?: KoppenResult;
}
