// 定数を振って「季節位相・季節振幅・採点」がどう応答するかを一度に見る。
//
// 動機(2026-08-01 の実測):
//   モデルの季節サイクルは観測より約 27 日**遅く**、内陸の季節振幅が
//   +5〜8°C **過大**、沿岸はほぼ誤差なし。空回し不足ではない
//   (4/6/8/12/16 年で結果がビット一致)。
//
//   単純なスラブ応答では 振幅 = F/√(B² + (ωC)²)、位相 = atan(ωC/B)。
//   したがって
//     熱容量 C が過大 → 位相が遅れ、振幅は**小さく**なる(振幅の符号が合わない)
//     減衰 B が過小   → 位相が遅れ、振幅は**大きく**なる(両方合う)
//   よって第一容疑は減衰 B(olrBWm2PerC)と、内陸への熱輸送の弱さ。
//
//   採点の目的関数は**年平均**気温 RMSE しか見ておらず、季節振幅の誤差を
//   まったく測っていない。ケッペンの a/b/c/d は最暖月で決まるので、
//   この盲点は詳細一致率に直結する。
//
// 実行: npx tsx scripts/exp_season_response.ts [定数名] [値...]

import fs from 'node:fs';
import path from 'node:path';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { evaluateResult } from './optimize_lib';
import { openAccel } from './accel_cli';
import { areaWeightOfRow } from '../src/domain/grid';
import type { PipelineResult } from '../src/sim/types';

interface ClimJson {
  widthCells: number;
  heightCells: number;
  monthlyTemperatureDeciC: number[][];
}
const clim = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/earth_climate_2deg.json'), 'utf8'),
) as ClimJson;

const K = MODEL_CONSTANTS as unknown as Record<string, number>;
/** 暦月(観測)と冬至起点(モデル)の原点差。11 日 = 0.355 か月 */
const MONTH_ORIGIN_OFFSET = 0.355;

function harmonic(series: number[]): { amp: number; peak: number } {
  let a = 0;
  let b = 0;
  for (let m = 0; m < 12; m++) {
    const th = (2 * Math.PI * (m + 0.5)) / 12;
    const v = series[m] ?? 0;
    a += v * Math.cos(th);
    b += v * Math.sin(th);
  }
  a = (2 * a) / 12;
  b = (2 * b) / 12;
  let phi = Math.atan2(b, a);
  if (phi < 0) phi += 2 * Math.PI;
  return { amp: Math.hypot(a, b), peak: (phi / (2 * Math.PI)) * 12 };
}

interface Season {
  lagDays: number;
  ampInterior: number;
  ampCoast: number;
  ampAll: number;
}
function seasonStats(r: PipelineResult): Season {
  const grid = r.context.grid;
  const W = grid.widthCells;
  const land = r.context.terrain.landMask;
  const coastKm = r.context.landDistToCoastKm;
  const OW = clim.widthCells;
  const OH = clim.heightCells;
  const scale = Math.round(W / OW);
  let pS = 0;
  let pW = 0;
  let aiS = 0;
  let aiW = 0;
  let acS = 0;
  let acW = 0;
  let aS = 0;
  let aW = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const w = areaWeightOfRow(grid, row);
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      if (!land[i]) continue;
      const oi =
        Math.min(OH - 1, Math.floor(row / scale)) * OW + Math.min(OW - 1, Math.floor(col / scale));
      const obs: number[] = [];
      let bad = false;
      for (let m = 0; m < 12; m++) {
        const v = clim.monthlyTemperatureDeciC[m]?.[oi] ?? -9999;
        if (v <= -9000) {
          bad = true;
          break;
        }
        obs.push(v / 10);
      }
      if (bad) continue;
      const mod: number[] = [];
      for (let m = 0; m < 12; m++) mod.push(r.temperature.monthlyTemperatureC[m]?.[i] ?? 0);
      const ho = harmonic(obs);
      if (ho.amp < 2) continue;
      const hm = harmonic(mod);
      let d = hm.peak - ho.peak - MONTH_ORIGIN_OFFSET;
      while (d > 6) d -= 12;
      while (d < -6) d += 12;
      pS += w * d;
      pW += w;
      const dA = hm.amp - ho.amp;
      aS += w * dA;
      aW += w;
      const ck = coastKm[i] ?? 0;
      if (ck >= 1000) {
        aiS += w * dA;
        aiW += w;
      } else if (ck < 300) {
        acS += w * dA;
        acW += w;
      }
    }
  }
  return {
    lagDays: (pS / Math.max(1e-9, pW)) * 30.44,
    ampInterior: aiS / Math.max(1e-9, aiW),
    ampCoast: acS / Math.max(1e-9, acW),
    ampAll: aS / Math.max(1e-9, aW),
  };
}

const DEFAULT_SCANS: [string, number[]][] = [
  ['olrBWm2PerC', [2.1, 2.6, 3.2, 4.0, 5.0]],
  ['landEffectiveWaterDepthM', [0.5, 1.0, 2.0, 4.0]],
  ['diffusionWm2PerK', [0.4884, 0.65, 0.85, 1.1]],
];

const argName = process.argv[2];
const argValues = process.argv.slice(3).map(Number).filter(Number.isFinite);
const scans: [string, number[]][] =
  argName && argValues.length > 0 ? [[argName, argValues]] : DEFAULT_SCANS;

const accel = await openAccel();
const line = async (tag: string): Promise<void> => {
  const r = await runPipeline(EARTH_PARAMS, accel.opts);
  const s = evaluateResult(r);
  const q = seasonStats(r);
  console.log(
    `${tag.padStart(12)}  ${s.majorPct.toFixed(2)} ${s.detailPct.toFixed(2)} ${String(s.gates).padStart(2)} ` +
      `${s.tempRmse.toFixed(3)}  ${q.lagDays.toFixed(1).padStart(6)}  ` +
      `${q.ampInterior.toFixed(2).padStart(7)} ${q.ampCoast.toFixed(2).padStart(7)} ${q.ampAll.toFixed(2).padStart(7)}  ` +
      `${s.fitness.toFixed(2)}`,
  );
};

console.log('        値   大分類  詳細  G  気温RMSE  位相(日)   内陸振幅 沿岸振幅  全振幅   fit');
console.log('(位相・振幅はモデル − 観測。0 が理想)');
await line('基準');
for (const [name, values] of scans) {
  const base = K[name];
  if (base === undefined) {
    console.log(`定数 ${name} が見つからない`);
    continue;
  }
  console.log(`\n=== ${name}(現行 ${base}) ===`);
  for (const v of values) {
    K[name] = v;
    await line(String(v));
  }
  K[name] = base;
}
accel.close();
