// 診断: **水蒸気フラックス収束の指数は、どの範囲に分布しているか。**
//
// なぜ要るか(2026-08-15):
//   段 29 で `convergenceLiftBoost` を生き返らせたところ、
//   **中位を守りつつ乾いた端を改善する**という今日初めての形が出た。
//   だが強さが足りず、中位の正味流入は必要量の 1 割しか増えなかった。
//
//   収束の効きは `convergenceStrength01(convIndex, moistureConvergenceNorm)` で
//   決まる。`moistureConvergenceNorm = 2` は「収束指数がこの値で 1 に飽和する」
//   正規化で、**探索空間の外にある固定値**である。
//
//   今日、飽和点や基準値が機構を殺している例を 3 つ見つけた:
//     orographicRefSlope = 800   （比が 0.05 にしかならない）
//     upwindBlockReliefM = 1e9   （比が 0 になる）
//     upwindBlockFloor = 1       （下限が 1 = 遮蔽なし）
//   **同じ型を疑う。掃引の前に分布を見る。**
//
//   指数が 2 に対してはるかに小さければ、`convergenceStrength01` は
//   常に 0 近くで、boost をいくら上げても効かない。
//   逆に 2 を大きく超えていれば飽和しており、norm を下げても意味がない。
//
// 実行: npx tsx scripts/diag_convergence_index.ts

import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow } from '../src/domain/grid';
import { openAccel } from './accel_cli';

const K = MODEL_CONSTANTS as unknown as Record<string, number>;

function wquantile(pairs: Array<[number, number]>, p: number): number {
  const a = [...pairs].sort((x, y) => x[0] - y[0]);
  const total = a.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  for (const [v, w] of a) {
    acc += w;
    if (acc >= p * total) return v;
  }
  return a[a.length - 1]?.[0] ?? 0;
}

async function main(): Promise<void> {
  // **収束を有効にして測る。** 0 のままだと診断の場は埋まるが、
  // 「効かせたときに何が起きるか」を見たいので実際に効かせた状態で採る
  K['convergenceLiftBoost'] = 0.5;
  const accel = await openAccel(true);
  let out;
  try {
    out = await runPipelineWithPrecipDiag(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }
  const { result: r, precipDiag: d } = out;
  const grid = r.context.grid;
  const WC = grid.widthCells;
  const land = r.context.terrain.landMask;
  const norm = K['moistureConvergenceNorm'] ?? 2;
  const wetNorm = K['convergenceWetnessNorm'] ?? 3;

  /** 陸セル・全月の (収束指数, 面積重み) と、そこで実際に立った持上げ倍率 */
  const idx: Array<[number, number]> = [];
  const lift: Array<[number, number]> = [];
  /** 中位の陸(緯度 20〜50°)に限った分布 */
  const idxMid: Array<[number, number]> = [];
  let positive = 0;
  let total = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    if (lat <= -60) continue;
    const cw = Math.cos((lat * Math.PI) / 180);
    for (let col = 0; col < WC; col++) {
      const i = row * WC + col;
      if (!land[i]) continue;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        const ci = d.convergenceIndex[m]?.[i] ?? 0;
        const lf = d.liftConvergence[m]?.[i] ?? 1;
        idx.push([ci, cw]);
        lift.push([lf, cw]);
        if (Math.abs(lat) >= 20 && Math.abs(lat) <= 50) idxMid.push([ci, cw]);
        if (ci > 0) positive++;
        total++;
      }
    }
  }

  console.log(`陸セル×月 ${total} 件（南極 60S 以南を除く）`);
  console.log(`正規化 moistureConvergenceNorm = ${norm}（この値で 1 に飽和）`);
  console.log(`湿潤ゲート convergenceWetnessNorm = ${wetNorm}`);
  console.log(`収束指数が正のもの: ${((100 * positive) / total).toFixed(1)}%\n`);

  console.log('分位   収束指数   指数/norm   実際の持上げ倍率');
  for (const p of [0.5, 0.75, 0.9, 0.95, 0.99, 0.999]) {
    const v = wquantile(idx, p);
    console.log(
      `${(p * 100).toFixed(1).padStart(5)}%  ${v.toFixed(4).padStart(9)}  ${(v / norm).toFixed(4).padStart(9)}` +
        `   ${wquantile(lift, p).toFixed(4).padStart(9)}`,
    );
  }
  console.log(
    `\n中緯度(|lat| 20〜50°)の収束指数: ` +
      `中央 ${wquantile(idxMid, 0.5).toFixed(4)} / ` +
      `90% ${wquantile(idxMid, 0.9).toFixed(4)} / ` +
      `99% ${wquantile(idxMid, 0.99).toFixed(4)}`,
  );
  console.log(
    '\n読み: 指数が norm に対して桁で小さければ、convergenceStrength01 は\n' +
      '  常に 0 近くで、boost をいくら上げても効かない(= norm が機構を殺している)。\n' +
      '  norm 付近まで届いているなら、効かない理由は別にある。',
  );
}

void main();
