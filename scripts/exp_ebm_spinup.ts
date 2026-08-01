// EBM の積分年数を変えて、季節位相・振幅・採点がどう動くかを測る。
//
// 疑い(2026-08-01):
//   海洋混合層の時定数 τ = C/B ≈ (4.19e6 × 50m)/2.1 ≈ 3.2 年。
//   現行は 4 年積分で、最初の 2 年は熱容量 1/16 の空回し。
//   **全熱容量で回るのは 2 年しかなく、τ の 0.6 倍**。周期定常に届いていない
//   可能性がある。届いていなければ、答えは積分年数という実装詳細に依存する
//   (EBM の反復回数と同じ構造の欠陥)。
//
//   実測では季節位相がモデルのほうが 26 日遅れており(月定義のずれを補正後)、
//   これは「まだ緩和しきっていない」症状と整合する。
//
// 測ること: 年数 → 位相差・振幅差・採点。年数を増やして動かなくなれば
// 周期定常に達したと言える。動き続けるなら年数が足りていない。
//
// 実行: npx tsx scripts/exp_ebm_spinup.ts

import fs from 'node:fs';
import path from 'node:path';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { evaluateResult } from './optimize_lib';
import { openAccel } from './accel_cli';
import { areaWeightOfRow, latDegOfRow } from '../src/domain/grid';

interface ClimJson {
  widthCells: number;
  heightCells: number;
  monthlyTemperatureDeciC: number[][];
}
const clim = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/earth_climate_2deg.json'), 'utf8'),
) as ClimJson;

const K = MODEL_CONSTANTS as unknown as Record<string, number>;
const baseYears = K['ebmYears'] ?? 4;

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

/** 暦月(観測)とモデル月(冬至起点)の位相差。11 日 = 0.355 か月 */
const MONTH_ORIGIN_OFFSET = 0.355;

const accel = await openAccel();
console.log('年数  大分類   詳細 ゲート 気温RMSE  位相遅れ(日)  内陸振幅差  沿岸振幅差   所要');

for (const years of [4, 6, 8, 12, 16]) {
  K['ebmYears'] = years;
  const t0 = Date.now();
  const r = await runPipeline(EARTH_PARAMS, accel.opts);
  const s = evaluateResult(r);
  const grid = r.context.grid;
  const W = grid.widthCells;
  const land = r.context.terrain.landMask;
  const coastKm = r.context.landDistToCoastKm;
  const OW = clim.widthCells;
  const OH = clim.heightCells;
  const scale = Math.round(W / OW);
  let pSum = 0;
  let pW = 0;
  let ampInSum = 0;
  let ampInW = 0;
  let ampCoSum = 0;
  let ampCoW = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const w = areaWeightOfRow(grid, row);
    void latDegOfRow(grid, row);
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
      const hm = harmonic(mod);
      if (ho.amp < 2) continue;
      let d = hm.peak - ho.peak - MONTH_ORIGIN_OFFSET;
      while (d > 6) d -= 12;
      while (d < -6) d += 12;
      pSum += w * d;
      pW += w;
      const dAmp = hm.amp - ho.amp;
      const ck = coastKm[i] ?? 0;
      if (ck >= 1000) {
        ampInSum += w * dAmp;
        ampInW += w;
      } else if (ck < 300) {
        ampCoSum += w * dAmp;
        ampCoW += w;
      }
    }
  }
  console.log(
    `${String(years).padStart(4)}  ${s.majorPct.toFixed(2)}  ${s.detailPct.toFixed(2)}  ` +
      `${String(s.gates).padStart(4)}  ${s.tempRmse.toFixed(3)}  ` +
      `${((pSum / pW) * 30.44).toFixed(1).padStart(11)}  ` +
      `${(ampInSum / Math.max(1e-9, ampInW)).toFixed(2).padStart(10)}  ` +
      `${(ampCoSum / Math.max(1e-9, ampCoW)).toFixed(2).padStart(10)}  ` +
      `${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );
}
K['ebmYears'] = baseYears;
accel.close();
console.log(
  '\n年数を増やして位相・振幅が動かなくなれば周期定常に達している。\n' +
    '動き続けるなら、現行の 4 年は足りておらず、答えが積分年数に依存している。',
);
