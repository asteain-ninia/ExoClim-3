// パイプラインの入出力契約。docs/要件.md §3 の表に対応。
// 全フィールドは表示格子(cellCount 長のフラット配列)または月別配列 [12]。

import type { Grid } from '@/domain/grid';
import type { InsolationField } from '@/domain/insolation';
import type { PlanetParams } from '@/domain/planetParams';
import type { TerrainField } from '@/domain/terrain';
import type { PipelineDiagnostics } from './diagnostics';
import type { PrecipCouplingDiagnostics } from './step06_precipitation';

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

export interface PrecipitationResult {
  /** [month][cell] 降水量 mm/月 */
  monthlyPrecipMm: Float32Array[];
  /** [cell] 年降水量 mm */
  annualPrecipMm: Float32Array;
  /** 結合反復(土壌水分 ⇄ 再循環)の収束診断 */
  coupling: PrecipCouplingDiagnostics;
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
