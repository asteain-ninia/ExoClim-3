// ヘッドレス検証ハーネス。docs/要件.md §6
// 実在地球パラメータでパイプラインを実行し、Beck et al. 2023 の観測ラスター・
// 月別平年値と比較して自動採点する。出力: out/validate/ に PNG + report.json。
// 受入基準は docs/要件.md §6 に固定(結果を見て緩めない — 教訓 §8.3)。

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { runPipeline } from '../src/sim/pipeline';
import { KOPPEN_CLASSES, KOPPEN_COLORS, MAJOR_CLASS_NAMES } from '../src/domain/koppen';
import type { PipelineResult } from '../src/sim/types';
import {
  fieldScore,
  getClimObs,
  getKoppenObs,
  itczLineRmse,
  koppenScore,
  scoreRegionGates,
  type ClimateFixture,
  type KoppenFixture,
  type RegionGateResult,
} from './scoring';
import {
  ACCEPTANCE_CRITERIA,
  REGRESSION_BASELINE,
  evaluateAcceptance,
  evaluateRegression,
} from './validate_criteria';
import { regionKoppenDiag, regionPrecipDiag } from './scoring_regions';

const OUT_DIR = path.join(process.cwd(), 'out', 'validate');
// 採点定義は scripts/scoring.ts に一元化(P0-3)。ここでは複製しない。
// 正本の集計は面積重み(cos 緯度)。旧来のセル単純平均は「非面積重み」の
// 診断値として nonAreaWeighted 配下にのみ残す。

function main(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const t0 = Date.now();
  console.log('パイプライン実行中(実在地球 1°)…');
  const result = runPipeline(EARTH_PARAMS);
  console.log('所要時間:', ((Date.now() - t0) / 1000).toFixed(1), 's', result.stepTimingsMs);

  const koppenObs = getKoppenObs();
  const climObs = getClimObs();

  const f = fieldScore(result, climObs);
  const k = koppenScore(result, koppenObs);
  const koppen = formatKoppen(result, koppenObs);
  const temperatureNW = scoreTemperatureNonWeighted(result, climObs);
  const regionGates = scoreRegionGates(result);
  const gatesPassed = regionGates.filter((g) => g.pass).length;
  const itczRmseDeg = itczLineRmse(result, climObs);

  // P0-4: 退行防止(凍結基準・CI 用、非零終了)と最終受入(要件 §6)の分離判定
  const regression = evaluateRegression({
    majorPct: k.majorPct,
    detailPct: k.detailPct,
    gates: gatesPassed,
    tempRmseC: f.tempRmseC,
    precipRmseMm: f.precipRmseMm,
    itczRmseDeg,
    landMeanModelMm: f.landMeanModelMm,
    landMeanObsMm: f.landMeanObsMm,
  });
  const acceptance = evaluateAcceptance({
    majorAreaGapPt: koppen.majorAreaGapPt,
    gatesPassed,
    gatesTotal: regionGates.length,
    zonalTempAbsDiffsC: temperatureNW.zonalAnnual.flatMap((z) => [
      Math.abs(z.modelAnnual - z.obsAnnual),
      Math.abs(z.modelJan - z.obsJan),
      Math.abs(z.modelJul - z.obsJul),
    ]),
  });

  const report = {
    generatedAt: new Date().toISOString(),
    stepTimingsMs: result.stepTimingsMs,
    weighting:
      '正本の集計は面積重み(cos 緯度)。nonAreaWeighted はセル単純平均の非面積重み診断値。' +
      '観測欠損(-9999)セルは除外、採点は共通陸セル(モデル陸 ∩ 観測有効)のみ',
    regressionPass: regression.pass,
    acceptancePass: acceptance.pass,
    regression: { ...regression, baseline: REGRESSION_BASELINE },
    acceptance: {
      ...acceptance,
      criteria: ACCEPTANCE_CRITERIA,
      note: '要件 §6-2(理想化大陸)・§6-3(退化条件)は別ハーネスで判定する',
    },
    koppen,
    temperature: {
      annualRmseC: round2(f.tempRmseC),
      janRmseC: round2(f.tempJanRmseC),
      julRmseC: round2(f.tempJulRmseC),
      nonAreaWeighted: temperatureNW,
    },
    precipitation: {
      modelLandMeanMmPerYear: Math.round(f.landMeanModelMm),
      obsLandMeanMmPerYear: Math.round(f.landMeanObsMm),
      annualRmseMm: Math.round(f.precipRmseMm),
      logCorrelation: Math.round(f.logCorrelation * 1000) / 1000,
      nonAreaWeighted: scorePrecipitationNonWeighted(result, climObs),
    },
    itcz: {
      lineRmseRainWeightedDeg: round2(itczRmseDeg),
    },
    regionGates,
    // R0(地域降水 FB): 報告専用の地域診断。目的関数には入れない
    regionDiagnostics: {
      note:
        '面積重み(cos 緯度)・2° 観測有効セルのみ・モデルは陸ブロック平均・' +
        '最乾/最多雨月は地域平均月別系列の最小/最大。詳細は scoring_regions.ts 冒頭',
      precip: regionPrecipDiag(result, climObs),
      koppen: regionKoppenDiag(result, koppenObs),
    },
    logStructure: scoreLogStructure(result, koppenObs),
  };

  renderAll(result, koppenObs);

  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  printSummary(report);

  console.log('地域降水診断(R0、報告のみ — モデル/観測):');
  for (const p of report.regionDiagnostics.precip) {
    const kd = report.regionDiagnostics.koppen.find((x) => x.id === p.id);
    console.log(
      `  ${p.label}: 年 ${p.modelAnnualMm}/${p.obsAnnualMm}mm (比 ${p.ratio})` +
        ` 最乾月 ${p.modelDriestMm}/${p.obsDriestMm}mm 最多雨月 ${p.modelWettestMm}/${p.obsWettestMm}mm` +
        (kd ? ` Af+Am ${kd.afAmModelPct}% vs ${kd.afAmObsPct}%` : ''),
    );
  }

  console.log(
    `\n退行防止ゲート(基準凍結 ${REGRESSION_BASELINE.frozenAt}): ${regression.pass ? '✅ PASS' : '❌ FAIL — 非零終了'}`,
  );
  for (const msg of regression.failures) console.log(`  ❌ ${msg}`);
  console.log(
    `最終受入ゲート(要件 §6-1、凍結 ${ACCEPTANCE_CRITERIA.frozenAt}): ${acceptance.pass ? '✅ 達成' : '⏳ 未達(正直な現在地。終了コードには影響しない)'}`,
  );
  for (const msg of acceptance.failures) console.log(`  ⏳ ${msg}`);
  process.exitCode = regression.pass ? 0 : 1;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// ---- ケッペン(採点は scoring.ts、ここは報告用の整形のみ) ----
function formatKoppen(result: PipelineResult, obs: KoppenFixture) {
  const k = koppenScore(result, obs);
  const pct = (x: number) => Math.round((x / k.wTotal) * 1000) / 10;
  return {
    scoredCells: '共通陸セル(モデル陸 ∩ Beck 陸)',
    detailedAccuracyPct: Math.round(k.detailPct * 10) / 10,
    majorAccuracyPct: Math.round(k.majorPct * 10) / 10,
    majorAreaPctModel: k.majorAreaModelW.map(pct),
    majorAreaPctObs: k.majorAreaObsW.map(pct),
    majorAreaGapPt: k.majorAreaModelW.map(
      (v, idx) => Math.round((pct(v) - pct(k.majorAreaObsW[idx] ?? 0)) * 10) / 10,
    ),
    confusionMajorPct: k.confusionW.map((r) => r.map(pct)),
    topClassesModel: topClasses(k.areaModelW, k.wTotal),
    topClassesObs: topClasses(k.areaObsW, k.wTotal),
  };
}

function topClasses(area: number[], wTotal: number) {
  return area
    .map((w, id) => ({ cls: KOPPEN_CLASSES[id] ?? '?', pct: Math.round((w / wTotal) * 1000) / 10 }))
    .filter((e) => e.pct > 0.5)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 12);
}

// ---- 気温の非面積重み診断(セル単純平均。正本は scoring.ts の面積重み版) ----
function scoreTemperatureNonWeighted(result: PipelineResult, clim: ClimateFixture) {
  const grid = result.context.grid;
  const f = Math.round(2 / grid.resolutionDeg); // 2° フィクスチャに合わせる集約係数
  const months = [0, 6];
  const rmseByMonth: Record<string, number> = {};
  let annualSse = 0;
  let annualN = 0;
  const zonal: Array<{
    lat: number;
    obsAnnual: number;
    modelAnnual: number;
    obsJan: number;
    modelJan: number;
    obsJul: number;
    modelJul: number;
  }> = [];
  const zonalAcc = new Map<
    number,
    { o: number; m: number; oJan: number; mJan: number; oJul: number; mJul: number; n: number }
  >();
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
      const acc =
        zonalAcc.get(latBand) ?? { o: 0, m: 0, oJan: 0, mJan: 0, oJul: 0, mJul: 0, n: 0 };
      acc.o += obsAnnual;
      acc.m += modelAnnual;
      acc.oJan += obsMonthly[0] ?? 0;
      acc.mJan += modelMonthly[0] ?? 0;
      acc.oJul += obsMonthly[6] ?? 0;
      acc.mJul += modelMonthly[6] ?? 0;
      acc.n++;
      zonalAcc.set(latBand, acc);
    }
  }
  const r1 = (x: number) => Math.round(x * 10) / 10;
  for (const [lat, acc] of [...zonalAcc.entries()].sort((a, b) => b[0] - a[0])) {
    zonal.push({
      lat,
      obsAnnual: r1(acc.o / acc.n),
      modelAnnual: r1(acc.m / acc.n),
      obsJan: r1(acc.oJan / acc.n),
      modelJan: r1(acc.mJan / acc.n),
      obsJul: r1(acc.oJul / acc.n),
      modelJul: r1(acc.mJul / acc.n),
    });
  }
  return {
    annualRmseC: Math.round(Math.sqrt(annualSse / Math.max(1, annualN)) * 100) / 100,
    janRmseC: Math.round(Math.sqrt((rmseByMonth['month0'] ?? 0) / Math.max(1, annualN)) * 100) / 100,
    julRmseC: Math.round(Math.sqrt((rmseByMonth['month6'] ?? 0) / Math.max(1, annualN)) * 100) / 100,
    zonalAnnual: zonal,
  };
}

// ---- 降水の非面積重み診断(セル単純平均。正本は scoring.ts の面積重み版) ----
function scorePrecipitationNonWeighted(result: PipelineResult, clim: ClimateFixture) {
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

// ---- Log 由来の構造観点(WL#36 視覚まとめ。報告のみ、合否ゲートではない)----
// 「砂漠(BW)の陸側の縁はステップ(BS)のリングで囲まれる。西岸砂漠だけは
// 海に接しリング無し」「A 群は Af→Am→Aw の遷移帯を挟む」をモデルと観測の
// 双方で数え、構造の再現度を比べる。
function structureMetrics(
  W: number,
  H: number,
  isLand: (i: number) => boolean,
  classAt: (i: number) => number,
) {
  let ringEdges = 0; // BW → BS(リング健全)
  let breakEdges = 0; // BW → B 以外の陸(リング欠落)
  let coastEdges = 0; // BW → 水(海接砂漠として免除)
  let afDirect = 0; // Af → Aw 直接接触
  let afBuffered = 0; // Af → Am(遷移帯あり)
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      if (!isLand(i)) continue;
      const c = classAt(i);
      const isBW = c === 4 || c === 5;
      const isAf = c === 1;
      if (!isBW && !isAf) continue;
      const nbs = [
        row > 0 ? (row - 1) * W + col : -1,
        row < H - 1 ? (row + 1) * W + col : -1,
        row * W + ((col + 1) % W),
        row * W + ((col + W - 1) % W),
      ];
      for (const nb of nbs) {
        if (nb < 0) continue;
        if (!isLand(nb)) {
          if (isBW) coastEdges++;
          continue;
        }
        const n = classAt(nb);
        if (isBW) {
          if (n === 6 || n === 7) ringEdges++;
          else if (!(n === 4 || n === 5)) breakEdges++;
        }
        if (isAf) {
          if (n === 3) afDirect++;
          else if (n === 2) afBuffered++;
        }
      }
    }
  }
  const pct = (a: number, b: number) => (a + b > 0 ? Math.round((a / (a + b)) * 100) : 0);
  return {
    bsRingRatePct: pct(ringEdges, breakEdges),
    bwCoastSharePct: pct(coastEdges, ringEdges + breakEdges),
    afDirectAwPct: pct(afDirect, afBuffered),
  };
}

function scoreLogStructure(result: PipelineResult, obs: KoppenFixture) {
  const grid = result.context.grid;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const land = result.context.terrain.landMask;
  const model = structureMetrics(
    W,
    H,
    (i) => !!land[i],
    (i) => result.koppen.classId[i] ?? 0,
  );
  const observed = structureMetrics(
    W,
    H,
    (i) => (obs.classRaster[i] ?? 0) !== 0,
    (i) => obs.classRaster[i] ?? 0,
  );
  // Pasta 由来の量的観点(モデル側のみ計算可能な月別実量): Am の最多雨月と
  // Cwa の最多/最少雨月比(Pasta VIb: Cwa は 10 倍比が目安)
  let amWetSum = 0;
  let amN = 0;
  let cwaRatioSum = 0;
  let cwaN = 0;
  for (let i = 0; i < grid.cellCount; i++) {
    if (!land[i]) continue;
    const id = result.koppen.classId[i] ?? 0;
    if (id !== 2 && id !== 11) continue;
    let wet = 0;
    let dry = 1e9;
    for (let m = 0; m < 12; m++) {
      const p = result.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;
      if (p > wet) wet = p;
      if (p < dry) dry = p;
    }
    if (id === 2) {
      amWetSum += wet;
      amN++;
    } else {
      cwaRatioSum += wet / Math.max(1, dry);
      cwaN++;
    }
  }
  return {
    model,
    observed,
    amWettestMonthMeanMm: amN > 0 ? Math.round(amWetSum / amN) : 0,
    cwaWetDryRatioMean: cwaN > 0 ? Math.round((cwaRatioSum / cwaN) * 10) / 10 : 0,
  };
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
  koppen: ReturnType<typeof formatKoppen>;
  temperature: {
    annualRmseC: number;
    janRmseC: number;
    julRmseC: number;
    nonAreaWeighted: ReturnType<typeof scoreTemperatureNonWeighted>;
  };
  precipitation: {
    modelLandMeanMmPerYear: number;
    obsLandMeanMmPerYear: number;
    annualRmseMm: number;
    logCorrelation: number;
    nonAreaWeighted: ReturnType<typeof scorePrecipitationNonWeighted>;
  };
  itcz: { lineRmseRainWeightedDeg: number };
  regionGates: RegionGateResult[];
  logStructure: ReturnType<typeof scoreLogStructure>;
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
    `気温 RMSE(面積重み): 年平均 ${report.temperature.annualRmseC}°C / 1月 ${report.temperature.janRmseC}°C / 7月 ${report.temperature.julRmseC}°C` +
      `(非面積重み診断: 年 ${report.temperature.nonAreaWeighted.annualRmseC}°C)`,
  );
  console.log(
    `降水(面積重み): 陸平均 モデル ${report.precipitation.modelLandMeanMmPerYear}mm vs 観測 ${report.precipitation.obsLandMeanMmPerYear}mm / RMSE ${report.precipitation.annualRmseMm}mm / log相関 ${report.precipitation.logCorrelation}` +
      `(非面積重み診断: RMSE ${report.precipitation.nonAreaWeighted.annualRmseMm}mm / log相関 ${report.precipitation.nonAreaWeighted.logCorrelation})`,
  );
  console.log(`ITCZ 線 RMSE(雨量重み): ${report.itcz.lineRmseRainWeightedDeg}°`);
  const passed = report.regionGates.filter((g) => g.pass).length;
  console.log(`地域ゲート: ${passed} / ${report.regionGates.length} PASS`);
  for (const g of report.regionGates) {
    console.log(`  ${g.pass ? '✅' : '❌'} ${g.id}: ${g.detail}`);
  }
  const ls = report.logStructure;
  console.log('Log 構造観点(モデル vs 観測、報告のみ):');
  console.log(
    `  BS リング率(BW の陸縁が BS): ${ls.model.bsRingRatePct}% vs ${ls.observed.bsRingRatePct}% ・ BW 縁の海接率: ${ls.model.bwCoastSharePct}% vs ${ls.observed.bwCoastSharePct}%`,
  );
  console.log(
    `  Af→Aw 直接接触率(遷移帯 Am の欠落): ${ls.model.afDirectAwPct}% vs ${ls.observed.afDirectAwPct}%`,
  );
  console.log(
    `  Am 最多雨月平均 ${ls.amWettestMonthMeanMm}mm(Pasta 目安 500mm 級)・Cwa 最多/最少雨月比 ${ls.cwaWetDryRatioMean}(目安 ~10)`,
  );
  console.log('\nモデル上位クラス:', report.koppen.topClassesModel.map((e) => `${e.cls} ${e.pct}%`).join(', '));
  console.log('観測上位クラス:', report.koppen.topClassesObs.map((e) => `${e.cls} ${e.pct}%`).join(', '));
  console.log(`\nPNG とレポート: ${OUT_DIR}`);
}

main();
