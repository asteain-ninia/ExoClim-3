// 診断: 中緯度東岸で**前線の持ち上げは発火しているのか**。
//
// 東アジアは熱的低気圧を 2 通り試して一度も改善しなかった(段 9 第 1・2 版)。
// 境界 4 面の分解では最大項が「北への流出 −840 mm/年」で、夏の流れが陸で
// 収束せず通り抜けている。
//
// モデルには前線の持ち上げ(`liftFrontal`)が既にあり、地理中立に書かれている:
//   極向きの風 × 極向きの湿り勾配 が両方正で、リッジ−6° と極前線の間
// 実物の梅雨・バイウ前線はまさにこの条件の場所にある。**発火しているのか。**
//
// 実行: npx tsx scripts/diag_front_firing.ts

import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { latDegOfRow, lonDegOfCol } from '../src/domain/grid';
import { REGION_GATES } from './scoring';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

const TARGETS = [
  'east_asia_humid',
  'us_southeast_humid',
  'india_tropical',
  'west_europe_temperate',
  'congo_tropical',
];

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
  const d = run.precipDiag as {
    liftFrontal: Float32Array[];
    liftConvergence: Float32Array[];
    upwindBlock: Float32Array[];
    subsidenceResidual: Float32Array[];
    condRateG: Float32Array[];
  };

  console.log('夏の 3 か月平均(陸セルの面積重み)。1.0 = 効いていない\n');
  console.log('地域            前線持上げ 収束持上げ  遮蔽   沈降残存  凝結率G  前線が発火したセル%');
  for (const id of TARGETS) {
    const cells = regionCells(r, id);
    const gate = REGION_GATES.find((g) => g.id === id);
    const north = gate ? (gate.latMin + gate.latMax) / 2 >= 0 : true;
    const months = north ? [5, 6, 7] : [11, 0, 1];
    const grid = r.context.grid;
    let w = 0;
    const acc = { f: 0, c: 0, b: 0, s: 0, g: 0, fired: 0 };
    for (const m of months) {
      for (const i of cells) {
        const cw = Math.cos((latDegOfRow(grid, Math.floor(i / grid.widthCells)) * Math.PI) / 180);
        w += cw;
        const f = d.liftFrontal[m]?.[i] ?? 1;
        acc.f += cw * f;
        acc.c += cw * (d.liftConvergence[m]?.[i] ?? 1);
        acc.b += cw * (d.upwindBlock[m]?.[i] ?? 1);
        acc.s += cw * (d.subsidenceResidual[m]?.[i] ?? 1);
        acc.g += cw * (d.condRateG[m]?.[i] ?? 0);
        if (f > 1.001) acc.fired += cw;
      }
    }
    const n = Math.max(1e-9, w);
    console.log(
      `${id.split('_')[0]?.padEnd(14)} ${(acc.f / n).toFixed(3).padStart(9)} ` +
        `${(acc.c / n).toFixed(3).padStart(10)} ${(acc.b / n).toFixed(3).padStart(7)} ` +
        `${(acc.s / n).toFixed(3).padStart(8)} ${(acc.g / n).toFixed(3).padStart(8)} ` +
        `${((acc.fired / n) * 100).toFixed(0).padStart(12)}%`,
    );
  }
  console.log(
    '\n読み: 前線持上げが 1.0 近く・発火セルが少ないなら、' +
      '実物の梅雨前線に相当する収束をモデルが作れていない。',
  );
}

void main();
