// 「全熱容量で積分する年数」が足りているかを実測する。
//
// 経緯(2026-08-02):
//   EBM は末尾 2 年だけを全熱容量で積分し、それ以前は熱容量 1/16 で加速する。
//   ebmYears を 4/6/8/12/16 と増やしても結果がビット一致したので
//   「周期定常に到達している」と結論したが、**これは誤り**だった。
//   spinupSteps = (ebmYears − 2) なので、どの年数でも**全熱容量の年数は常に 2**。
//   増えるのは加速期だけで、肝心の緩和は検証できていなかった。
//
//   海洋混合層の時定数は τ = C/B = (4.19e6 × 52.4) / 2.1 ≈ 3.2 年。
//   2 年は 0.6τ しかなく、加速期(τ' = 0.2 年)の状態から全熱容量の
//   周期解へ e^(−2/3.2) = 0.53 しか近づいていない可能性がある。
//
//   実測で季節位相が +27 日遅く、内陸の季節振幅が過大なのは、
//   この未緩和の症状かもしれない。
//
// 実行: npx tsx scripts/exp_ebm_fullcap.ts

import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { evaluateResult } from './optimize_lib';
import { EBM_FULL_CAPACITY_YEARS } from '../src/sim/step05_temperature';
import { openAccel } from './accel_cli';
import { areaWeightOfRow } from '../src/domain/grid';

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
const baseFull = EBM_FULL_CAPACITY_YEARS.years;
/** 暦月(観測)と冬至起点(モデル)の原点差 */
const MONTH_ORIGIN_OFFSET = 0.355;

function harmonic(series: number[]): { amp: number; peak: number } {
  let a = 0;
  let b = 0;
  for (let m = 0; m < 12; m++) {
    const th = (2 * Math.PI * (m + 0.5)) / 12;
    a += (series[m] ?? 0) * Math.cos(th);
    b += (series[m] ?? 0) * Math.sin(th);
  }
  a = (2 * a) / 12;
  b = (2 * b) / 12;
  let phi = Math.atan2(b, a);
  if (phi < 0) phi += 2 * Math.PI;
  return { amp: Math.hypot(a, b), peak: (phi / (2 * Math.PI)) * 12 };
}

const accel = await openAccel();
console.log('全熱容量  大分類   詳細  ゲート 気温RMSE  位相(日)  内陸振幅  前段との差   所要');
let prev: Float32Array | null = null;
const YEARS = process.argv.slice(2).map(Number).filter(Number.isFinite);
for (const fullYears of YEARS.length > 0 ? YEARS : [2, 3, 4, 6, 8]) {
  EBM_FULL_CAPACITY_YEARS.years = fullYears;
  // 加速期は 2 年あれば十分(τ' = 0.2 年)。合計 = 加速 2 年 + 全熱容量 N 年
  K['ebmYears'] = fullYears + 2;
  const t0 = performance.now();
  const r = await runPipeline(EARTH_PARAMS, accel.opts);
  const ms = performance.now() - t0;
  const s = evaluateResult(r);

  const grid = r.context.grid;
  const W = grid.widthCells;
  const land = r.context.terrain.landMask;
  const coastKm = r.context.landDistToCoastKm;
  const OW = clim.widthCells;
  const OH = clim.heightCells;
  const scale = Math.round(W / OW);
  let pS = 0;
  let pW = 0;
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
      if ((coastKm[i] ?? 0) >= 1000) {
        aS += w * (hm.amp - ho.amp);
        aW += w;
      }
    }
  }
  const cur = Float32Array.from(r.temperature.annualMeanC);
  let diff = '—';
  if (prev) {
    let sum = 0;
    let wsum = 0;
    for (let row = 0; row < grid.heightCells; row++) {
      const w = areaWeightOfRow(grid, row);
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        sum += w * Math.abs((cur[i] ?? 0) - (prev[i] ?? 0));
        wsum += w;
      }
    }
    diff = `${(sum / wsum).toFixed(4)}°C`;
  }
  prev = cur;
  console.log(
    `${String(fullYears).padStart(6)}    ${s.majorPct.toFixed(2)}  ${s.detailPct.toFixed(2)}  ` +
      `${String(s.gates).padStart(4)}  ${s.tempRmse.toFixed(3)}  ` +
      `${((pS / pW) * 30.44).toFixed(1).padStart(7)}  ` +
      `${(aS / Math.max(1e-9, aW)).toFixed(2).padStart(7)}  ${diff.padStart(11)}  ` +
      `${(ms / 1000).toFixed(0)}s`,
  );
}
EBM_FULL_CAPACITY_YEARS.years = baseFull;
K['ebmYears'] = baseYears;
accel.close();
console.log(
  '\n年数を増やして位相・振幅・採点が動かなくなれば緩和は足りている。' +
    '\n動き続けるなら 2 年は不足で、答えが積分年数という実装詳細に依存している。',
);
