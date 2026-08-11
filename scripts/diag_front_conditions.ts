// 診断: 前線の持上げは**どの条件で落ちているのか**。
//
// 前段(scripts/diag_front_firing.ts)で、東アジアの夏は前線の持上げが
// 16% のセルでしか発火していないと分かった(米南東は 80%)。
// 実物の梅雨・バイウ前線に相当する収束をモデルが作れていない。
//
// 発火条件は 4 つの積である(step06_precipitation.ts):
//   (a) 極向きの風がある            vPoleward > 0
//   (b) 極向きに湿りが減っている    gradPoleward > 0
//   (c) リッジの 6° 手前より極側    |lat| > |ridge| - 6
//   (d) 極前線より赤道側            |lat| < |pf|
//
// **どれで落ちているかで打つ手が違う。** (a) なら風、(b) なら水の分布、
// (c)(d) なら窓の取り方の問題である。
//
// 実行: npx tsx scripts/diag_front_conditions.ts

import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { latDegOfRow, lonDegOfCol } from '../src/domain/grid';
import { REGION_GATES } from './scoring';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

const TARGETS = ['east_asia_humid', 'us_southeast_humid', 'india_tropical'];

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

async function main(): Promise<void> {
  const accel = await openAccel(true);
  let run: { result: PipelineResult; precipDiag: unknown };
  try {
    run = await runPipelineWithPrecipDiag(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }
  const r = run.result;
  const d = run.precipDiag as { supplyOcean: Float32Array[]; supplyLand: Float32Array[] };
  const grid = r.context.grid;
  const W = grid.widthCells;
  const H = grid.heightCells;

  console.log('夏の 3 か月・陸セルの面積重み。各条件を満たすセルの割合\n');
  console.log('地域       (a)極向き風 (b)湿り勾配 (c)リッジ側 (d)極前線側  4つ全部  平均v(極向き) 平均勾配');
  for (const id of TARGETS) {
    const cells = regionCells(r, id);
    const gate = REGION_GATES.find((g) => g.id === id);
    const north = gate ? (gate.latMin + gate.latMax) / 2 >= 0 : true;
    const months = north ? [5, 6, 7] : [11, 0, 1];
    let w = 0;
    const acc = { a: 0, b: 0, c: 0, dd: 0, all: 0, v: 0, g: 0 };
    for (const m of months) {
      const v = r.airflow.monthlyWindV[m];
      const so = d.supplyOcean[m];
      const sl = d.supplyLand[m];
      if (!v || !so || !sl) continue;
      const supplyAt = (i: number): number => (so[i] ?? 0) + (sl[i] ?? 0);
      for (const i of cells) {
        const row = Math.floor(i / W);
        const col = i % W;
        const lat = latDegOfRow(grid, row);
        const cw = Math.cos((lat * Math.PI) / 180);
        w += cw;
        const north2 = row > 0 ? (row - 1) * W + col : i;
        const south2 = row < H - 1 ? (row + 1) * W + col : i;
        const eqNb = lat >= 0 ? south2 : north2;
        const polNb = lat >= 0 ? north2 : south2;
        const gradPoleward = supplyAt(eqNb) - supplyAt(polNb);
        const vPoleward = lat >= 0 ? (v[i] ?? 0) : -(v[i] ?? 0);
        const ridge =
          lat >= 0
            ? (r.windBelt.monthlyRidgeLatNDeg[m] ?? 31)
            : (r.windBelt.monthlyRidgeLatSDeg[m] ?? -31);
        const pf =
          lat >= 0
            ? (r.windBelt.monthlyPolarFrontLatNDeg[m] ?? 60)
            : (r.windBelt.monthlyPolarFrontLatSDeg[m] ?? -60);
        const aLat = Math.abs(lat);
        const ca = vPoleward > 0;
        const cb = gradPoleward > 0;
        const cc = aLat > Math.abs(ridge) - 6;
        const cd = aLat < Math.abs(pf);
        if (ca) acc.a += cw;
        if (cb) acc.b += cw;
        if (cc) acc.c += cw;
        if (cd) acc.dd += cw;
        if (ca && cb && cc && cd) acc.all += cw;
        acc.v += cw * vPoleward;
        acc.g += cw * gradPoleward;
      }
    }
    const n = Math.max(1e-9, w);
    const pct = (x: number): string => ((x / n) * 100).toFixed(0).padStart(8) + '%';
    console.log(
      `${id.split('_')[0]?.padEnd(9)} ${pct(acc.a)} ${pct(acc.b)} ${pct(acc.c)} ${pct(acc.dd)} ` +
        `${pct(acc.all)}  ${(acc.v / n).toFixed(2).padStart(9)} ${(acc.g / n).toFixed(3).padStart(9)}`,
    );
  }
  console.log(
    '\n読み: (a) が低ければ夏の南風が立っていない、(b) が低ければ湿りが極向きに' +
      '減っていない(= そもそも水が来ていない)、(c)(d) が低ければ窓の取り方の問題。',
  );
}

void main();
