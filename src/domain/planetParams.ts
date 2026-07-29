// 利用者パラメータ(惑星の物理量)。docs/要件.md §2 に対応。
// モデル較正定数はここに置かない(docs/方針.md §3) — src/sim/constants.ts を参照。

export interface OrbitalParams {
  /** 主星光度(太陽 = 1) */
  starLuminositySolar: number;
  /** 軌道長半径(AU) */
  semiMajorAxisAu: number;
  /** 軌道離心率(0〜0.9) */
  eccentricity: number;
  /**
   * 近日点の季節位相(太陽黄経、度)。0 = 北半球春分、90 = 北半球夏至、
   * 180 = 秋分、270 = 冬至。地球は約 283°(1 月初旬に近日点)。
   */
  perihelionSeasonDeg: number;
}

export interface PlanetBodyParams {
  /** 惑星半径(km)。地球 = 6371 */
  radiusKm: number;
  /** 自転周期(時間)。地球 = 24 */
  rotationPeriodHours: number;
  /** 地軸傾斜(度、0〜90) */
  axialTiltDeg: number;
  /** 自転方向(1 = 順行、-1 = 逆行) */
  rotationDirection: 1 | -1;
}

export interface AtmosphereOceanParams {
  /** 表面気圧(bar)。地球 = 1.0(現状は熱容量・降水効率の弱いスケーリングのみに使用) */
  surfacePressureBar: number;
  /** 温室効果強度(地球 = 1.0)。0.5〜2 で寒冷〜温暖 */
  greenhouseStrength: number;
  /** 雲アルベド(実効値、地球 ≈ 0.2) */
  cloudAlbedo: number;
  /** 海洋混合層の深さ(m)。地球 ≈ 50。海の熱慣性を支配 */
  oceanMixedLayerDepthM: number;
  /** 大気・海洋の水平熱輸送強度(地球 = 1.0) */
  heatTransportStrength: number;
}

export type TerrainPresetName =
  | 'earth'
  | 'idealized_continent'
  | 'two_continents'
  | 'aquaplanet'
  | 'all_land';

export type TerrainSource =
  | { kind: 'preset'; preset: TerrainPresetName }
  | {
      kind: 'procedural';
      seed: number;
      /** 目標の陸面積率(0〜1) */
      landFraction: number;
      /** 地形の起伏の強さ(0.5〜2、1 = 地球程度) */
      reliefScale: number;
    };

export interface PlanetParams {
  orbital: OrbitalParams;
  body: PlanetBodyParams;
  atmosphere: AtmosphereOceanParams;
  terrain: TerrainSource;
  /** 表示格子の分解能(度)。1 または 2 */
  gridResolutionDeg: number;
}

export const EARTH_PARAMS: PlanetParams = {
  orbital: {
    starLuminositySolar: 1.0,
    semiMajorAxisAu: 1.0,
    eccentricity: 0.0167,
    perihelionSeasonDeg: 283,
  },
  body: {
    radiusKm: 6371,
    rotationPeriodHours: 24,
    axialTiltDeg: 23.44,
    rotationDirection: 1,
  },
  atmosphere: {
    surfacePressureBar: 1.0,
    greenhouseStrength: 1.0,
    cloudAlbedo: 0.2,
    oceanMixedLayerDepthM: 50,
    heatTransportStrength: 1.0,
  },
  terrain: { kind: 'preset', preset: 'earth' },
  gridResolutionDeg: 1,
};

/** 年平均の全球日射(W/m²)。太陽定数 1361 W/m² を光度と距離でスケール。 */
export function stellarConstantWm2(orbital: OrbitalParams): number {
  return (1361 * orbital.starLuminositySolar) / (orbital.semiMajorAxisAu * orbital.semiMajorAxisAu);
}

/** ケプラー第三法則による公転周期(地球年)。主星質量は光度から近似(L ∝ M^4)。 */
export function orbitalPeriodYears(orbital: OrbitalParams): number {
  const starMassSolar = Math.pow(orbital.starLuminositySolar, 1 / 4);
  return Math.sqrt(Math.pow(orbital.semiMajorAxisAu, 3) / starMassSolar);
}
