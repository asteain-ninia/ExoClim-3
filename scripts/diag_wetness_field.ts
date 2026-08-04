// 診断: 土壌の湿り具合(wetness01)は、乾燥地で実際に低いのか。
//
// 対応 spec: なし(構造の診断)。
//
// なぜ measure するか(2026-08-04):
//   熱容量を湿り具合に結んだ実験(scripts/exp_land_surface.ts の案 B)で、
//   乾燥割合を 1.0 → 0.3 と 3 倍動かしても砂漠の最暖月バイアスが
//   −5.38 → −5.30°C と 0.08°C しか動かなかった。
//
//   これは理屈と合わない。τ = C/B で C が 3 倍小さくなれば ωτ は 0.5 → 0.15、
//   季節振幅の減衰は 0.894 → 0.989 と約 10% 増える。砂漠の年較差 22°C に対して
//   +2°C 前後は動くはずで、0.08°C は「効いていない」に等しい。
//
//   **効かない理由の候補**:
//     (a) モデルの砂漠が実は乾いていない(wetness01 が 1 に近い)
//     (b) EBM 格子が粗く、乾燥セルが湿ったセルと混ざって薄まる
//     (c) 粗セルの陸率が低く、海の熱容量に埋もれる
//   どれなのかを、湿り具合そのものの分布を見て切り分ける。
//
// 実行: npx tsx scripts/diag_wetness_field.ts [パラメータJSON]

import * as fs from 'node:fs';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { createGrid } from '../src/domain/grid';
import { getClimObs } from './scoring';
import { openAccel } from './accel_cli';

const PARAM_PATH = process.argv[2];

async function main(): Promise<void> {
  if (PARAM_PATH) {
    const patch = JSON.parse(fs.readFileSync(PARAM_PATH, 'utf8')) as Record<string, number>;
    const target = MODEL_CONSTANTS as unknown as Record<string, number>;
    for (const [k, v] of Object.entries(patch)) if (k in target) target[k] = v;
  }
  // 2 パスを起こして陸面状態を返させる(値は 1.0 = 熱容量は従来のまま)
  (MODEL_CONSTANTS as unknown as Record<string, number>).landDryCapacityFrac = 0.999;

  const accel = await openAccel();
  const result = await (async () => {
    try {
      return await runPipeline(EARTH_PARAMS, accel.opts);
    } finally {
      accel.close();
    }
  })();

  const land = result.precipitation.land;
  if (!land) {
    console.log('陸面状態が返っていない(土壌水分が無効か、2 パス目が走っていない)');
    return;
  }
  const grid = result.context.grid;
  const mask = result.context.terrain.landMask;
  const N = grid.cellCount;

  // 表示格子での年平均湿り具合
  const annual = new Float64Array(N);
  for (let m = 0; m < 12; m++) {
    const w = land.monthlyWetness01[m];
    if (!w) continue;
    for (let i = 0; i < N; i++) annual[i] = (annual[i] ?? 0) + (w[i] ?? 0) / 12;
  }

  // 観測降水で層別して、モデルの湿り具合を見る
  const clim = getClimObs();
  const f = Math.round(2 / grid.resolutionDeg);
  const bins = [0, 100, 250, 500, 800, 1200, 2000, 1e9];
  const names = ['<100', '100-250', '250-500', '500-800', '800-1200', '1200-2000', '>2000'];
  const acc = names.map(() => ({ n: 0, sum: 0, min: 1, max: 0 }));

  for (let cr = 0; cr < clim.heightCells; cr++) {
    for (let cc = 0; cc < clim.widthCells; cc++) {
      const ci = cr * clim.widthCells + cc;
      let pObs = 0;
      let ok = true;
      for (let m = 0; m < 12; m++) {
        const p = clim.monthlyPrecipitationMm[m]?.[ci] ?? -9999;
        if (p === -9999) {
          ok = false;
          break;
        }
        pObs += p;
      }
      if (!ok) continue;
      let b = 0;
      while (b < bins.length - 2 && pObs >= bins[b + 1]!) b++;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const gr = cr * f + dr;
          const gc = cc * f + dc;
          if (gr >= grid.heightCells || gc >= grid.widthCells) continue;
          const gi = gr * grid.widthCells + gc;
          if (!mask[gi]) continue;
          const v = annual[gi] ?? 0;
          const a = acc[b]!;
          a.n++;
          a.sum += v;
          if (v < a.min) a.min = v;
          if (v > a.max) a.max = v;
        }
      }
    }
  }

  console.log('\n観測年降水量     陸セル数   モデルの年平均湿り具合(0〜1)');
  console.log('                            平均      最小      最大');
  for (let b = 0; b < names.length; b++) {
    const a = acc[b]!;
    if (a.n === 0) continue;
    console.log(
      `  ${names[b]!.padStart(9)}      ${String(a.n).padStart(5)}    ` +
        `${(a.sum / a.n).toFixed(3)}     ${a.min.toFixed(3)}     ${a.max.toFixed(3)}`,
    );
  }

  // EBM 格子へ集約したあとの分布(平滑化でどれだけ均されるか)
  const cg = createGrid(Math.max(MODEL_CONSTANTS.ebmResolutionDeg, EARTH_PARAMS.gridResolutionDeg));
  const sum = new Float64Array(cg.cellCount);
  const cnt = new Float64Array(cg.cellCount);
  for (let row = 0; row < grid.heightCells; row++) {
    const cgRow = Math.min(
      cg.heightCells - 1,
      Math.floor((row * grid.resolutionDeg) / cg.resolutionDeg),
    );
    for (let col = 0; col < grid.widthCells; col++) {
      const si = row * grid.widthCells + col;
      if (!mask[si]) continue;
      const cgCol = Math.min(
        cg.widthCells - 1,
        Math.floor((col * grid.resolutionDeg) / cg.resolutionDeg),
      );
      const ci = cgRow * cg.widthCells + cgCol;
      sum[ci] = (sum[ci] ?? 0) + (annual[si] ?? 0);
      cnt[ci] = (cnt[ci] ?? 0) + 1;
    }
  }
  const vals: number[] = [];
  for (let i = 0; i < cg.cellCount; i++) if ((cnt[i] ?? 0) > 0) vals.push(sum[i]! / cnt[i]!);
  vals.sort((a, b) => a - b);
  const q = (p: number): number => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))]!;
  console.log(
    `\nEBM 格子(${cg.resolutionDeg}°)の陸セル ${vals.length} 個の湿り具合:\n` +
      `  5%=${q(0.05).toFixed(3)}  25%=${q(0.25).toFixed(3)}  中央=${q(0.5).toFixed(3)}  ` +
      `75%=${q(0.75).toFixed(3)}  95%=${q(0.95).toFixed(3)}`,
  );
  console.log(
    `\n熱容量が乾燥割合 0.3 で受ける倍率: 最乾 ${(0.3 + 0.7 * q(0.05)).toFixed(3)} 〜 ` +
      `最湿 ${(0.3 + 0.7 * q(0.95)).toFixed(3)}`,
  );
}

void main();
