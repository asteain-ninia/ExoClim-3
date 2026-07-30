// モデル定数の自動較正(地球を教師データにしたブラックボックス最適化)。
// 実行: npx tsx scripts/optimize.ts --minutes 50
// 状態は out/optimize/state.json に常時保存され、再実行で続きから回る。
// 評価は in-process(MODEL_CONSTANTS を直接書き換え → runPipeline)。
//
// 目的関数(2026-07-31 に事前凍結 — docs/較正記録.md 参照):
//   fitness = 大分類% + 1.1×地域ゲート通過数 + 0.25×詳細%
//             − 0.35×気温年RMSE − 0.004×降水年RMSE − 0.02×|陸平均降水−585|/10
// 最終採否は必ず scripts/validate.ts の標準レポートで人間(AI)が確認する。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runPipeline } from '../src/sim/pipeline';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { latDegOfRow, areaWeightOfRow } from '../src/domain/grid';
import { KOPPEN_CLASSES } from '../src/domain/koppen';
import type { PipelineResult } from '../src/sim/types';

const OUT_DIR = path.join(process.cwd(), 'out', 'optimize');
fs.mkdirSync(OUT_DIR, { recursive: true });
const STATE_PATH = path.join(OUT_DIR, 'state.json');
const LOG_PATH = path.join(OUT_DIR, 'log.jsonl');

// ---- 探索空間(名前、下限、上限)。構造整数・格子設定は含めない ----
const SPACE: Array<[keyof typeof MODEL_CONSTANTS, number, number]> = [
  // Step 6 降水
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
  // Step 5 気温(雲・移流・氷)
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
  // Step 1-4 循環
  ['itczMonsoonPullDeg', 7, 13],
  ['itczPlateauPullDeg', 6, 14],
  ['itczSmoothLocalBlend', 0.25, 0.55],
  ['itczDeclinationFollowRatio', 0.28, 0.42],
  ['subtropicalCellEastBoost', 0.3, 0.9],
  ['subpolarWinterLowHpa', 3, 7],
  ['tradeWindMs', 5, 7.5],
  ['westerlyWindMs', 6.5, 9],
];

// ---- 教師データ(検証と同じフィクスチャ)----
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

// ---- 地域ゲート(scripts/validate.ts と同一定義の複製。変更時は両方直す)----
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

interface Scores {
  majorPct: number;
  detailPct: number;
  gates: number;
  tempRmse: number;
  precipRmse: number;
  landMeanMm: number;
  fitness: number;
}

function evaluate(result: PipelineResult): Scores {
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

  // 気温 年RMSE(2° 観測、モデルを 2° に平均集約、cos 重み)
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
      // モデル側集約(陸セルのみ)
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

// ---- 状態と実行 ----
interface OptState {
  best: Record<string, number>;
  bestFit: number;
  bestScores: Scores | null;
  evals: number;
  sweep: number;
  cursor: number;
  stepFrac: number;
  sensitivity: Record<string, number>;
  phase: 'screen' | 'descent';
  screenCursor: number;
  seed: number;
}

function currentVector(): Record<string, number> {
  const v: Record<string, number> = {};
  for (const [name] of SPACE) v[name] = MODEL_CONSTANTS[name] as number;
  return v;
}

function applyVector(v: Record<string, number>): void {
  for (const [name] of SPACE) {
    if (v[name] !== undefined) (MODEL_CONSTANTS as Record<string, number>)[name] = v[name] ?? 0;
  }
}

function loadState(): OptState {
  if (fs.existsSync(STATE_PATH)) {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as OptState;
  }
  return {
    best: currentVector(),
    bestFit: -Infinity,
    bestScores: null,
    evals: 0,
    sweep: 0,
    cursor: 0,
    stepFrac: 0.18,
    sensitivity: {},
    phase: 'screen',
    screenCursor: 0,
    seed: 42,
  };
}

function saveState(s: OptState): void {
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 1));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function evalVector(state: OptState, v: Record<string, number>, tag: string): Scores {
  applyVector(v);
  const t0 = Date.now();
  const result = runPipeline(EARTH_PARAMS);
  const s = evaluate(result);
  state.evals++;
  fs.appendFileSync(
    LOG_PATH,
    JSON.stringify({
      i: state.evals,
      tag,
      fit: Math.round(s.fitness * 1000) / 1000,
      major: Math.round(s.majorPct * 100) / 100,
      detail: Math.round(s.detailPct * 100) / 100,
      gates: s.gates,
      tRmse: Math.round(s.tempRmse * 100) / 100,
      pRmse: Math.round(s.precipRmse),
      sec: Math.round((Date.now() - t0) / 100) / 10,
    }) + '\n',
  );
  return s;
}

function main(): void {
  const minutesArg = process.argv.indexOf('--minutes');
  const budgetMin = minutesArg >= 0 ? Number(process.argv[minutesArg + 1] ?? 45) : 45;
  const deadline = Date.now() + budgetMin * 60_000;
  const state = loadState();
  const rand = mulberry32(state.seed + state.sweep * 977 + state.evals);

  // 初回: 現行値を基準として評価
  if (state.bestFit === -Infinity) {
    const s = evalVector(state, state.best, 'baseline');
    state.bestFit = s.fitness;
    state.bestScores = s;
    saveState(state);
    console.log(`基準: fit=${s.fitness.toFixed(2)} 大分類=${s.majorPct.toFixed(1)} ゲート=${s.gates}`);
  }

  while (Date.now() < deadline) {
    if (state.phase === 'screen') {
      // 感度スクリーニング: 各定数 ±12%(範囲クランプ)で影響を測る
      if (state.screenCursor >= SPACE.length) {
        state.phase = 'descent';
        saveState(state);
        continue;
      }
      const [name, lo, hi] = SPACE[state.screenCursor] ?? ['olrAWm2', 0, 1];
      const base = state.best[name] ?? 0;
      const span = hi - lo;
      let gain = 0;
      for (const dir of [-1, 1]) {
        const cand = { ...state.best, [name]: Math.min(hi, Math.max(lo, base + dir * span * 0.08)) };
        if (cand[name] === base) continue;
        const s = evalVector(state, cand, `screen:${name}`);
        gain = Math.max(gain, Math.abs(s.fitness - state.bestFit));
        if (s.fitness > state.bestFit) {
          state.best = cand;
          state.bestFit = s.fitness;
          state.bestScores = s;
        }
      }
      state.sensitivity[name] = gain;
      state.screenCursor++;
      saveState(state);
      if (Date.now() >= deadline) break;
      continue;
    }

    // 座標降下: 感度順に ±step を試し、良ければ採用
    const order = [...SPACE].sort(
      (a, b) => (state.sensitivity[b[0]] ?? 0) - (state.sensitivity[a[0]] ?? 0),
    );
    if (state.cursor >= order.length) {
      state.cursor = 0;
      state.sweep++;
      state.stepFrac = Math.max(0.04, state.stepFrac * 0.6);
      // 停滞脱出: 感度上位 4 定数へ小さな種付き摂動
      const top = order.slice(0, 4);
      const jitter = { ...state.best };
      for (const [name, lo, hi] of top) {
        const span = hi - lo;
        jitter[name] = Math.min(
          hi,
          Math.max(lo, (jitter[name] ?? 0) + (rand() - 0.5) * span * 0.1),
        );
      }
      const s = evalVector(state, jitter, `jitter:sweep${state.sweep}`);
      if (s.fitness > state.bestFit) {
        state.best = jitter;
        state.bestFit = s.fitness;
        state.bestScores = s;
      }
      saveState(state);
      continue;
    }
    const [name, lo, hi] = order[state.cursor] ?? ['olrAWm2', 0, 1];
    const base = state.best[name] ?? 0;
    const span = hi - lo;
    for (const dir of [1, -1]) {
      const cand = {
        ...state.best,
        [name]: Math.min(hi, Math.max(lo, base + dir * span * state.stepFrac)),
      };
      if (cand[name] === base) continue;
      const s = evalVector(state, cand, `descent:s${state.sweep}:${name}`);
      if (s.fitness > state.bestFit) {
        state.best = cand;
        state.bestFit = s.fitness;
        state.bestScores = s;
        break; // 改善方向をひとまず採用して次の定数へ
      }
      if (Date.now() >= deadline) break;
    }
    state.cursor++;
    saveState(state);
  }

  saveState(state);
  const b = state.bestScores;
  console.log(
    `終了: evals=${state.evals} sweep=${state.sweep} phase=${state.phase} ` +
      `best fit=${state.bestFit.toFixed(2)}` +
      (b ? ` 大分類=${b.majorPct.toFixed(2)} 詳細=${b.detailPct.toFixed(2)} ゲート=${b.gates} 気温RMSE=${b.tempRmse.toFixed(2)}` : ''),
  );
  fs.writeFileSync(path.join(OUT_DIR, 'best.json'), JSON.stringify(state.best, null, 2));
}

main();
