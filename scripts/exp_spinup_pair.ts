// 実験: 加速期の熱容量倍率と反復回数は対で決まる。
//
// 事前登録: docs/事前登録_加速期の倍率と反復回数_2026-08-11.md
//
// 加速期の倍率は 2 つのものを同時に買っている:
//   - 緩和が速くなる(τ' = τ × 倍率)
//   - 反復が効かなくなる(対角項 C/dt が同じ比で小さくなる)
// 片方だけ見て 1/16 と決められた形跡があるので、対で測る。
//
// 年数は倍率に比例させて、加速期に得られる緩和量を揃える。
//
// 実行: npx tsx scripts/exp_spinup_pair.ts

import { performance } from 'node:perf_hooks';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow, lonDegOfCol } from '../src/domain/grid';
import { EBM_SPINUP, EBM_SOLVER_STATS, resetEbmSolverStats } from '../src/sim/step05_temperature';
import { evaluateResult } from './optimize_lib';
import { fieldScore, getClimObs, REGION_GATES } from './scoring';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

/** 倍率と加速期年数の組(緩和量を揃えるため年数は倍率に比例) */
const PAIRS: Array<[number, number, string]> = [
  [1 / 32, 1, '1/32'],
  [1 / 16, 2, '1/16'],
  [1 / 8, 4, '1/8'],
  [1 / 4, 8, '1/4'],
];

const TARGETS = ['india_tropical', 'us_southeast_humid', 'east_asia_humid', 'congo_tropical'];

function regionCells(r: PipelineResult, id: string): number[] {
  const gate = REGION_GATES.find((g) => g.id === id);
  const grid = r.context.grid;
  const land = r.context.terrain.landMask;
  const out: number[] = [];
  if (!gate) return out;
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    if (lat < gate.latMin || lat > gate.latMax) continue;
    for (let col = 0; col < grid.widthCells; col++) {
      const lon = lonDegOfCol(grid, col);
      const inLon =
        gate.lonMin <= gate.lonMax
          ? lon >= gate.lonMin && lon <= gate.lonMax
          : lon >= gate.lonMin || lon <= gate.lonMax;
      if (!inLon) continue;
      const i = row * grid.widthCells + col;
      if (land[i]) out.push(i);
    }
  }
  return out;
}

function meanRate(
  r: PipelineResult,
  monthly: Float32Array[] | undefined,
  cells: number[],
  months: number[],
): number {
  if (!monthly) return 0;
  const grid = r.context.grid;
  let s = 0;
  let w = 0;
  for (const i of cells) {
    const cw = Math.cos((latDegOfRow(grid, Math.floor(i / grid.widthCells)) * Math.PI) / 180);
    let sum = 0;
    for (const m of months) sum += monthly[m]?.[i] ?? 0;
    s += cw * sum * (MONTHS_PER_YEAR / months.length);
    w += cw;
  }
  return s / Math.max(1e-9, w);
}

async function main(): Promise<void> {
  const base = EBM_SPINUP.capacityFraction;
  console.log('倍率   年数   秒     v3      大分類  詳細   気温RMSE 反復  積算年 残差     ドリフト  未収束');
  for (const [frac, years, label] of PAIRS) {
    EBM_SPINUP.capacityFraction = frac;
    resetEbmSolverStats();
    const accel = await openAccel(true);
    const t0 = performance.now();
    let r: PipelineResult;
    try {
      r = await runPipeline(EARTH_PARAMS, {
        ...accel.opts,
        budget: { ebmSpinupAccelYears: years },
      });
    } finally {
      accel.close();
    }
    const sec = (performance.now() - t0) / 1000;
    const s = evaluateResult(r);
    const f = fieldScore(r, getClimObs());
    const calls = EBM_SOLVER_STATS.calls;
    const totalYears = calls.reduce((a, c) => a + c.years, 0);
    const maxIters = calls.reduce((a, c) => Math.max(a, c.iters), 0);
    console.log(
      `${label.padEnd(6)} ${String(years).padStart(4)} ${sec.toFixed(1).padStart(6)} ` +
        `${s.fitness.toFixed(3)}  ${s.majorPct.toFixed(2)}  ${s.detailPct.toFixed(2)}  ` +
        `${f.tempRmseC.toFixed(3).padStart(7)} ${String(maxIters).padStart(5)} ` +
        `${String(totalYears).padStart(5)} ${EBM_SOLVER_STATS.maxResidualC.toExponential(1)} ` +
        `${EBM_SOLVER_STATS.meanYearDriftC.toFixed(4)}  ${EBM_SOLVER_STATS.capHits}`,
    );
    const cols: string[] = [];
    for (const id of TARGETS) {
      const cells = regionCells(r, id);
      const gate = REGION_GATES.find((g) => g.id === id);
      const north = gate ? (gate.latMin + gate.latMax) / 2 >= 0 : true;
      const summer = north ? [5, 6, 7] : [11, 0, 1];
      const p = meanRate(r, r.precipitation.monthlyPrecipMm, cells, summer);
      const e = meanRate(r, r.precipitation.land?.monthlyEtMm, cells, summer);
      cols.push(`${id.split('_')[0]} ${(p - e).toFixed(0)}`);
    }
    console.log(`         夏の正味流入: ${cols.join(' / ')}`);
  }
  EBM_SPINUP.capacityFraction = base;
  console.log(
    '\n判定(事前登録): 1) v3 の差 ±0.05 以内・地域流入 ±2mm 以内 ' +
      '2) 反復の倍化なし・残差 ≤1e-3・ドリフト ≤0.05・未収束 0 ' +
      '3) 積算年数が増えていない 4) 1〜3 を満たすうち最速。現行(1/16)を下回らなければ現状維持',
  );
}

void main();
