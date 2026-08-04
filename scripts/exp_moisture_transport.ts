// 実験: 保存型の水蒸気輸送(src/sim/moisture_transport.ts)を単体で走らせ、
// 現行の「風上追跡による供給場」と置き換えたときの成績を測る。
//
// 対応 spec: docs/FB_2026-07-31.md P2-1(中期案「保存型の水蒸気輸送」)。
//
// なぜここまで来たか(2026-08-04 の診断):
//   砂漠の夏の過大降水は**変換ではなく供給**にあった。観測 100mm/年未満の陸で
//   夏の海洋供給が冬の 2.7 倍。供給は経路上の e_sat の線積分なので
//   Clausius-Clapeyron でそのまま温度に効き、途中で雨として失われる収支が無い。
//   降水差分図の「山の風上で出し切って内陸に届かない」も同じ根。
//
// 何を測るか:
//   可降水量 W を状態に持ち 0 = S − λG·W − (1/A)Σ Φ を解いて、
//   凝結量 λG·W をそのまま降水にする。**変換係数(mm/供給単位)が要らなくなる** —
//   降水は水収支から mm/月 で出る。凝結で除いた水は必ず同じセルの降水に計上され、
//   山で出し切った水は内陸へ届かず、届いた水は必ずどこかで降る。
//
// パイプラインを書き換える前に、ここで**効くのかどうか**だけ先に確かめる。
// 降水だけ差し替えてケッペンを組み直せば既存の採点がそのまま使える。
//
// 源 S:
//   海 … 海面の飽和水蒸気圧比 × 風速 × 係数(蒸発のバルク式の簡略形)
//   陸 … 土壌バケツの実蒸発散(既に mm/月 で計算済み。ここは代理を使わない)
// 凝結率 λG:
//   λ0(1/月)× 既存の持上げ/抑制倍率の積(R1 診断から取る)
//
// 実行: npx tsx scripts/exp_moisture_transport.ts [パラメータJSON]

import * as fs from 'node:fs';
import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { computeKoppen } from '../src/sim/step07_koppen';
import {
  solveMoistureTransport,
  globalBalanceResidual,
} from '../src/sim/moisture_transport';
import { saturationVaporPressureHpa } from '../src/sim/step06_precipitation';
import { getClimObs } from './scoring';
import { evaluateResult } from './optimize_lib';
import { openAccel } from './accel_cli';
import type { PipelineResult, PrecipitationResult } from '../src/sim/types';

const PARAM_PATH = process.argv[2];
const MONTHS = 12;

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
      for (let m = 0; m < MONTHS; m++) {
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
  /** 海面蒸発の係数(mm/月、飽和比 1・風速 5m/s のとき) */
  oceanEvap: number;
  /** 凝結率の基準(1/月) */
  lambda0: number;
  /** 拡散(m²/s) */
  diffusivity: number;
}

const CASES: Case[] = [
  { label: 'λ0=1.0 E=120 K=0', oceanEvap: 120, lambda0: 1.0, diffusivity: 0 },
  { label: 'λ0=2.0 E=120 K=0', oceanEvap: 120, lambda0: 2.0, diffusivity: 0 },
  { label: 'λ0=4.0 E=120 K=0', oceanEvap: 120, lambda0: 4.0, diffusivity: 0 },
  { label: 'λ0=2.0 E=80  K=0', oceanEvap: 80, lambda0: 2.0, diffusivity: 0 },
  { label: 'λ0=2.0 E=120 K=2e5', oceanEvap: 120, lambda0: 2.0, diffusivity: 2e5 },
];

async function main(): Promise<void> {
  if (PARAM_PATH) {
    const patch = JSON.parse(fs.readFileSync(PARAM_PATH, 'utf8')) as Record<string, number>;
    const target = MODEL_CONSTANTS as unknown as Record<string, number>;
    for (const [k, v] of Object.entries(patch)) if (k in target) target[k] = v;
    console.log(`出発点のパラメータ: ${PARAM_PATH}`);
  }
  // 陸面の ET を得るため 2 パス構成を起こす(物理は変えない値)
  (MODEL_CONSTANTS as unknown as Record<string, number>).landDryCapacityFrac = 0.999;

  const accel = await openAccel();
  const { result, precipDiag: d } = await (async () => {
    try {
      return await runPipelineWithPrecipDiag(EARTH_PARAMS, accel.opts);
    } finally {
      accel.close();
    }
  })();

  const grid = result.context.grid;
  const N = grid.cellCount;
  const land = result.context.terrain.landMask;
  const radiusKm = result.context.params.body.radiusKm;
  const q0 = saturationVaporPressureHpa(20);
  const landEt = result.precipitation.land?.monthlyEtMm;
  if (!landEt) {
    console.log('陸面 ET が取れていない(土壌水分が無効)');
    return;
  }

  // 既存の降水を基準として採点しておく
  const base = evaluateResult(result);
  const dryCells = drySelection(result, 100);
  const dryStat = (p: PrecipitationResult): { annual: number; jun: number } => {
    let a = 0;
    let j = 0;
    for (const gi of dryCells) {
      a += p.annualPrecipMm[gi] ?? 0;
      j += p.monthlyPrecipMm[5]?.[gi] ?? 0;
    }
    return { annual: a / Math.max(1, dryCells.length), jun: j / Math.max(1, dryCells.length) };
  };
  const b = dryStat(result.precipitation);
  console.log(
    '\n案                     v3    大分類   詳細  ゲート 年RMSE 最少月 陸平均 砂漠年 砂漠6月 収支残差 反復',
  );
  console.log(
    `${'現行(風上追跡)'.padEnd(20)} ${base.fitness.toFixed(2).padStart(6)} ` +
      `${base.majorPct.toFixed(2).padStart(6)} ${base.detailPct.toFixed(2).padStart(6)} ` +
      `${String(base.gates).padStart(4)} ${String(Math.round(base.precipRmse)).padStart(6)} ` +
      `${base.precipDriestRmse.toFixed(1).padStart(6)} ${String(Math.round(base.landMeanMm)).padStart(6)} ` +
      `${b.annual.toFixed(0).padStart(6)} ${b.jun.toFixed(1).padStart(7)}`,
  );

  for (const c of CASES) {
    const monthly: Float32Array[] = [];
    let worstResidual = 0;
    let maxIter = 0;
    let allConverged = true;
    for (let m = 0; m < MONTHS; m++) {
      const t = result.temperature.monthlyTemperatureC[m]!;
      const u = result.airflow.monthlyWindU[m]!;
      const v = result.airflow.monthlyWindV[m]!;
      const et = landEt[m]!;
      const source = new Float32Array(N);
      const rate = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        if (land[i]) {
          // 陸: 実蒸発散(mm/月)。代理を使わない
          source[i] = et[i] ?? 0;
        } else {
          // 海: 飽和水蒸気圧比 × 風速(バルク式の簡略形)
          const qs = saturationVaporPressureHpa(t[i] ?? 0) / q0;
          const spd = Math.hypot(u[i] ?? 0, v[i] ?? 0);
          source[i] = c.oceanEvap * qs * Math.min(2, (0.4 + spd / 5) / 1.4);
        }
        // 凝結率 = λ0 × 既存の持上げ/抑制倍率の積
        const g =
          (d.liftItcz[m]?.[i] ?? 1) *
          (d.liftFrontal[m]?.[i] ?? 1) *
          (d.liftOrographic[m]?.[i] ?? 1) *
          (d.liftConvergence[m]?.[i] ?? 1) *
          (d.subsidenceResidual[m]?.[i] ?? 1) *
          (d.upwindBlock[m]?.[i] ?? 1) *
          (d.liftOther[m]?.[i] ?? 1);
        rate[i] = c.lambda0 * Math.max(0.02, g);
      }
      const r = solveMoistureTransport(grid, radiusKm, u, v, source, rate, {
        diffusivityM2PerS: c.diffusivity,
        maxIterations: 600,
      });
      monthly.push(r.condensationMm);
      maxIter = Math.max(maxIter, r.iterations);
      if (!r.converged) allConverged = false;
      worstResidual = Math.max(worstResidual, globalBalanceResidual(grid, source, r.condensationMm));
    }
    const annual = new Float32Array(N);
    for (const mm of monthly) for (let i = 0; i < N; i++) annual[i] = (annual[i] ?? 0) + (mm[i] ?? 0);
    const precipitation: PrecipitationResult = {
      monthlyPrecipMm: monthly,
      annualPrecipMm: annual,
      coupling: result.precipitation.coupling,
    };
    const swapped: PipelineResult = {
      ...result,
      precipitation,
      koppen: computeKoppen(result.context, result.temperature, precipitation),
    };
    const s = evaluateResult(swapped);
    const t = dryStat(precipitation);
    console.log(
      `${c.label.padEnd(20)} ${s.fitness.toFixed(2).padStart(6)} ` +
        `${s.majorPct.toFixed(2).padStart(6)} ${s.detailPct.toFixed(2).padStart(6)} ` +
        `${String(s.gates).padStart(4)} ${String(Math.round(s.precipRmse)).padStart(6)} ` +
        `${s.precipDriestRmse.toFixed(1).padStart(6)} ${String(Math.round(s.landMeanMm)).padStart(6)} ` +
        `${t.annual.toFixed(0).padStart(6)} ${t.jun.toFixed(1).padStart(7)} ` +
        `${worstResidual.toExponential(1).padStart(8)} ${String(maxIter).padStart(4)}` +
        `${allConverged ? '' : ' 未収束'}`,
    );
  }
  console.log('\n参考: 砂漠(観測<100mm/年)の観測は 年 44mm / 6月 3.0mm、陸平均の観測は約 800mm');
  console.log('注: 既存の較正定数は風上追跡向けに合わせてあるので、ここの絶対値は較正前の値である');
}

void main();
