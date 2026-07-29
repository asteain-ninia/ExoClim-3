// ヘッドレス検証ハーネス。docs/要件.md §6
// 実在地球パラメータでパイプラインを実行し、Beck et al. 2023 の観測ラスター・
// 月別平年値と比較して自動採点する。出力: out/validate/ に PNG + report.json。
// 受入基準は docs/要件.md §6 に固定(結果を見て緩めない — 教訓 §8.3)。

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { runPipeline } from '../src/sim/pipeline';
import { KOPPEN_CLASSES, KOPPEN_COLORS, majorClassOf, MAJOR_CLASS_NAMES } from '../src/domain/koppen';
import { latDegOfRow, areaWeightOfRow } from '../src/domain/grid';
import type { PipelineResult } from '../src/sim/types';

const OUT_DIR = path.join(process.cwd(), 'out', 'validate');

interface KoppenFixture {
  widthCells: number;
  heightCells: number;
  classes: string[];
  classRaster: number[];
}
interface ClimateFixture {
  widthCells: number;
  heightCells: number;
  monthlyTemperatureDeciC: number[][];
  monthlyPrecipitationMm: number[][];
}

function loadJson<T>(rel: string): T {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), rel), 'utf8')) as T;
}

// ---- 地域ゲート(検証側にのみ置く地球の地理。計算層には一切入れない) ----
interface RegionGate {
  id: string;
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
  /** 'major' = 大分類の過半、'present' = 指定クラス群が10%以上 */
  mode: 'major' | 'present';
  expect: string; // 大分類 'A'|'B'|'C'|'D'|'E' または 'Cs' などの接頭辞
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

function main(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const t0 = Date.now();
  console.log('パイプライン実行中(実在地球 1°)…');
  const result = runPipeline(EARTH_PARAMS);
  console.log('所要時間:', ((Date.now() - t0) / 1000).toFixed(1), 's', result.stepTimingsMs);

  const koppenObs = loadJson<KoppenFixture>('tests/fixtures/earth_koppen_1deg.json');
  const climObs = loadJson<ClimateFixture>('tests/fixtures/earth_climate_2deg.json');

  const report = {
    generatedAt: new Date().toISOString(),
    stepTimingsMs: result.stepTimingsMs,
    koppen: scoreKoppen(result, koppenObs),
    temperature: scoreTemperature(result, climObs),
    precipitation: scorePrecipitation(result, climObs),
    regionGates: scoreRegionGates(result),
  };

  renderAll(result, koppenObs);

  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  printSummary(report);
}

// ---- ケッペン混同行列 ----
function scoreKoppen(result: PipelineResult, obs: KoppenFixture) {
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const model = result.koppen.classId;
  let wTotal = 0;
  let wDetailHit = 0;
  let wMajorHit = 0;
  const areaModel = new Array<number>(31).fill(0);
  const areaObs = new Array<number>(31).fill(0);
  const majorAreaModel = new Array<number>(5).fill(0);
  const majorAreaObs = new Array<number>(5).fill(0);
  const confusion: number[][] = Array.from({ length: 5 }, () => new Array<number>(5).fill(0));

  for (let row = 0; row < grid.heightCells; row++) {
    const w = areaWeightOfRow(grid, row);
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      const o = obs.classRaster[i] ?? 0;
      if (!land[i] || o === 0) continue; // 共通陸セルのみ採点
      const mdl = model[i] ?? 0;
      if (mdl === 0) continue;
      wTotal += w;
      if (mdl === o) wDetailHit += w;
      const mM = majorClassOf(mdl);
      const mO = majorClassOf(o);
      if (mM === mO) wMajorHit += w;
      areaModel[mdl] = (areaModel[mdl] ?? 0) + w;
      areaObs[o] = (areaObs[o] ?? 0) + w;
      if (mM >= 0 && mO >= 0) {
        majorAreaModel[mM] = (majorAreaModel[mM] ?? 0) + w;
        majorAreaObs[mO] = (majorAreaObs[mO] ?? 0) + w;
        const rowC = confusion[mO];
        if (rowC) rowC[mM] = (rowC[mM] ?? 0) + w;
      }
    }
  }
  const pct = (x: number) => Math.round((x / wTotal) * 1000) / 10;
  return {
    scoredCells: '共通陸セル(モデル陸 ∩ Beck 陸)',
    detailedAccuracyPct: pct(wDetailHit),
    majorAccuracyPct: pct(wMajorHit),
    majorAreaPctModel: majorAreaModel.map(pct),
    majorAreaPctObs: majorAreaObs.map(pct),
    majorAreaGapPt: majorAreaModel.map((v, k) => Math.round((pct(v) - pct(majorAreaObs[k] ?? 0)) * 10) / 10),
    confusionMajorPct: confusion.map((r) => r.map(pct)),
    topClassesModel: topClasses(areaModel, wTotal),
    topClassesObs: topClasses(areaObs, wTotal),
  };
}

function topClasses(area: number[], wTotal: number) {
  return area
    .map((w, id) => ({ cls: KOPPEN_CLASSES[id] ?? '?', pct: Math.round((w / wTotal) * 1000) / 10 }))
    .filter((e) => e.pct > 0.5)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 12);
}

// ---- 気温採点(2° 平年値と比較) ----
function scoreTemperature(result: PipelineResult, clim: ClimateFixture) {
  const grid = result.context.grid;
  const f = Math.round(2 / grid.resolutionDeg); // 2° フィクスチャに合わせる集約係数
  const months = [0, 6];
  const rmseByMonth: Record<string, number> = {};
  let annualSse = 0;
  let annualN = 0;
  const zonal: Array<{ lat: number; obsAnnual: number; modelAnnual: number }> = [];
  const zonalAcc = new Map<number, { o: number; m: number; n: number }>();

  for (const label of ['annual', 'month0_Jan', 'month6_Jul']) {
    void label;
  }
  for (let cr = 0; cr < clim.heightCells; cr++) {
    for (let cc = 0; cc < clim.widthCells; cc++) {
      const ci = cr * clim.widthCells + cc;
      // 観測: 月別。欠測(-9999)はスキップ。陸セル基準(観測は陸のみ有効値)
      const obsMonthly: number[] = [];
      let ok = true;
      for (let m = 0; m < 12; m++) {
        const v = clim.monthlyTemperatureDeciC[m]?.[ci] ?? -9999;
        if (v === -9999) {
          ok = false;
          break;
        }
        obsMonthly.push(v / 10);
      }
      if (!ok) continue;
      // モデル: 対応する f×f ブロック平均(陸セルのみ)
      const modelMonthly = new Array<number>(12).fill(0);
      let n = 0;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const gr = cr * f + dr;
          const gc = cc * f + dc;
          if (gr >= grid.heightCells || gc >= grid.widthCells) continue;
          const gi = gr * grid.widthCells + gc;
          if (!result.context.terrain.landMask[gi]) continue;
          n++;
          for (let m = 0; m < 12; m++) {
            modelMonthly[m] = (modelMonthly[m] ?? 0) + (result.temperature.monthlyTemperatureC[m]?.[gi] ?? 0);
          }
        }
      }
      if (n === 0) continue;
      for (let m = 0; m < 12; m++) modelMonthly[m] = (modelMonthly[m] ?? 0) / n;
      const obsAnnual = obsMonthly.reduce((a, b) => a + b, 0) / 12;
      const modelAnnual = modelMonthly.reduce((a, b) => a + b, 0) / 12;
      annualSse += (obsAnnual - modelAnnual) ** 2;
      annualN++;
      for (const m of months) {
        const key = `month${m}`;
        const d = (obsMonthly[m] ?? 0) - (modelMonthly[m] ?? 0);
        rmseByMonth[key] = (rmseByMonth[key] ?? 0) + d * d;
      }
      const latBand = Math.round((89 - cr * 2) / 10) * 10;
      const acc = zonalAcc.get(latBand) ?? { o: 0, m: 0, n: 0 };
      acc.o += obsAnnual;
      acc.m += modelAnnual;
      acc.n++;
      zonalAcc.set(latBand, acc);
    }
  }
  for (const [lat, acc] of [...zonalAcc.entries()].sort((a, b) => b[0] - a[0])) {
    zonal.push({
      lat,
      obsAnnual: Math.round((acc.o / acc.n) * 10) / 10,
      modelAnnual: Math.round((acc.m / acc.n) * 10) / 10,
    });
  }
  return {
    annualRmseC: Math.round(Math.sqrt(annualSse / Math.max(1, annualN)) * 100) / 100,
    janRmseC: Math.round(Math.sqrt((rmseByMonth['month0'] ?? 0) / Math.max(1, annualN)) * 100) / 100,
    julRmseC: Math.round(Math.sqrt((rmseByMonth['month6'] ?? 0) / Math.max(1, annualN)) * 100) / 100,
    zonalAnnual: zonal,
  };
}

// ---- 降水採点 ----
function scorePrecipitation(result: PipelineResult, clim: ClimateFixture) {
  const grid = result.context.grid;
  const f = Math.round(2 / grid.resolutionDeg);
  let obsSum = 0;
  let modelSum = 0;
  let n = 0;
  let sse = 0;
  let corrN = 0;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let cr = 0; cr < clim.heightCells; cr++) {
    for (let cc = 0; cc < clim.widthCells; cc++) {
      const ci = cr * clim.widthCells + cc;
      let obsAnnual = 0;
      let ok = true;
      for (let m = 0; m < 12; m++) {
        const v = clim.monthlyPrecipitationMm[m]?.[ci] ?? -9999;
        if (v === -9999) {
          ok = false;
          break;
        }
        obsAnnual += v;
      }
      if (!ok) continue;
      let modelAnnual = 0;
      let nn = 0;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const gr = cr * f + dr;
          const gc = cc * f + dc;
          if (gr >= grid.heightCells || gc >= grid.widthCells) continue;
          const gi = gr * grid.widthCells + gc;
          if (!result.context.terrain.landMask[gi]) continue;
          nn++;
          modelAnnual += result.precipitation.annualPrecipMm[gi] ?? 0;
        }
      }
      if (nn === 0) continue;
      modelAnnual /= nn;
      obsSum += obsAnnual;
      modelSum += modelAnnual;
      sse += (obsAnnual - modelAnnual) ** 2;
      n++;
      const lx = Math.log1p(obsAnnual);
      const ly = Math.log1p(modelAnnual);
      sx += lx; sy += ly; sxx += lx * lx; syy += ly * ly; sxy += lx * ly;
      corrN++;
    }
  }
  const corr =
    (corrN * sxy - sx * sy) /
    Math.sqrt(Math.max(1e-9, (corrN * sxx - sx * sx) * (corrN * syy - sy * sy)));
  return {
    obsLandMeanMmPerYear: Math.round(obsSum / Math.max(1, n)),
    modelLandMeanMmPerYear: Math.round(modelSum / Math.max(1, n)),
    annualRmseMm: Math.round(Math.sqrt(sse / Math.max(1, n))),
    logCorrelation: Math.round(corr * 1000) / 1000,
  };
}

// ---- 地域ゲート ----
function scoreRegionGates(result: PipelineResult) {
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const gates: Array<{ id: string; pass: boolean; detail: string }> = [];
  for (const g of REGION_GATES) {
    const counts = new Map<string, number>();
    const majorCounts = new Array<number>(5).fill(0);
    let total = 0;
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = latDegOfRow(grid, row);
      if (lat < g.latMin || lat > g.latMax) continue;
      for (let col = 0; col < grid.widthCells; col++) {
        const lon = -180 + (col + 0.5) * grid.resolutionDeg;
        if (lon < g.lonMin || lon > g.lonMax) continue;
        const i = row * grid.widthCells + col;
        if (!land[i]) continue;
        const id = result.koppen.classId[i] ?? 0;
        if (id === 0) continue;
        total++;
        const sym = KOPPEN_CLASSES[id] ?? '?';
        counts.set(sym, (counts.get(sym) ?? 0) + 1);
        const mj = majorClassOf(id);
        if (mj >= 0) majorCounts[mj] = (majorCounts[mj] ?? 0) + 1;
      }
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const detail = top.map(([s, c]) => `${s} ${Math.round((c / Math.max(1, total)) * 100)}%`).join(', ');
    let pass = false;
    if (total === 0) {
      pass = false;
    } else if (g.mode === 'major') {
      const majorIdx = 'ABCDE'.indexOf(g.expect);
      pass = (majorCounts[majorIdx] ?? 0) / total > 0.5;
    } else {
      let matched = 0;
      for (const [sym, c] of counts.entries()) if (sym.startsWith(g.expect)) matched += c;
      pass = matched / total >= 0.1;
    }
    gates.push({ id: g.id, pass, detail });
  }
  return gates;
}

// ---- PNG 出力 ----
function renderAll(result: PipelineResult, obs: KoppenFixture): void {
  const grid = result.context.grid;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const land = result.context.terrain.landMask;

  renderPng('koppen_model.png', W, H, (i) => {
    const id = result.koppen.classId[i] ?? 0;
    if (!land[i]) return [15, 30, 55];
    return (KOPPEN_COLORS[id] ?? [0, 0, 0]) as unknown as [number, number, number];
  });
  renderPng('koppen_obs.png', W, H, (i) => {
    const id = obs.classRaster[i] ?? 0;
    if (id === 0) return [15, 30, 55];
    return (KOPPEN_COLORS[id] ?? [0, 0, 0]) as unknown as [number, number, number];
  });
  renderPng('temp_annual.png', W, H, (i) => tempColor(result.temperature.annualMeanC[i] ?? 0, land[i] === 1));
  renderPng('temp_jan.png', W, H, (i) => tempColor(result.temperature.monthlyTemperatureC[0]?.[i] ?? 0, land[i] === 1));
  renderPng('temp_jul.png', W, H, (i) => tempColor(result.temperature.monthlyTemperatureC[6]?.[i] ?? 0, land[i] === 1));
  renderPng('precip_annual.png', W, H, (i) => precipColor(result.precipitation.annualPrecipMm[i] ?? 0, land[i] === 1));
  renderPng('terrain.png', W, H, (i) => {
    const e = result.context.terrain.elevationMeters[i] ?? 0;
    if (!land[i]) return [20, 40 + Math.max(0, 60 + e / 100), 120];
    const g = Math.min(255, 90 + e / 25);
    return [g * 0.7, g, g * 0.5];
  });
}

function tempColor(t: number, isLand: boolean): [number, number, number] {
  const x = Math.max(-45, Math.min(45, t)) / 45;
  const r = x > 0 ? 255 : Math.round(255 * (1 + x));
  const b = x < 0 ? 255 : Math.round(255 * (1 - x));
  const g = Math.round(200 * (1 - Math.abs(x)) + (isLand ? 30 : 0));
  return [r, g, b];
}

function precipColor(mm: number, isLand: boolean): [number, number, number] {
  if (!isLand) return [15, 30, 55];
  const x = Math.min(1, Math.log1p(mm) / Math.log1p(4000));
  return [Math.round(250 - 210 * x), Math.round(245 - 120 * x), Math.round(220 - 60 * x)];
}

function renderPng(
  name: string,
  W: number,
  H: number,
  colorOf: (i: number) => [number, number, number] | readonly [number, number, number],
): void {
  const scale = 3;
  const png = new PNG({ width: W * scale, height: H * scale });
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      const [r, g, b] = colorOf(row * W + col);
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const idx = ((row * scale + dy) * W * scale + col * scale + dx) * 4;
          png.data[idx] = r;
          png.data[idx + 1] = g;
          png.data[idx + 2] = b;
          png.data[idx + 3] = 255;
        }
      }
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, name), PNG.sync.write(png));
}

function printSummary(report: {
  koppen: ReturnType<typeof scoreKoppen>;
  temperature: ReturnType<typeof scoreTemperature>;
  precipitation: ReturnType<typeof scorePrecipitation>;
  regionGates: ReturnType<typeof scoreRegionGates>;
}): void {
  console.log('\n===== 地球検証サマリ =====');
  console.log(
    `ケッペン一致率: 詳細 ${report.koppen.detailedAccuracyPct}% / 大分類 ${report.koppen.majorAccuracyPct}%`,
  );
  console.log('大分類 面積%(モデル vs 観測):');
  for (let k = 0; k < 5; k++) {
    console.log(
      `  ${MAJOR_CLASS_NAMES[k]}: ${report.koppen.majorAreaPctModel[k]}% vs ${report.koppen.majorAreaPctObs[k]}% (差 ${report.koppen.majorAreaGapPt[k]}pt)`,
    );
  }
  console.log(
    `気温 RMSE: 年平均 ${report.temperature.annualRmseC}°C / 1月 ${report.temperature.janRmseC}°C / 7月 ${report.temperature.julRmseC}°C`,
  );
  console.log(
    `降水: 陸平均 モデル ${report.precipitation.modelLandMeanMmPerYear}mm vs 観測 ${report.precipitation.obsLandMeanMmPerYear}mm / RMSE ${report.precipitation.annualRmseMm}mm / log相関 ${report.precipitation.logCorrelation}`,
  );
  const passed = report.regionGates.filter((g) => g.pass).length;
  console.log(`地域ゲート: ${passed} / ${report.regionGates.length} PASS`);
  for (const g of report.regionGates) {
    console.log(`  ${g.pass ? '✅' : '❌'} ${g.id}: ${g.detail}`);
  }
  console.log('\nモデル上位クラス:', report.koppen.topClassesModel.map((e) => `${e.cls} ${e.pct}%`).join(', '));
  console.log('観測上位クラス:', report.koppen.topClassesObs.map((e) => `${e.cls} ${e.pct}%`).join(', '));
  console.log(`\nPNG とレポート: ${OUT_DIR}`);
}

main();
