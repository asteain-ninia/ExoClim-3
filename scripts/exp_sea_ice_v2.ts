// 実験: 0 層海氷模型の第 2 版(アルベドの連続化 + 融解中の凍結点固定 + 陸雪の分離)。
//
// 対応 spec: docs/事前登録_海氷アルベド_2026-08-07.md
// 前回:      docs/実験記録_高緯度の冬_2026-08-04.md(第 1 版は不成立)
//
// 第 1 版との違いは 4 点(事前登録 §「今回直す 3 点」+ GPU 移植):
//   (1) 陸の季節雪と海氷を分ける ← 第 1 版は陸の雪アルベドが消える不具合があった
//   (2) アルベド・断熱を氷量に連続で結ぶ(二値だと融けた瞬間に 0.39 → 0.07)
//   (3) 融解中は表面を凍結点に留める(超過熱を潜熱へ)
//   (4) WGSL へ移植。第 1 版は CPU にしか無く、GPU があると黙って無効化されていた
//
// **事前に登録した判定**(結果を見る前に固定済み):
//   主判定 … 北極海 70〜90°N の 9〜10 月が下がり、かつ
//            南大洋 60〜70°S の 1〜2 月が上がる。**両方**でなければ不成立
//   副判定 … 北極海の 7 月が +5°C 以下(第 1 版は +16.8°C)
//            帯状平均気温の最大乖離が 20°C 以下(現在 26.4°C)
//            数値的健全性(残差 < 1e-3、ドリフト < 0.05)
//   棄却   … seaIceCoverScaleMm を 150/300/600 の 3 段階試して届かなければ棄却
//
// 実行: npx tsx scripts/exp_sea_ice_v2.ts [coverScale,...]

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { EBM_SOLVER_STATS } from '../src/sim/step05_temperature';
import { latDegOfRow } from '../src/domain/grid';
import { evaluateResult } from './optimize_lib';
import { getClimObs } from './scoring';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

const SCALES = (process.argv[2] ?? '150,300,600').split(',').map(Number);
const MONTHS = 12;

/** 緯度帯の海の月別平均気温(面積重み) */
function oceanBand(result: PipelineResult, lo: number, hi: number): number[] {
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const out: number[] = [];
  for (let m = 0; m < MONTHS; m++) {
    const tm = result.temperature.monthlyTemperatureC[m]!;
    let s = 0;
    let w = 0;
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = latDegOfRow(grid, row);
      if (lat < lo || lat >= hi) continue;
      const cw = Math.cos((lat * Math.PI) / 180);
      for (let col = 0; col < grid.widthCells; col++) {
        const i = row * grid.widthCells + col;
        if (land[i]) continue;
        s += cw * (tm[i] ?? 0);
        w += cw;
      }
    }
    out.push(w > 0 ? s / w : Number.NaN);
  }
  return out;
}

/**
 * 帯状平均気温(陸)の観測との最大乖離。最終受入ゲートの未達項目そのもの。
 * report.json と同じく 10° 帯・月別で測り、1 月と 7 月の最大を返す
 */
function zonalMaxGap(result: PipelineResult): { gap: number; where: string } {
  const clim = getClimObs();
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const f = Math.round(2 / grid.resolutionDeg);
  let worst = 0;
  let where = '—';
  for (const m of [0, 6]) {
    for (let lo = -90; lo < 90; lo += 10) {
      let sO = 0;
      let nO = 0;
      let sM = 0;
      let nM = 0;
      for (let cr = 0; cr < clim.heightCells; cr++) {
        const lat = 90 - (cr + 0.5) * 2;
        if (lat < lo || lat >= lo + 10) continue;
        for (let cc = 0; cc < clim.widthCells; cc++) {
          const ci = cr * clim.widthCells + cc;
          const t = clim.monthlyTemperatureDeciC[m]?.[ci] ?? -9999;
          if (t === -9999) continue;
          let sum = 0;
          let n = 0;
          for (let dr = 0; dr < f; dr++) {
            for (let dc = 0; dc < f; dc++) {
              const gr = cr * f + dr;
              const gc = cc * f + dc;
              if (gr >= grid.heightCells || gc >= grid.widthCells) continue;
              const gi = gr * grid.widthCells + gc;
              if (!land[gi]) continue;
              sum += result.temperature.monthlyTemperatureC[m]?.[gi] ?? 0;
              n++;
            }
          }
          if (n === 0) continue;
          sO += t / 10;
          nO++;
          sM += sum / n;
          nM++;
        }
      }
      if (nO === 0 || nM === 0) continue;
      const d = Math.abs(sM / nM - sO / nO);
      if (d > worst) {
        worst = d;
        where = `${lo}〜${lo + 10}° の ${m === 0 ? '1' : '7'} 月`;
      }
    }
  }
  return { gap: worst, where };
}

interface Case {
  label: string;
  arctic: number[];
  southern: number[];
  fitness: number;
  major: number;
  detail: number;
  gates: number;
  zonal: number;
  zonalWhere: string;
  residual: number;
  drift: number;
}

async function runCase(label: string, accelOpts: unknown): Promise<Case> {
  EBM_SOLVER_STATS.maxResidualC = 0;
  EBM_SOLVER_STATS.meanYearDriftC = 0;
  EBM_SOLVER_STATS.fullCapacityYears = 0;
  EBM_SOLVER_STATS.maxSweeps = 0;
  // **1 件ごとに逐次出す。** 最後にまとめて出す造りにしたせいで、
  // 8 時間走らせて何も分からないという事故を起こした(2026-08-07)
  console.log(`  … ${label} 開始`);
  const t0 = Date.now();
  const result = await runPipeline(EARTH_PARAMS, accelOpts as never);
  console.log(
    `  … ${label} 完了 ${((Date.now() - t0) / 60000).toFixed(1)} 分  ` +
      `全熱容量 ${EBM_SOLVER_STATS.fullCapacityYears} 年  ` +
      `最大反復 ${EBM_SOLVER_STATS.maxSweeps}  ` +
      `残差 ${EBM_SOLVER_STATS.maxResidualC.toExponential(2)}  ` +
      `ドリフト ${EBM_SOLVER_STATS.meanYearDriftC.toFixed(4)}`,
  );
  const s = evaluateResult(result);
  const z = zonalMaxGap(result);
  return {
    label,
    arctic: oceanBand(result, 70, 90),
    southern: oceanBand(result, -70, -60),
    fitness: s.fitness,
    major: s.majorPct,
    detail: s.detailPct,
    gates: s.gates,
    zonal: z.gap,
    zonalWhere: z.where,
    residual: EBM_SOLVER_STATS.maxResidualC,
    drift: EBM_SOLVER_STATS.meanYearDriftC,
  };
}

const fmt = (a: number[]): string => a.map((v) => v.toFixed(1).padStart(6)).join('');
const mean = (a: number[], idx: number[]): number =>
  idx.reduce((s, i) => s + (a[i] ?? 0), 0) / idx.length;

async function main(): Promise<void> {
  const K = MODEL_CONSTANTS as unknown as Record<string, number>;
  const accel = await openAccel();
  const cases: Case[] = [];
  try {
    K.seaIceModel = 0;
    cases.push(await runCase('温度ランプ(現行)', accel.opts));
    for (const sc of SCALES) {
      K.seaIceModel = 1;
      K.seaIceCoverScaleMm = sc;
      cases.push(await runCase(`0 層 v2 (飽和 ${sc}mm)`, accel.opts));
    }
  } finally {
    accel.close();
  }

  console.log('\n北極海 70〜90°N の月別海面温度');
  console.log('                        1     2     3     4     5     6     7     8     9    10    11    12');
  for (const c of cases) console.log(`  ${c.label.padEnd(20)}${fmt(c.arctic)}`);
  console.log('\n南大洋 60〜70°S');
  console.log('                        1     2     3     4     5     6     7     8     9    10    11    12');
  for (const c of cases) console.log(`  ${c.label.padEnd(20)}${fmt(c.southern)}`);

  const base = cases[0]!;
  console.log('\n===== 事前登録の判定 =====');
  console.log(
    '設定                    北極 9-10月   南大洋 1-2月   主判定   北極 7月   帯状乖離   健全性',
  );
  for (const c of cases.slice(1)) {
    const dArctic = mean(c.arctic, [8, 9]) - mean(base.arctic, [8, 9]);
    const dSouth = mean(c.southern, [0, 1]) - mean(base.southern, [0, 1]);
    const main = dArctic < 0 && dSouth > 0;
    const jul = c.arctic[6] ?? NaN;
    const sound = c.residual < 1e-3 && c.drift < 0.05;
    console.log(
      `  ${c.label.padEnd(20)} ${(dArctic >= 0 ? '+' : '') + dArctic.toFixed(2)}°C      ` +
        `${(dSouth >= 0 ? '+' : '') + dSouth.toFixed(2)}°C        ${main ? '○' : '×'}     ` +
        `${jul.toFixed(1)}°C ${jul <= 5 ? '○' : '×'}   ${c.zonal.toFixed(1)}°C ${c.zonal <= 20 ? '○' : '×'}   ${sound ? '○' : '×'}`,
    );
  }
  console.log(
    `\n基準の帯状乖離: ${base.zonal.toFixed(1)}°C(${base.zonalWhere})`,
  );
  console.log('\n全球成績');
  for (const c of cases)
    console.log(
      `  ${c.label.padEnd(20)} v3=${c.fitness.toFixed(3)}  大分類=${c.major.toFixed(2)}  ` +
        `詳細=${c.detail.toFixed(2)}  ゲート=${c.gates}  残差=${c.residual.toExponential(2)}  ドリフト=${c.drift.toFixed(4)}`,
    );

  const winner = cases
    .slice(1)
    .find(
      (c) =>
        mean(c.arctic, [8, 9]) - mean(base.arctic, [8, 9]) < 0 &&
        mean(c.southern, [0, 1]) - mean(base.southern, [0, 1]) > 0,
    );
  console.log(
    winner
      ? `\n主判定を満たす設定: ${winner.label}`
      : '\n主判定を満たす設定は無い → 事前登録の棄却条件に該当',
  );
}

void main();
