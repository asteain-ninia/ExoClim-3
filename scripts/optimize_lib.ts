// 自動較正の共有部品: 探索空間・教師データ・リーン採点。
// scripts/optimize.ts(親)と scripts/optimize_worker.ts(評価ワーカー)が使う。
// 地域ゲートは scripts/validate.ts と同一定義の複製(変更時は両方直す)。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { latDegOfRow, areaWeightOfRow } from '../src/domain/grid';
import { KOPPEN_CLASSES } from '../src/domain/koppen';
import type { PipelineResult } from '../src/sim/types';

export const SPACE: Array<[keyof typeof MODEL_CONSTANTS, number, number]> = [
  ['moistureDecayOceanKm', 1500, 3200],
  ['moistureDecayLandKm', 1100, 2400],
  ['landRecyclingStrength', 0.2, 0.6],
  ['itczLiftBoost', 1.4, 3.2],
  ['itczLiftSupplyNorm', 0.6, 1.8],
  ['stormTrackBoost', 0.4, 1.1],
  ['stormTrackWinterBoost', 0.15, 0.6],
  ['orographicBoost', 0.9, 2.5],
  ['rainShadowFloor', 0.2, 0.55],
  ['subsidenceSuppression', 0.5, 0.82],
  ['subsidenceItczProtection', 0.6, 0.95],
  ['eastCoastSubsidenceRelief', 0.5, 0.95],
  ['eastCoastSubsidenceDecayKm', 600, 1300],
  ['eastReliefSupplyNorm', 0.4, 1.2],
  ['stormMinQRel', 0.25, 0.55],
  ['stormMoistureSupply', 1.0, 2.4],
  ['stormMoistureDecayKm', 1000, 2000],
  ['orographicDepletionM', 1000, 2600],
  ['upwindBlockReliefM', 800, 1800],
  ['upwindBlockFloor', 0.08, 0.3],
  ['coldCoastSuppression', 0.25, 0.6],
  ['precipScaleMmPerUnit', 7, 10],
  ['winterFloorFracOfWettest', 0.2, 0.5],
  ['winterFloorMaxMm', 12, 34],
  ['equatorialItczResidual', 0.3, 0.8],
  ['frontalLiftBoost', 0.4, 1.2],
  ['precipMonthBlend', 0.04, 0.2],
  ['warmHumidConvectiveBoost', 0, 0.4],
  ['warmHumidSupplyNorm', 2.0, 4.0],
  ['subsidenceCloudReduction', 0.5, 0.75],
  ['subsidenceOceanFactor', 0.25, 0.5],
  ['convectiveCloudBoost', 0.3, 0.6],
  ['stormTrackCloudBoost', 0.4, 0.8],
  ['cloudAlbedoMax', 0.36, 0.46],
  ['stormCloudSummerOcean', 0.5, 0.85],
  ['itczCloudWidthFactor', 0.7, 1.1],
  ['stratocumulusBoostPerNegC', 0.35, 0.75],
  ['channelCloudBoost', 0.35, 0.8],
  ['circumpolarChannelFactor', 0.2, 0.5],
  ['winterInversionAdvectionFactor', 0.35, 0.7],
  ['winterInversionDiffusionFactor', 0.5, 0.85],
  ['hadleyDiffusionBoost', 0.5, 1.2],
  ['zonalAdvectionCouplingWm2PerK', 30, 60],
  ['summerAdvectionFactor', 0.3, 0.6],
  ['seaIceInsulationFactor', 0.8, 0.95],
  ['albedoIce', 0.28, 0.42],
  ['permanentIceAlbedo', 0.55, 0.75],
  ['sstAnomalyCouplingWm2PerK', 12, 26],
  ['olrAWm2', 201, 206],
  ['diffusionWm2PerK', 0.45, 0.65],
  ['itczMonsoonPullDeg', 7, 13],
  ['itczPlateauPullDeg', 6, 14],
  ['itczSmoothLocalBlend', 0.25, 0.55],
  ['itczDeclinationFollowRatio', 0.28, 0.42],
  ['subtropicalCellEastBoost', 0.3, 0.9],
  ['subpolarWinterLowHpa', 3, 7],
  ['tradeWindMs', 5, 7.5],
  ['westerlyWindMs', 6.5, 9],
];

interface KoppenFixture {
  widthCells: number;
  heightCells: number;
  classRaster: number[];
}
interface ClimateFixture {
  widthCells: number;
  heightCells: number;
  monthlyTemperatureDeciC: number[][];
  monthlyPrecipitationMm: number[][];
}
const koppenObs = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/earth_koppen_1deg.json'), 'utf8'),
) as KoppenFixture;
const climObs = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/earth_climate_2deg.json'), 'utf8'),
) as ClimateFixture;

interface RegionGate {
  id: string;
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
  mode: 'major' | 'present';
  expect: string;
}
const REGION_GATES: RegionGate[] = [
  { id: 'sahara_arid', latMin: 18, latMax: 30, lonMin: -15, lonMax: 30, mode: 'major', expect: 'B' },
  { id: 'arabia_arid', latMin: 15, latMax: 30, lonMin: 35, lonMax: 55, mode: 'major', expect: 'B' },
  { id: 'australia_interior_arid', latMin: -30, latMax: -20, lonMin: 120, lonMax: 145, mode: 'major', expect: 'B' },
  { id: 'amazon_tropical', latMin: -10, latMax: 5, lonMin: -75, lonMax: -50, mode: 'major', expect: 'A' },
  { id: 'congo_tropical', latMin: -5, latMax: 5, lonMin: 12, lonMax: 30, mode: 'major', expect: 'A' },
  { id: 'india_tropical', latMin: 18, latMax: 26, lonMin: 73, lonMax: 87, mode: 'major', expect: 'A' },
  { id: 'us_southeast_humid', latMin: 30, latMax: 37, lonMin: -95, lonMax: -78, mode: 'major', expect: 'C' },
  { id: 'east_asia_humid', latMin: 25, latMax: 35, lonMin: 105, lonMax: 122, mode: 'major', expect: 'C' },
  { id: 'west_europe_temperate', latMin: 47, latMax: 59, lonMin: -5, lonMax: 15, mode: 'major', expect: 'C' },
  { id: 'europe_russia_continental', latMin: 50, latMax: 65, lonMin: 35, lonMax: 55, mode: 'major', expect: 'D' },
  { id: 'west_siberia_continental', latMin: 55, latMax: 65, lonMin: 60, lonMax: 90, mode: 'major', expect: 'D' },
  { id: 'east_siberia_continental', latMin: 55, latMax: 68, lonMin: 100, lonMax: 140, mode: 'major', expect: 'D' },
  { id: 'mediterranean_cs_present', latMin: 31, latMax: 44, lonMin: -10, lonMax: 35, mode: 'present', expect: 'Cs' },
  { id: 'california_cs_present', latMin: 33, latMax: 40, lonMin: -124, lonMax: -118, mode: 'present', expect: 'Cs' },
  { id: 'tibet_cold_highland', latMin: 28, latMax: 36, lonMin: 80, lonMax: 95, mode: 'present', expect: 'ET' },
  { id: 'patagonia_rainshadow', latMin: -50, latMax: -40, lonMin: -72, lonMax: -65, mode: 'major', expect: 'B' },
  { id: 'antarctica_ice', latMin: -90, latMax: -75, lonMin: -180, lonMax: 180, mode: 'major', expect: 'E' },
];

function majorClassOf(id: number): number {
  if (id >= 1 && id <= 3) return 0;
  if (id >= 4 && id <= 7) return 1;
  if (id >= 8 && id <= 16) return 2;
  if (id >= 17 && id <= 28) return 3;
  if (id >= 29) return 4;
  return -1;
}

export interface Scores {
  majorPct: number;
  detailPct: number;
  gates: number;
  tempRmse: number;
  precipRmse: number;
  landMeanMm: number;
  fitness: number;
}

export function evaluateResult(result: PipelineResult): Scores {
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const model = result.koppen.classId;
  const W = grid.widthCells;
  let wTotal = 0;
  let wDetail = 0;
  let wMajor = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const w = areaWeightOfRow(grid, row);
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      const o = koppenObs.classRaster[i] ?? 0;
      if (!land[i] || o === 0) continue;
      const m = model[i] ?? 0;
      if (m === 0) continue;
      wTotal += w;
      if (m === o) wDetail += w;
      if (majorClassOf(m) === majorClassOf(o)) wMajor += w;
    }
  }
  const majorPct = (wMajor / wTotal) * 100;
  const detailPct = (wDetail / wTotal) * 100;

  let gates = 0;
  for (const g of REGION_GATES) {
    const counts = new Map<string, number>();
    const majorCounts = new Array<number>(5).fill(0);
    let total = 0;
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = latDegOfRow(grid, row);
      if (lat < g.latMin || lat > g.latMax) continue;
      for (let col = 0; col < W; col++) {
        const lon = -180 + (col + 0.5) * grid.resolutionDeg;
        if (lon < g.lonMin || lon > g.lonMax) continue;
        const i = row * W + col;
        if (!land[i]) continue;
        const id = model[i] ?? 0;
        if (id === 0) continue;
        total++;
        const sym = KOPPEN_CLASSES[id] ?? '?';
        counts.set(sym, (counts.get(sym) ?? 0) + 1);
        const mj = majorClassOf(id);
        if (mj >= 0) majorCounts[mj] = (majorCounts[mj] ?? 0) + 1;
      }
    }
    if (total === 0) continue;
    if (g.mode === 'major') {
      const majorIdx = 'ABCDE'.indexOf(g.expect);
      if ((majorCounts[majorIdx] ?? 0) / total > 0.5) gates++;
    } else {
      let matched = 0;
      for (const [sym, c] of counts.entries()) if (sym.startsWith(g.expect)) matched += c;
      if (matched / total >= 0.1) gates++;
    }
  }

  const f = Math.round(2 / grid.resolutionDeg);
  let se = 0;
  let wsum = 0;
  let pse = 0;
  let pw = 0;
  let pModelSum = 0;
  let pObsSum = 0;
  for (let cr = 0; cr < climObs.heightCells; cr++) {
    const lat = 89 - cr * 2;
    const w = Math.cos((lat * Math.PI) / 180);
    for (let cc = 0; cc < climObs.widthCells; cc++) {
      const ci = cr * climObs.widthCells + cc;
      let tObsSum = 0;
      let ok = true;
      for (let m = 0; m < 12; m++) {
        const v = climObs.monthlyTemperatureDeciC[m]?.[ci] ?? -9999;
        if (v === -9999) {
          ok = false;
          break;
        }
        tObsSum += v / 10;
      }
      let tSum = 0;
      let pSum = 0;
      let n = 0;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const gr = cr * f + dr;
          const gc = cc * f + dc;
          if (gr >= grid.heightCells || gc >= grid.widthCells) continue;
          const gi = gr * grid.widthCells + gc;
          if (!land[gi]) continue;
          n++;
          tSum += result.temperature.annualMeanC[gi] ?? 0;
          pSum += result.precipitation.annualPrecipMm[gi] ?? 0;
        }
      }
      if (n === 0) continue;
      if (ok) {
        const d = tSum / n - tObsSum / 12;
        se += w * d * d;
        wsum += w;
      }
      let pObs = 0;
      let pOk = true;
      for (let m = 0; m < 12; m++) {
        const v = climObs.monthlyPrecipitationMm[m]?.[ci] ?? -9999;
        if (v === -9999) {
          pOk = false;
          break;
        }
        pObs += v;
      }
      if (pOk) {
        const dp = pSum / n - pObs;
        pse += w * dp * dp;
        pw += w;
        pModelSum += (w * pSum) / n;
        pObsSum += w * pObs;
      }
    }
  }
  const tempRmse = Math.sqrt(se / Math.max(1e-9, wsum));
  const precipRmse = Math.sqrt(pse / Math.max(1e-9, pw));
  const landMeanMm = pModelSum / Math.max(1e-9, pw);
  const landMeanObs = pObsSum / Math.max(1e-9, pw);

  const fitness =
    majorPct +
    1.1 * gates +
    0.25 * detailPct -
    0.35 * tempRmse -
    0.004 * precipRmse -
    (0.02 * Math.abs(landMeanMm - landMeanObs)) / 10;
  return { majorPct, detailPct, gates, tempRmse, precipRmse, landMeanMm, fitness };
}
