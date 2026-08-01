// 気温の季節サイクルの「位相」と「振幅」をモデルと観測で直接比べる。
//
// 二つの別々の問題を切り分けるために作った:
//   (a) **月の定義のずれ**: モデルの月 0 は北半球冬至(12/21 頃)開始、
//       観測フィクスチャは暦月(1 月始まり)。約 11 日の位相差がある。
//       これが本当に効いているなら、モデルの年周期が観測より一様に「早い」はず。
//   (b) **熱慣性の誤り**: 海が浅すぎ/深すぎれば位相が進む/遅れる。
//       これは海陸で符号が違うはず(海は遅れ、陸は早い)。
//
// 年 1 周期の調和成分(振幅と位相)を最小二乗で取り出して比べる。
// 位相は「最暖の時刻」を月単位で表す(モデルの月目盛)。
//
// 実行: npx tsx scripts/diag_seasonal_phase.ts

import fs from 'node:fs';
import path from 'node:path';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { openAccel } from './accel_cli';
import { areaWeightOfRow, latDegOfRow } from '../src/domain/grid';

interface ClimJson {
  widthCells: number;
  heightCells: number;
  monthlyTemperatureDeciC: number[][];
  monthlyPrecipitationMm: number[][];
}
const clim = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/earth_climate_2deg.json'), 'utf8'),
) as ClimJson;

const accel = await openAccel();
const r = await runPipeline(EARTH_PARAMS, accel.opts);
accel.close();

const grid = r.context.grid;
const W = grid.widthCells;
const H = grid.heightCells;
const land = r.context.terrain.landMask;
const coastKm = r.context.landDistToCoastKm;
const OW = clim.widthCells;
const OH = clim.heightCells;
const scale = Math.round(W / OW);

/**
 * 12 個の月平均から年 1 周期の調和を取り出す。
 * 月 m の中心は (m + 0.5)/12 年。
 * @returns amp = 振幅(°C)、peak = 最暖の位相(月単位 0..12)
 */
function harmonic(series: number[]): { mean: number; amp: number; peak: number } {
  let a = 0;
  let b = 0;
  let s = 0;
  for (let m = 0; m < 12; m++) {
    const th = (2 * Math.PI * (m + 0.5)) / 12;
    const v = series[m] ?? 0;
    s += v;
    a += v * Math.cos(th);
    b += v * Math.sin(th);
  }
  a = (2 * a) / 12;
  b = (2 * b) / 12;
  const amp = Math.hypot(a, b);
  // v ≈ mean + a cos + b sin = mean + amp cos(th - φ), φ = atan2(b, a)
  let phi = Math.atan2(b, a);
  if (phi < 0) phi += 2 * Math.PI;
  return { mean: s / 12, amp, peak: (phi / (2 * Math.PI)) * 12 };
}

interface Row {
  lat: number;
  weight: number;
  isLand: boolean;
  coastKm: number;
  dPeak: number; // モデル − 観測(月)。正 = モデルが遅い
  dAmp: number; // モデル − 観測(°C)
  obsAmp: number;
}
const rowsOut: Row[] = [];

for (let row = 0; row < H; row++) {
  const lat = latDegOfRow(grid, row);
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
    const hm = harmonic(mod);
    if (ho.amp < 2) continue; // 季節性の乏しい熱帯は位相が定義しにくい
    let d = hm.peak - ho.peak;
    while (d > 6) d -= 12;
    while (d < -6) d += 12;
    rowsOut.push({
      lat,
      weight: w,
      isLand: true,
      coastKm: coastKm[i] ?? 0,
      dPeak: d,
      dAmp: hm.amp - ho.amp,
      obsAmp: ho.amp,
    });
  }
}

const wMean = (sel: (x: Row) => number, sub = rowsOut): number => {
  let s = 0;
  let w = 0;
  for (const c of sub) {
    s += c.weight * sel(c);
    w += c.weight;
  }
  return w > 0 ? s / w : 0;
};
const median = (sel: (x: Row) => number, sub = rowsOut): number => {
  const v = sub.map(sel).sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)] ?? 0;
};

console.log(`季節性のある陸セル ${rowsOut.length.toLocaleString()}(観測の年振幅 ≥ 2°C)\n`);
console.log('=== 全体 ===');
console.log(
  `位相差(モデル − 観測): 面積平均 ${wMean((c) => c.dPeak).toFixed(3)} か月 ` +
    `(${(wMean((c) => c.dPeak) * 30.44).toFixed(1)} 日) / 中央値 ${median((c) => c.dPeak).toFixed(3)} か月`,
);
console.log(
  `振幅差(モデル − 観測): 面積平均 ${wMean((c) => c.dAmp).toFixed(2)}°C ` +
    `(観測平均 ${wMean((c) => c.obsAmp).toFixed(2)}°C)`,
);

const bucket = (title: string, edges: number[], key: (c: Row) => number): void => {
  console.log(`\n=== ${title} ===`);
  console.log('区分            n     位相差(月)   位相差(日)   振幅差(°C)  観測振幅(°C)');
  for (let b = 0; b < edges.length - 1; b++) {
    const lo = edges[b]!;
    const hi = edges[b + 1]!;
    const sub = rowsOut.filter((c) => key(c) >= lo && key(c) < hi);
    if (sub.length < 30) continue;
    const dp = wMean((c) => c.dPeak, sub);
    console.log(
      `${(hi > 1e8 ? `${lo}〜` : `${lo}〜${hi}`).padEnd(14, '　')}${String(sub.length).padStart(6)}` +
        `${dp.toFixed(3).padStart(12)}${(dp * 30.44).toFixed(1).padStart(12)}` +
        `${wMean((c) => c.dAmp, sub)
          .toFixed(2)
          .padStart(12)}${wMean((c) => c.obsAmp, sub)
          .toFixed(2)
          .padStart(13)}`,
    );
  }
};
bucket('海岸からの距離(km)', [0, 100, 300, 600, 1000, 1500, 2500, 1e9], (c) => c.coastKm);
bucket('緯度', [-90, -60, -40, -23.5, 0, 23.5, 40, 60, 90], (c) => c.lat);

console.log(
  '\n読み方:\n' +
    '  位相差が海岸距離に依らず一様に負(モデルが早い)なら、月の定義のずれ(約 −0.36 か月)。\n' +
    '  海岸近くだけ遅れ/内陸だけ早いなら、熱慣性(混合層深さ・陸の熱容量)の誤り。\n' +
    '  振幅差が内陸で正・沿岸で負なら、大陸性と海洋性のコントラストが過大。',
);
