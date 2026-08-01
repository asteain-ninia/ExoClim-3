// デーレ(出界)実験の共通部品: 惑星諸元・地域集計・正典整合の判定。
//
// 前提(利用者裁定 2026-08-01): 正典は**土地々々の気候**であり、
// 全球平均 8°C も陸平均降水 690mm も固定値ではない(前者は手段としての旧推定、
// 後者は無根拠)。天文値も変更可。したがって地域気候を基準に、
// 天文値・大気を従属変数として探索する。

import { runPipeline } from '../src/sim/pipeline';
import type { PlanetParams } from '../src/domain/planetParams';
import { KOPPEN_CLASSES, majorClassOf } from '../src/domain/koppen';
import { areaWeightOfRow, latDegOfRow } from '../src/domain/grid';
import type { PipelineResult } from '../src/sim/types';
import type { RunOptions } from '../src/sim/accel';
import derleTerrain from '../src/domain/data/derle_terrain_1deg.json';
import derleCountries from '../src/domain/data/derle_countries.json';
import derlePolygons from '../src/domain/data/derle_country_polygons.json';

interface DerleTerrainJson {
  widthCells: number;
  heightCells: number;
  elevationMeters: number[];
  landMask: number[];
  crestMeters: number[];
}
const t = derleTerrain as DerleTerrainJson;

/** derle-climate/docs/PROJECT_CONTEXT.md の値(探索の出発点) */
export const DERLE_BASE = {
  starLuminositySolar: 1.2879,
  semiMajorAxisAu: 1.225,
  radiusEarth: 1.0489,
  rotationPeriodHours: 28.4698,
  axialTiltDeg: 19.505,
} as const;

export interface DerleOverrides {
  greenhouse?: number;
  axialTiltDeg?: number;
  rotationPeriodHours?: number;
  starLuminositySolar?: number;
  semiMajorAxisAu?: number;
  eccentricity?: number;
  surfacePressureBar?: number;
}

export function derleParams(greenhouseOrOverrides: number | DerleOverrides): PlanetParams {
  const o: DerleOverrides =
    typeof greenhouseOrOverrides === 'number'
      ? { greenhouse: greenhouseOrOverrides }
      : greenhouseOrOverrides;
  return {
    orbital: {
      starLuminositySolar: o.starLuminositySolar ?? DERLE_BASE.starLuminositySolar,
      semiMajorAxisAu: o.semiMajorAxisAu ?? DERLE_BASE.semiMajorAxisAu,
      // 離心率・近日点位相はデーレ側に記載が無いため地球値を仮置き
      eccentricity: o.eccentricity ?? 0.0167,
      perihelionSeasonDeg: 283,
    },
    body: {
      radiusKm: 6371 * DERLE_BASE.radiusEarth,
      rotationPeriodHours: o.rotationPeriodHours ?? DERLE_BASE.rotationPeriodHours,
      axialTiltDeg: o.axialTiltDeg ?? DERLE_BASE.axialTiltDeg,
      rotationDirection: 1,
    },
    atmosphere: {
      surfacePressureBar: o.surfacePressureBar ?? 1.0,
      greenhouseStrength: o.greenhouse ?? 1.0,
      cloudAlbedo: 0.2,
      oceanMixedLayerDepthM: 50,
      heatTransportStrength: 1.0,
    },
    terrain: {
      kind: 'custom',
      name: 'derle',
      widthCells: t.widthCells,
      heightCells: t.heightCells,
      elevationMeters: t.elevationMeters,
      landMask: t.landMask,
      crestMeters: t.crestMeters,
    },
    gridResolutionDeg: 1,
  };
}

/** 日射(W/m²)。地球 = 1361 */
export function insolationWm2(luminositySolar: number, semiMajorAxisAu: number): number {
  return (1361 * luminositySolar) / (semiMajorAxisAu * semiMajorAxisAu);
}

// ---- 地域枠(derle-climate config/v11_shukkai.json と同一)----
const WILL_VERTICES: Array<[number, number]> = [
  [-140, 31], [-133, 34], [-123, 33], [-113, 31], [-103, 28],
  [-102, 20], [-109, 13], [-121, 11], [-134, 14], [-141, 22],
];
const ELLIPSES: Record<string, [number, number, number, number]> = {
  'デーレ中核': [-70.0, 17.0, 14.0, 10.0],
  'ルティア暫定域': [-73.0, 2.5, 7.0, 5.0],
  'シャンテリャ本体': [-32.0, 29.0, 9.0, 8.0],
};

function inPolygon(lon: number, lat: number, poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface RegionStat {
  tempC: number;
  precipMm: number;
  /** ケッペン B(砂漠 + ステップ)。derle-climate の arid_pct と同一定義 */
  dryPct: number;
  tropicalPct: number;
  temperatePct: number;
  majorPct: number[];
}

export function regionStats(result: PipelineResult): Record<string, RegionStat> {
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const W = grid.widthCells;
  // デラドゥア狭海沿岸 = 海から 3 セル以内の陸(derle-climate の binary_dilation)
  const nearSea = new Uint8Array(grid.cellCount);
  for (let row = 0; row < grid.heightCells; row++) {
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      if (!land[i]) continue;
      let found = false;
      for (let dr = -3; dr <= 3 && !found; dr++) {
        const r = row + dr;
        if (r < 0 || r >= grid.heightCells) continue;
        for (let dc = -3; dc <= 3; dc++) {
          const c = (((col + dc) % W) + W) % W;
          if (!land[r * W + c]) {
            found = true;
            break;
          }
        }
      }
      if (found) nearSea[i] = 1;
    }
  }
  const tests: Record<string, (lon: number, lat: number, i: number) => boolean> = {
    '全球陸域': (_lon, _lat, i) => land[i] === 1,
    'ウィル地域ポリゴン': (lon, lat, i) => land[i] === 1 && inPolygon(lon, lat, WILL_VERTICES),
    'デラドゥア狭海沿岸': (_lon, _lat, i) => nearSea[i] === 1,
  };
  for (const [name, e] of Object.entries(ELLIPSES)) {
    const [cx, cy, rx, ry] = e;
    tests[name] = (lon, lat, i) =>
      land[i] === 1 && ((lon - cx) / rx) ** 2 + ((lat - cy) / ry) ** 2 <= 1;
  }
  const out: Record<string, RegionStat> = {};
  for (const [name, test] of Object.entries(tests)) {
    let w = 0;
    let tSum = 0;
    let p = 0;
    const majorW = new Array<number>(5).fill(0);
    for (let row = 0; row < grid.heightCells; row++) {
      const wt = areaWeightOfRow(grid, row);
      const lat = latDegOfRow(grid, row);
      for (let col = 0; col < W; col++) {
        const lon = -180 + (col + 0.5) * grid.resolutionDeg;
        const i = row * W + col;
        if (!test(lon, lat, i)) continue;
        w += wt;
        tSum += wt * (result.temperature.annualMeanC[i] ?? 0);
        p += wt * (result.precipitation.annualPrecipMm[i] ?? 0);
        const mj = majorClassOf(result.koppen.classId[i] ?? 0);
        if (mj >= 0) majorW[mj] = (majorW[mj] ?? 0) + wt;
      }
    }
    if (w <= 0) continue;
    const pct = (x: number) => Math.round((x / w) * 1000) / 10;
    out[name] = {
      tempC: Math.round((tSum / w) * 100) / 100,
      precipMm: Math.round(p / w),
      dryPct: pct(majorW[1] ?? 0),
      tropicalPct: pct(majorW[0] ?? 0),
      temperatePct: pct((majorW[2] ?? 0) + (majorW[3] ?? 0)),
      majorPct: majorW.map(pct),
    };
  }
  return out;
}

/** 正典の期待(derle-climate config/v11_shukkai.json の expected_profiles) */
export const LORE_CHECKS: Record<string, { label: string }> = {
  will_dry: { label: 'ウィル乾燥≥50%' },
  deladua_dry: { label: 'デラドゥア沿岸乾燥≥50%' },
  derle_temperate: { label: 'デーレ中核温帯≥50%' },
  derle_not_tropical: { label: 'デーレ中核熱帯<10%' },
  rutia_tropical: { label: 'ルティア熱帯≥50%' },
  shanteriya_not_arid: { label: 'シャンテリャ乾燥<50%' },
  global_not_overdry: { label: '全球乾燥<23.9%' },
};

export function evaluateLore(regions: Record<string, RegionStat>) {
  const g = regions['全球陸域']!;
  const will = regions['ウィル地域ポリゴン']!;
  const dela = regions['デラドゥア狭海沿岸']!;
  const derle = regions['デーレ中核']!;
  const rutia = regions['ルティア暫定域']!;
  const shan = regions['シャンテリャ本体']!;
  const checks = {
    will_dry: will.dryPct >= 50,
    deladua_dry: dela.dryPct >= 50,
    derle_temperate: derle.temperatePct >= 50,
    derle_not_tropical: derle.tropicalPct < 10,
    rutia_tropical: rutia.tropicalPct >= 50,
    shanteriya_not_arid: shan.dryPct < 50,
    global_not_overdry: g.dryPct < 23.9,
  };
  return {
    checks,
    score: Object.values(checks).filter(Boolean).length,
    globalMeanC: 0, // 呼び出し側で上書き(全球平均は海込みのため別途計算)
    landMeanC: g.tempC,
    landPrecipMm: g.precipMm,
    metrics: {
      will_dry: will.dryPct,
      deladua_dry: dela.dryPct,
      derle_temperate: derle.temperatePct,
      derle_tropical: derle.tropicalPct,
      rutia_tropical: rutia.tropicalPct,
      shanteriya_dry: shan.dryPct,
      global_dry: g.dryPct,
    },
  };
}

// ---- 居住可能性(エクメーネ / アネクメーネ)----
// 古典的な地理区分に従い、アネクメーネ(人の常住が困難な土地)を
//   氷雪(EF)・ツンドラ(ET)・砂漠(BW)
// とする。ステップ(BS)は牧畜が成り立つためエクメーネに含める。
// 「全土がアネクメーネの国が無いこと」を惑星設定の妥当性ベンチとして使う。
const ANECUMENE_CLASSES = new Set<number>();
{
  // KOPPEN_CLASSES の記号から該当クラスを拾う(番号の直書きを避ける)
  KOPPEN_CLASSES.forEach((sym, id) => {
    if (!sym) return;
    if (sym === 'EF' || sym === 'ET' || sym.startsWith('BW')) ANECUMENE_CLASSES.add(id);
  });
}

export interface CountryHabitability {
  name: string;
  lon: number;
  lat: number;
  /** 国土代理の陸セル数(アンカー中心・角半径 5°) */
  landCells: number;
  ecumenePct: number;
  topClass: string;
}

/** 国ごとの居住可能率。アンカー周辺 5° の陸セルを国土の代理とする */
export function countryHabitability(result: PipelineResult): {
  countries: CountryHabitability[];
  allAnecumeneCount: number;
  minEcumenePct: number;
} {
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const W = grid.widthCells;
  const RADIUS_DEG = 5;
  const list: CountryHabitability[] = [];
  for (const c of (derleCountries as { countries: Array<{ name: string; lon: number; lat: number }> })
    .countries) {
    let total = 0;
    let ecumene = 0;
    const counts = new Map<string, number>();
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = latDegOfRow(grid, row);
      if (Math.abs(lat - c.lat) > RADIUS_DEG) continue;
      const cosMid = Math.max(0.05, Math.cos(((lat + c.lat) / 2) * (Math.PI / 180)));
      for (let col = 0; col < W; col++) {
        const lon = -180 + (col + 0.5) * grid.resolutionDeg;
        let dLon = Math.abs(lon - c.lon);
        if (dLon > 180) dLon = 360 - dLon;
        if (Math.hypot(lat - c.lat, dLon * cosMid) > RADIUS_DEG) continue;
        const i = row * W + col;
        if (!land[i]) continue;
        const id = result.koppen.classId[i] ?? 0;
        if (id === 0) continue;
        total++;
        if (!ANECUMENE_CLASSES.has(id)) ecumene++;
        const sym = KOPPEN_CLASSES[id] ?? '?';
        counts.set(sym, (counts.get(sym) ?? 0) + 1);
      }
    }
    if (total === 0) continue; // 陸が無いアンカー(海上ラベル)は対象外
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    list.push({
      name: c.name,
      lon: c.lon,
      lat: c.lat,
      landCells: total,
      ecumenePct: Math.round((ecumene / total) * 1000) / 10,
      topClass: top ? top[0] : '?',
    });
  }
  const allAnecumeneCount = list.filter((c) => c.ecumenePct <= 0).length;
  const minEcumenePct = list.length > 0 ? Math.min(...list.map((c) => c.ecumenePct)) : 0;
  return { countries: list, allAnecumeneCount, minEcumenePct };
}

// ---- 国境ポリゴンによる居住可能性(アンカー近似の上位互換)----
// 国境は線ベクターとして地図に存在する。derle-map-visualizer の面復元
// (線 → 交点分割 → グラフ → 面)で得たポリゴンを国土とみなす。
//
// 無名ポリゴン(国名ラベルを内包しない面)は「実在自体が怪しいスタブ」
// として利用者が裁定したため、全土アネクメーネのペナルティを減衰させる。
export const STUB_PENALTY_WEIGHT = 0.25;
/** これ未満の陸セルしか持たない面は統計にのせない(離島の破片) */
const MIN_COUNTRY_LAND_CELLS = 3;

export interface PolygonCountry {
  name: string | null;
  isStub: boolean;
  landCells: number;
  ecumenePct: number;
  topClass: string;
}

interface PolygonSrc {
  name: string | null;
  isStub: boolean;
  ring: number[][];
}

/** 点が環の内側か(経度は環の代表経度に合わせて巻き戻す) */
function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i]!;
    const pj = ring[j]!;
    const yi = pi[1]!;
    const yj = pj[1]!;
    if (yi > lat !== yj > lat) {
      const xi = pi[0]!;
      const xj = pj[0]!;
      if (lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * 国境ポリゴンごとの居住可能率。
 * 名前つきの国が全土アネクメーネになるのは惑星設定の失敗とみなす。
 */
export function polygonHabitability(result: PipelineResult): {
  countries: PolygonCountry[];
  /** 名前つきで全土アネクメーネの国の数(0 が望ましい) */
  namedAllAnecumeneCount: number;
  /** 無名(スタブ)で全土アネクメーネの面の数 */
  stubAllAnecumeneCount: number;
  /** 重みつきペナルティ = 名前つき 1.0 + スタブ 0.25 の合計 */
  penalty: number;
  /** 名前つきの国の最小エクメーネ率 */
  minNamedEcumenePct: number;
  evaluated: number;
  /**
   * 居住可能性の総合得点 [0,1]。1 = 全土アネクメーネの国が皆無。
   * 面の総数に依らないよう「割合」で測り、名前つきとスタブを
   * STUB_PENALTY_WEIGHT で加重平均する。
   */
  habitScore01: number;
} {
  const src = (derlePolygons as { countries: PolygonSrc[] }).countries;
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const W = grid.widthCells;
  const list: PolygonCountry[] = [];

  for (const c of src) {
    // 環の外接矩形で粗く絞ってから内包判定
    let minLon = Infinity;
    let maxLon = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;
    for (const p of c.ring) {
      const x = p[0]!;
      const y = p[1]!;
      if (x < minLon) minLon = x;
      if (x > maxLon) maxLon = x;
      if (y < minLat) minLat = y;
      if (y > maxLat) maxLat = y;
    }
    let total = 0;
    let ecumene = 0;
    const counts = new Map<string, number>();
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = latDegOfRow(grid, row);
      if (lat < minLat || lat > maxLat) continue;
      for (let col = 0; col < W; col++) {
        const lon = -180 + (col + 0.5) * grid.resolutionDeg;
        if (lon < minLon || lon > maxLon) continue;
        const i = row * W + col;
        if (!land[i]) continue;
        const id = result.koppen.classId[i] ?? 0;
        if (id === 0) continue;
        if (!pointInRing(lon, lat, c.ring)) continue;
        total++;
        if (!ANECUMENE_CLASSES.has(id)) ecumene++;
        const sym = KOPPEN_CLASSES[id] ?? '?';
        counts.set(sym, (counts.get(sym) ?? 0) + 1);
      }
    }
    if (total < MIN_COUNTRY_LAND_CELLS) continue;
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    list.push({
      name: c.name,
      isStub: c.isStub,
      landCells: total,
      ecumenePct: Math.round((ecumene / total) * 1000) / 10,
      topClass: top ? top[0] : '?',
    });
  }

  const dead = list.filter((c) => c.ecumenePct <= 0);
  const namedAllAnecumeneCount = dead.filter((c) => !c.isStub).length;
  const stubAllAnecumeneCount = dead.filter((c) => c.isStub).length;
  const named = list.filter((c) => !c.isStub);
  const stubs = list.filter((c) => c.isStub);
  const namedDeadFrac = named.length > 0 ? namedAllAnecumeneCount / named.length : 0;
  const stubDeadFrac = stubs.length > 0 ? stubAllAnecumeneCount / stubs.length : 0;
  const habitScore01 =
    1 -
    (namedDeadFrac + STUB_PENALTY_WEIGHT * stubDeadFrac) / (1 + STUB_PENALTY_WEIGHT);
  return {
    countries: list,
    namedAllAnecumeneCount,
    stubAllAnecumeneCount,
    penalty:
      Math.round((namedAllAnecumeneCount + STUB_PENALTY_WEIGHT * stubAllAnecumeneCount) * 100) / 100,
    minNamedEcumenePct: named.length > 0 ? Math.min(...named.map((c) => c.ecumenePct)) : 0,
    evaluated: list.length,
    habitScore01: Math.round(habitScore01 * 1000) / 1000,
  };
}

/** 全球平均気温(海込み・面積重み) */
export function globalMeanTempC(result: PipelineResult): number {
  const grid = result.context.grid;
  let w = 0;
  let s = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const wt = areaWeightOfRow(grid, row);
    for (let col = 0; col < grid.widthCells; col++) {
      s += wt * (result.temperature.annualMeanC[row * grid.widthCells + col] ?? 0);
      w += wt;
    }
  }
  return s / w;
}

export async function runDerle(o: number | DerleOverrides, opts: RunOptions = {}) {
  const result = await runPipeline(derleParams(o), opts);
  const regions = regionStats(result);
  const lore = evaluateLore(regions);
  lore.globalMeanC = Math.round(globalMeanTempC(result) * 100) / 100;
  const habit = countryHabitability(result);
  const polyHabit = polygonHabitability(result);
  return { result, regions, lore, habit, polyHabit };
}
