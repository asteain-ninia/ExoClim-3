// ヘッドレス検証ハーネス。docs/要件.md §6
// 実在地球パラメータでパイプラインを実行し、Beck et al. 2023 の観測ラスター・
// 月別平年値と比較して自動採点する。出力: out/validate/ に PNG + report.json。
// 受入基準は docs/要件.md §6 に固定(結果を見て緩めない — 教訓 §8.3)。

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { runPipelineTimed } from '../src/sim/pipeline';
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
  evaluateInterimTarget,
  evaluateRegression,
} from './validate_criteria';
import { regionKoppenDiag, regionPrecipDiag, regionTargetStatus } from './scoring_regions';
import { loadFoldBest } from './optimize_store';
import { HOLDOUT_FOLDS, gateFoldAssignments, keepExcludingFold, keepOnlyFold } from './holdout';

// 採点定義は scripts/scoring.ts に一元化(P0-3)。ここでは複製しない。
// 正本の集計は面積重み(cos 緯度)。旧来のセル単純平均は「非面積重み」の
// 診断値として nonAreaWeighted 配下にのみ残す。
//
// 変更レビュー FB P0-1: 標準採用モデルの出力先は out/validate/ に限る。
// 単独実験は `--experiment <名前>` で out/experiments/<名前>/ へ出し、
// 標準成果物を汚さない。レポートにはコミット識別子・実験名・定数ダイジェスト
// を含め、採用/棄却と実行条件を後から判別できるようにする。
const expIdx = process.argv.indexOf('--experiment');
const EXPERIMENT_ARG = expIdx >= 0 ? (process.argv[expIdx + 1] ?? '') : null;
if (EXPERIMENT_ARG !== null && !/^[a-z0-9][a-z0-9-_]*$/i.test(EXPERIMENT_ARG)) {
  throw new Error('--experiment には英数字・ハイフン・下線の名前を指定する');
}

// 変更レビュー FB 残件①: 真の保留評価経路。`--holdout-fold N` で
// state_foldN.json の最良定数(fold N を除外して較正)を適用し、fold N を
// 未見データとして評価する。このときだけ isUnseenEvaluation=true になる。
// 標準成果物を汚さないため、出力先は自動的に out/experiments/ へ切り替わる。
const hfIdx = process.argv.indexOf('--holdout-fold');
const HOLDOUT_FOLD = hfIdx >= 0 ? Number(process.argv[hfIdx + 1]) : null;
if (
  HOLDOUT_FOLD !== null &&
  (!Number.isInteger(HOLDOUT_FOLD) || HOLDOUT_FOLD < 0 || HOLDOUT_FOLD > 4)
) {
  throw new Error(`--holdout-fold は 0〜4 の整数(指定値: ${String(HOLDOUT_FOLD)})`);
}
const EXPERIMENT = EXPERIMENT_ARG ?? (HOLDOUT_FOLD !== null ? `holdout-fold${HOLDOUT_FOLD}` : null);
const OUT_DIR = EXPERIMENT
  ? path.join(process.cwd(), 'out', 'experiments', EXPERIMENT)
  : path.join(process.cwd(), 'out', 'validate');

function gitCommitId(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown'; // 取得できない環境では架空の値を入れない(FB P0-1)
  }
}

/** 未コミット変更の有無(判定不能時は true と保守的に扱う — R1 レビュー再発防止) */
function gitIsDirty(): boolean {
  try {
    return execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
  } catch {
    return true;
  }
}

function constantsDigest(): string {
  const s = JSON.stringify(MODEL_CONSTANTS);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function main(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (HOLDOUT_FOLD !== null) {
    const statePath = path.join(process.cwd(), 'out', 'optimize', `state_fold${HOLDOUT_FOLD}.json`);
    const best = loadFoldBest(statePath);
    Object.assign(MODEL_CONSTANTS, best);
    console.log(
      `未見評価モード: fold ${HOLDOUT_FOLD} を除外して較正された定数(${statePath})を適用。` +
        `fold ${HOLDOUT_FOLD} の区画成績が真の保留評価`,
    );
  }
  const t0 = Date.now();
  console.log('パイプライン実行中(実在地球 1°)…');
  const { result, stepTimingsMs } = runPipelineTimed(EARTH_PARAMS);
  console.log('所要時間:', ((Date.now() - t0) / 1000).toFixed(1), 's', stepTimingsMs);

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
  const acceptanceMetrics = {
    majorAreaGapPt: koppen.majorAreaGapPt,
    gatesPassed,
    gatesTotal: regionGates.length,
    zonalTempAbsDiffsC: temperatureNW.zonalAnnual.flatMap((z) => [
      Math.abs(z.modelAnnual - z.obsAnnual),
      Math.abs(z.modelJan - z.obsJan),
      Math.abs(z.modelJul - z.obsJul),
    ]),
  };
  const interim = evaluateInterimTarget(acceptanceMetrics);
  const acceptance = evaluateAcceptance(acceptanceMetrics);

  const report = {
    generatedAt: new Date().toISOString(),
    // 来歴(FB P0-1): どのコード・どの定数で出した成果物かを機械判別可能に
    gitCommit: gitCommitId(),
    gitDirty: gitIsDirty(),
    runLabel: EXPERIMENT ?? 'baseline',
    constantsDigest: constantsDigest(),
    stepTimingsMs,
    // P1-3: 適用範囲診断。'out_of_domain' のときケッペン採点は科学的に無効
    diagnostics: result.diagnostics,
    weighting:
      '正本の集計は面積重み(cos 緯度)。nonAreaWeighted はセル単純平均の非面積重み診断値。' +
      '観測欠損(-9999)セルは除外、採点は共通陸セル(モデル陸 ∩ 観測有効)のみ',
    regressionPass: regression.pass,
    interimTargetPass: interim.pass,
    acceptancePass: acceptance.pass,
    regression: { ...regression, baseline: REGRESSION_BASELINE },
    interimTarget: { ...interim, note: '要件 §6-1 の 70%(途中目標 — 最終合格ではない)' },
    acceptance: {
      ...acceptance,
      criteria: ACCEPTANCE_CRITERIA,
      note:
        '最終受入は地域ゲート全件 PASS が必要(教訓 §8 — 14/17 は未達)。' +
        '要件 §6-2(理想化大陸)・§6-3(退化条件)は別ハーネスで判定する',
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
    // 系統ハズレ追跡ベンチ(報告専用 — 実験の採否判断の共通物差し)
    systematicMisses: systematicMisses(k, temperatureNW.zonalAnnual),
    // 変更レビュー FB P1-1: これは「全球学習済みモデルの区画別診断」であり
    // 未見データへの一般化性能ではない(現行定数は全球で較正済み)。
    // holdout / 一般化 / 未見の語は、対象 fold を除外して再較正したモデルの
    // 評価(trainedExcludingFold ≠ null)にのみ使う。
    spatialSliceMetrics: {
      note:
        HOLDOUT_FOLD === null
          ? '全球学習済みモデルの区画別診断(空間 5 分割 = 30° 粗ブロック、決定的ハッシュ、' +
            '凍結 2026-07-31 — scripts/holdout.ts)。未見評価ではない。全球値は本レポートの正本欄'
          : `fold ${HOLDOUT_FOLD} を除外して較正した定数での評価。` +
            `fold ${HOLDOUT_FOLD} の行だけが真の保留(未見)成績で、他は訓練域`,
      trainedExcludingFold: HOLDOUT_FOLD as number | null,
      isUnseenEvaluation: HOLDOUT_FOLD !== null,
      gateNote:
        '地域ゲートは枠中心の fold に完全所属(訓練時は保留所属ゲートを丸ごと除外し、' +
        '訓練所属ゲートはその地域全体のセルで判定する)。保留較正のゲート項は ' +
        '17 × 合格数/訓練対象数 に正規化、ITCZ 項は目的関数から除外(optimize_lib.ts 冒頭)',
      gateFolds: gateFoldAssignments(),
      folds: Array.from({ length: HOLDOUT_FOLDS }, (_, fold) => {
        const gf = gateFoldAssignments();
        const sliceGates = regionGates.filter((g) => gf[g.id] === fold);
        const kOther = koppenScore(result, koppenObs, keepExcludingFold(fold));
        const kSlice = koppenScore(result, koppenObs, keepOnlyFold(fold));
        const fSlice = fieldScore(result, climObs, keepOnlyFold(fold));
        const pct = (x: number, total: number) =>
          Math.round((x / Math.max(1e-9, total)) * 1000) / 10;
        return {
          fold,
          trainingGateCount: regionGates.length - sliceGates.length,
          trainingGatesPassed: regionGates.filter((g) => gf[g.id] !== fold && g.pass).length,
          sliceGateCount: sliceGates.length,
          sliceGatesPassed: sliceGates.filter((g) => g.pass).length,
          sliceLandSharePct: pct(kSlice.wTotal, k.wTotal),
          sliceMajorSharesObsPct: kSlice.majorAreaObsW.map((w) => pct(w, kSlice.wTotal)),
          otherFoldsMajorPct: round2(kOther.majorPct),
          otherFoldsDetailPct: round2(kOther.detailPct),
          sliceMajorPct: round2(kSlice.majorPct),
          sliceDetailPct: round2(kSlice.detailPct),
          sliceTempRmseC: round2(fSlice.tempRmseC),
          slicePrecipRmseMm: Math.round(fSlice.precipRmseMm),
        };
      }),
    },
    // R0(地域降水 FB): 報告専用の地域診断。目的関数には入れない
    regionDiagnostics: (() => {
      const precip = regionPrecipDiag(result, climObs);
      const koppenDiag = regionKoppenDiag(result, koppenObs);
      return {
        note:
          '面積重み(cos 緯度)・2° 観測有効セルのみ・モデルは陸ブロック平均・' +
          '最乾/最多雨月は地域平均月別系列の最小/最大。詳細は scoring_regions.ts 冒頭',
        precip,
        koppen: koppenDiag,
        // 「基準」= 2026-07-31 凍結実測値、「第一目標」= 地域降水 FB §12。
        // 報告専用 — 凍結目的関数(17 ゲート)には混入させない
        targetStatus: regionTargetStatus(precip, koppenDiag),
      };
    })(),
    logStructure: scoreLogStructure(result, koppenObs),
  };

  renderAll(result, koppenObs);

  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));

  if (result.diagnostics.status === 'out_of_domain') {
    console.log('⚠ 適用範囲外 — このモデルでは判定不能。以下の採点は科学的に無効:');
    for (const x of result.diagnostics.issues) console.log(`  [${x.severity}] ${x.message}`);
  }
  printSummary(report);

  if (HOLDOUT_FOLD !== null) {
    const un = report.spatialSliceMetrics.folds[HOLDOUT_FOLD];
    if (un) {
      console.log(
        `\n★ 真の保留評価(fold ${HOLDOUT_FOLD}、未見): 大分類 ${un.sliceMajorPct}% / 詳細 ${un.sliceDetailPct}%` +
          ` / 気温RMSE ${un.sliceTempRmseC}°C / 降水RMSE ${un.slicePrecipRmseMm}mm` +
          ` / 保留ゲート ${un.sliceGatesPassed}/${un.sliceGateCount}(訓練 ${un.trainingGatesPassed}/${un.trainingGateCount})`,
      );
    }
  }
  console.log(
    HOLDOUT_FOLD === null
      ? '区画別診断(全球学習済みモデルのスライス — 未見評価ではない):'
      : `区画別診断(fold ${HOLDOUT_FOLD} 除外較正の定数 — fold ${HOLDOUT_FOLD} 行のみ未見):`,
  );
  for (const h of report.spatialSliceMetrics.folds) {
    console.log(
      `  fold ${h.fold}: 陸 ${h.sliceLandSharePct}% 他区画大分類 ${h.otherFoldsMajorPct}% / 当区画 ${h.sliceMajorPct}%` +
        ` 当区画気温RMSE ${h.sliceTempRmseC}°C 当区画降水RMSE ${h.slicePrecipRmseMm}mm`,
    );
  }
  console.log('地域降水診断(R0、報告のみ — モデル/観測):');
  for (const p of report.regionDiagnostics.precip) {
    const kd = report.regionDiagnostics.koppen.find((x) => x.id === p.id);
    console.log(
      `  ${p.label}: 年 ${p.modelAnnualMm}/${p.obsAnnualMm}mm (比 ${p.ratio})` +
        ` 最乾月 ${p.modelDriestMm}/${p.obsDriestMm}mm 最多雨月 ${p.modelWettestMm}/${p.obsWettestMm}mm` +
        (kd ? ` Af+Am ${kd.afAmModelPct}% vs ${kd.afAmObsPct}%` : ''),
    );
  }
  console.log('系統ハズレ追跡(現在 / 基準 → 目標):');
  for (const b of report.systematicMisses.benches) {
    console.log(`  ${b.label}: ${b.current} / ${b.baseline} → ${b.target}`);
  }
  console.log('地域降水の第一目標(基準 = 2026-07-31 凍結、目標 = 地域降水 FB §12):');
  for (const t of report.regionDiagnostics.targetStatus) {
    const mark = t.meetsFirstGoal ? '✅' : t.regressedFromBaseline ? '❌ 基準から退行' : '⏳';
    console.log(
      `  ${mark} ${t.label}: 現在 ${t.current} / 基準 ${t.baseline} / 第一目標 ${t.dir} ${t.firstGoal}`,
    );
  }

  console.log(
    `\n退行防止ゲート(基準凍結 ${REGRESSION_BASELINE.frozenAt}): ${regression.pass ? '✅ PASS' : '❌ FAIL — 非零終了'}`,
  );
  for (const msg of regression.failures) console.log(`  ❌ ${msg}`);
  console.log(`途中目標(要件 §6-1 の 70%): ${interim.pass ? '✅ 達成' : '⏳ 未達'}`);
  for (const msg of interim.failures) console.log(`  ⏳ ${msg}`);
  console.log(
    `最終受入ゲート(地域ゲート全件 + §6-1、凍結 ${ACCEPTANCE_CRITERIA.frozenAt}): ${acceptance.pass ? '✅ 達成' : '⏳ 未達(正直な現在地。終了コードには影響しない)'}`,
  );
  for (const msg of acceptance.failures) console.log(`  ⏳ ${msg}`);
  process.exitCode = regression.pass ? 0 : 1;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// ---- 系統ハズレの追跡ベンチ(2026-07-31 凍結 @8b07d01。報告専用) ----
// R1 完了時に特定した大面積の系統バイアス 4 群 + 関連クラスを、実験ごとに
// 同じ定義で追跡する。baseline = 凍結時実測、obsTarget = 観測値(到達目標)。
// 目的関数には入れない。クラス番号は Beck 体系(domain/koppen.ts)。
const SYSTEMATIC_MISS_BASELINES = {
  frozenAt: '2026-07-31',
  baselineCommit: '8b07d01',
} as const;

function systematicMisses(
  k: ReturnType<typeof koppenScore>,
  zonal: Array<{ lat: number; obsAnnual: number; modelAnnual: number }>,
) {
  const pctOf = (x: number) => Math.round((x / Math.max(1e-9, k.wTotal)) * 1000) / 10;
  const cls = (id: number) => ({ model: pctOf(k.areaModelW[id] ?? 0), obs: pctOf(k.areaObsW[id] ?? 0) });
  const zonalBias = (lats: number[]) => {
    const rows = zonal.filter((z) => lats.includes(z.lat));
    const s = rows.reduce((a, z) => a + (z.modelAnnual - z.obsAnnual), 0);
    return Math.round((s / Math.max(1, rows.length)) * 10) / 10;
  };
  return {
    ...SYSTEMATIC_MISS_BASELINES,
    note: '大面積の系統バイアス追跡(R1 で特定)。confusion は観測メジャー→モデルメジャーの面積 pt',
    benches: [
      { id: 'c_to_b_pt', label: '温帯 C の乾燥 B 化', current: pctOf(k.confusionW[2]?.[1] ?? 0), baseline: 4.2, target: 0 },
      { id: 'b_to_a_pt', label: '乾燥 B の湿潤 A 化', current: pctOf(k.confusionW[1]?.[0] ?? 0), baseline: 3.9, target: 0 },
      { id: 'd_to_e_pt', label: '冷帯 D の寒帯 E 化', current: pctOf(k.confusionW[3]?.[4] ?? 0), baseline: 3.5, target: 0 },
      { id: 'dfc_model_pct', label: 'Dfc 面積(亜寒帯タイガ)', current: cls(27).model, baseline: 2.6, target: cls(27).obs },
      { id: 'dfa_model_pct', label: 'Dfa 面積(過剰側)', current: cls(25).model, baseline: 7.4, target: cls(25).obs },
      { id: 'bwh_model_pct', label: 'BWh 面積(砂漠核)', current: cls(4).model, baseline: 12.3, target: cls(4).obs },
      { id: 'bsh_model_pct', label: 'BSh 面積(過剰側)', current: cls(6).model, baseline: 8.8, target: cls(6).obs },
      { id: 'af_model_pct', label: 'Af 面積(過剰側)', current: cls(1).model, baseline: 7.1, target: cls(1).obs },
      { id: 'am_model_pct', label: 'Am 面積(遷移帯欠落)', current: cls(2).model, baseline: 1.0, target: cls(2).obs },
      { id: 'arctic_warm_bias_c', label: '北極圏 70-80°N 温暖バイアス °C', current: zonalBias([70, 80]), baseline: 4.5, target: 0 },
      { id: 's3040_warm_bias_c', label: '南緯 30-40° 温暖バイアス °C', current: zonalBias([-30, -40]), baseline: 5.2, target: 0 },
    ],
  };
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
            modelMonthly[m] =
              (modelMonthly[m] ?? 0) + (result.temperature.monthlyTemperatureC[m]?.[gi] ?? 0);
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
      const acc = zonalAcc.get(latBand) ?? { o: 0, m: 0, oJan: 0, mJan: 0, oJul: 0, mJul: 0, n: 0 };
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
    janRmseC:
      Math.round(Math.sqrt((rmseByMonth['month0'] ?? 0) / Math.max(1, annualN)) * 100) / 100,
    julRmseC:
      Math.round(Math.sqrt((rmseByMonth['month6'] ?? 0) / Math.max(1, annualN)) * 100) / 100,
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
  let sx = 0,
    sy = 0,
    sxx = 0,
    syy = 0,
    sxy = 0;
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
      sx += lx;
      sy += ly;
      sxx += lx * lx;
      syy += ly * ly;
      sxy += lx * ly;
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
  renderPng('temp_annual.png', W, H, (i) =>
    tempColor(result.temperature.annualMeanC[i] ?? 0, land[i] === 1),
  );
  renderPng('temp_jan.png', W, H, (i) =>
    tempColor(result.temperature.monthlyTemperatureC[0]?.[i] ?? 0, land[i] === 1),
  );
  renderPng('temp_jul.png', W, H, (i) =>
    tempColor(result.temperature.monthlyTemperatureC[6]?.[i] ?? 0, land[i] === 1),
  );
  renderPng('precip_annual.png', W, H, (i) =>
    precipColor(result.precipitation.annualPrecipMm[i] ?? 0, land[i] === 1),
  );
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
  console.log(
    '\nモデル上位クラス:',
    report.koppen.topClassesModel.map((e) => `${e.cls} ${e.pct}%`).join(', '),
  );
  console.log(
    '観測上位クラス:',
    report.koppen.topClassesObs.map((e) => `${e.cls} ${e.pct}%`).join(', '),
  );
  console.log(`\nPNG とレポート: ${OUT_DIR}`);
}

main();
