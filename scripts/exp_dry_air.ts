// 実験: 乾いた空気で降水を止める経路(C 柱相対湿度の指数抑制)の効果を実測する。
// (D 雲底下の再蒸発 subCloudEvapCoef)は 2 度の棄却を経て 2026-09-06 に削除したので、
// この実験も (C) だけを振る。
//
// 対応 spec: docs/spec/01-06_降水.md。
//
// 何を測るか:
//   (C) 柱相対湿度の指数抑制 crhSuppressionSharpness
//       降水倍率 = exp(sharpness × (CRH − 1))。CRH は「届いた水蒸気 ÷ その場の
//       空気が持てる量」の代理(供給 ÷ 局所飽和水蒸気圧比)。
//       Bretherton et al. 2004: 熱帯海上で P ∝ exp(15.6·CRH)。
//
// **事前に登録する判定**(結果を見る前に固定):
//   (C) 成立 … 観測 100mm/年未満の陸で、モデル年降水 61mm が観測 44mm へ近づき、
//       かつ**夏の過大**(6月 モデル 8.1 / 観測 3.0 mm)が縮む。
//       降水 年RMSE と最少月RMSE が悪化しない。
//   共通 … 大分類・詳細・ゲートを下げないこと。
//   棄却 … 砂漠が乾く代わりに湿潤域まで乾いて陸平均が観測(約 800mm)を
//       大きく下回る、または詳細一致が下がる。
//
// 実行: npx tsx scripts/exp_dry_air.ts [パラメータJSON]

import * as fs from 'node:fs';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { getClimObs } from './scoring';
import { evaluateResult } from './optimize_lib';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

const PARAM_PATH = process.argv[2];

/** 観測が乾燥している 2° セルに対応する 1° 陸セル */
function drySelection(result: PipelineResult, maxMm: number): number[] {
  const clim = getClimObs();
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const f = Math.round(2 / grid.resolutionDeg);
  const out: number[] = [];
  for (let cr = 0; cr < clim.heightCells; cr++) {
    for (let cc = 0; cc < clim.widthCells; cc++) {
      const ci = cr * clim.widthCells + cc;
      let sum = 0;
      let ok = true;
      for (let m = 0; m < 12; m++) {
        const p = clim.monthlyPrecipitationMm[m]?.[ci] ?? -9999;
        if (p === -9999) {
          ok = false;
          break;
        }
        sum += p;
      }
      if (!ok || sum > maxMm) continue;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const gr = cr * f + dr;
          const gc = cc * f + dc;
          if (gr >= grid.heightCells || gc >= grid.widthCells) continue;
          const gi = gr * grid.widthCells + gc;
          if (land[gi]) out.push(gi);
        }
      }
    }
  }
  return out;
}

interface Case {
  label: string;
  crh: number;
}

const CASES: Case[] = [
  { label: '従来(無効)', crh: 0 },
  { label: 'C 指数 2', crh: 2 },
  { label: 'C 指数 4', crh: 4 },
  { label: 'C 指数 8', crh: 8 },
  { label: 'C 指数 15.6(文献値)', crh: 15.6 },
];

async function main(): Promise<void> {
  if (PARAM_PATH) {
    const patch = JSON.parse(fs.readFileSync(PARAM_PATH, 'utf8')) as Record<string, number>;
    const target = MODEL_CONSTANTS as unknown as Record<string, number>;
    for (const [k, v] of Object.entries(patch)) if (k in target) target[k] = v;
    console.log(`出発点のパラメータ: ${PARAM_PATH}`);
  }
  const target = MODEL_CONSTANTS as unknown as Record<string, number>;

  console.log(
    '\n案                    v3      v2    大分類   詳細  ゲート 年RMSE 最少月 最多月 陸平均 ' +
      '砂漠年 砂漠6月  秒',
  );
  const rows: Array<Record<string, number | string>> = [];
  for (const c of CASES) {
    target.crhSuppressionSharpness = c.crh;
    const t0 = Date.now();
    const accel = await openAccel();
    let result: PipelineResult;
    try {
      result = await runPipeline(EARTH_PARAMS, accel.opts);
    } finally {
      accel.close();
    }
    const s = evaluateResult(result);
    const cells = drySelection(result, 100);
    let dryAnnual = 0;
    let dryJun = 0;
    for (const gi of cells) {
      dryAnnual += result.precipitation.annualPrecipMm[gi] ?? 0;
      dryJun += result.precipitation.monthlyPrecipMm[5]?.[gi] ?? 0;
    }
    dryAnnual /= Math.max(1, cells.length);
    dryJun /= Math.max(1, cells.length);
    const sec = (Date.now() - t0) / 1000;
    console.log(
      `${c.label.padEnd(20)} ${s.fitness.toFixed(2).padStart(6)} ${s.fitnessV2.toFixed(2).padStart(6)} ` +
        `${s.majorPct.toFixed(2).padStart(6)} ${s.detailPct.toFixed(2).padStart(6)} ` +
        `${String(s.gates).padStart(4)} ${String(Math.round(s.precipRmse)).padStart(6)} ` +
        `${s.precipDriestRmse.toFixed(1).padStart(6)} ${s.precipWettestRmse.toFixed(1).padStart(6)} ` +
        `${String(Math.round(s.landMeanMm)).padStart(6)} ` +
        `${dryAnnual.toFixed(0).padStart(6)} ${dryJun.toFixed(1).padStart(7)} ${sec.toFixed(0).padStart(5)}`,
    );
    rows.push({
      label: c.label,
      crh: c.crh,
      fitness: s.fitness,
      fitnessV2: s.fitnessV2,
      majorPct: s.majorPct,
      detailPct: s.detailPct,
      gates: s.gates,
      precipRmse: s.precipRmse,
      precipDriestRmse: s.precipDriestRmse,
      precipWettestRmse: s.precipWettestRmse,
      landMeanMm: s.landMeanMm,
      tempRmse: s.tempRmse,
      tempRangeRmse: s.tempRangeRmse,
      dryAnnualMm: dryAnnual,
      dryJunMm: dryJun,
      sec,
    });
    fs.mkdirSync('out/exp', { recursive: true });
    fs.writeFileSync('out/exp/dry_air.json', JSON.stringify(rows, null, 1));
  }
  console.log('\n参考: 砂漠(観測<100mm/年)の観測値は 年 44mm / 6月 3.0mm、陸平均の観測は約 800mm');
}

void main();
