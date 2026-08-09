// 実験: 段 1 — 降水を「凝結」から作る。**水が閉じるか**が主眼。
//
// 対応 spec: docs/計画_保存則の段階的置換_2026-08-09.md の段 1
// 前提: S2(源泉の検証)は通過済み(docs/実験記録_源泉の検証_2026-08-09.md)
//
// 何を変えるか:
//   これまで  P = 供給 q × Π(乗数) × precipScaleMmPerUnit × √気圧
//   これから  0 = S − C(W) − ∇·(WV) ,  C = λ·G·W ,  P = C
//
//   G は既存の乗数の積を**そのまま**使う(この段では 1 つも外さない)。
//   **precipScaleMmPerUnit はこの段で消える** — 収支が mm を決めるので、
//   無次元の供給を mm へ換算する定数は置き場所が無い。
//
// **判定の優先順位**(事前に固定):
//   1. 水が閉じるか   … 全球の E と P が 5% 以内で一致し、輸送が収束すること。
//                       **ここが壊れていたら成績を見る意味が無い。**
//   2. 成績           … 落ちるのは想定内(事前登録で宣言済み)。
//                       ただし**降水の季節位相**(段 0 = 77.18 日)が改善するかは見る。
//                       位相は「いつ降るか」なので、乗数の積では作りにくく、
//                       輸送が入って初めて出るはずの量である。
//
// 実行: npx tsx scripts/exp_conservative_stage1.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { CONSERVATIVE_STATS } from '../src/sim/step06_precipitation';
import { computeOceanEvaporation } from '../src/sim/evaporation';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { evaluateResult } from './optimize_lib';
import { fieldScore, getClimObs } from './scoring';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

/** 全球の面積重み平均(mm/年)。陸海を分けて返す */
function globalMeans(
  result: PipelineResult,
  monthly: Float32Array[],
): { land: number; ocean: number; global: number } {
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  let wl = 0;
  let el = 0;
  let wo = 0;
  let eo = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = 90 - (row + 0.5) * grid.resolutionDeg;
    const w = Math.cos((lat * Math.PI) / 180);
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      let sum = 0;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) sum += monthly[m]?.[i] ?? 0;
      if (land[i]) {
        wl += w;
        el += w * sum;
      } else {
        wo += w;
        eo += w * sum;
      }
    }
  }
  const lm = wl > 0 ? el / wl : 0;
  const om = wo > 0 ? eo / wo : 0;
  const f = wl / (wl + wo);
  return { land: lm, ocean: om, global: f * lm + (1 - f) * om };
}

async function run(label: string, conservative: number): Promise<void> {
  const K = MODEL_CONSTANTS as unknown as Record<string, number>;
  K.conservativeMoisture = conservative;
  const accel = await openAccel(true);
  let r: PipelineResult;
  try {
    r = await runPipeline(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }

  // ---- 判定 1: 水が閉じるか ----
  const P = globalMeans(r, r.precipitation.monthlyPrecipMm);
  const ev = computeOceanEvaporation(r.context, r.temperature, r.airflow);
  const et = r.precipitation.land?.monthlyEtMm ?? [];
  const srcMonthly: Float32Array[] = [];
  const grid = r.context.grid;
  const land = r.context.terrain.landMask;
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const f = new Float32Array(grid.cellCount);
    for (let i = 0; i < grid.cellCount; i++) {
      f[i] = land[i] ? (et[m]?.[i] ?? 0) : (ev.monthlyOceanEvapMm[m]?.[i] ?? 0);
    }
    srcMonthly.push(f);
  }
  const E = globalMeans(r, srcMonthly);
  const closure = E.global > 0 ? (P.global - E.global) / E.global : NaN;

  // ---- 判定 2: 成績 ----
  const s = evaluateResult(r);
  const f = fieldScore(r, getClimObs());

  console.log(`\n===== ${label} =====`);
  console.log(
    `水収支  E 全球 ${E.global.toFixed(0)} (海 ${E.ocean.toFixed(0)} / 陸 ${E.land.toFixed(0)}) mm/年\n` +
      `        P 全球 ${P.global.toFixed(0)} (海 ${P.ocean.toFixed(0)} / 陸 ${P.land.toFixed(0)}) mm/年\n` +
      `        閉包 (P−E)/E = ${(closure * 100).toFixed(1)}%  ${Math.abs(closure) <= 0.05 ? '○ 閉じている' : '× 閉じていない'}`,
  );
  if (conservative > 0) {
    console.log(
      `輸送    収束しなかった月 ${CONSERVATIVE_STATS.nonConverged} 件 / ` +
        `最悪の残差 ${CONSERVATIVE_STATS.worstResidual.toExponential(2)} / ` +
        `反復合計 ${CONSERVATIVE_STATS.iterations} / ` +
        `virga 未収束 ${CONSERVATIVE_STATS.virgaNonConverged} 件` +
        `  ${CONSERVATIVE_STATS.nonConverged === 0 ? '○' : '× 収束していない解は採点しない'}`,
    );
  }
  console.log(
    `成績    v3=${s.fitness.toFixed(3)}  大分類=${s.majorPct.toFixed(2)}  詳細=${s.detailPct.toFixed(2)}  ` +
      `ゲート=${s.gates}`,
  );
  console.log(
    `        降水 年RMSE ${Math.round(f.precipRmseMm)}  最少月 ${f.precipDriestRmseMm.toFixed(2)}  ` +
      `**季節位相 ${f.precipPhaseRmseDays.toFixed(2)} 日**（段 0 = 77.18）`,
  );
  console.log(
    `        陸平均降水 ${Math.round(f.landMeanModelMm)}（観測 ${Math.round(f.landMeanObsMm)}）`,
  );
}

async function main(): Promise<void> {
  await run('段 0（現行・非保存）', 0);
  await run('段 1（保存型・乗数は凝結率へ）', 1);
  console.log(
    '\n読み方: **判定 1（水が閉じるか）が先。** ここが壊れていたら成績を見る意味が無い。\n' +
      '        成績が落ちるのは想定内。降水の季節位相が改善するかを特に見る。',
  );
}

void main();
