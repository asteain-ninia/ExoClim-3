// 診断: **収束指数は格子スケールの雑音か、実在の構造か。**
//
// なぜ要るか(2026-08-15):
//   中位の陸で、月平均の収束指数は 6.3〜11.5 あり強度に直せば 0.76〜0.85 の
//   はずなのに、**セルごとの強度の平均は 0.389** しかない。
//   二極分布は月ではなく**セル間**にある。
//
//   月平均の風で ∇·(qu) を取ると、隣接セルで符号が交互に変わりうる。
//   もしそうなら、収束指数は**格子スケールの雑音**を拾っており、
//   「収束が立つセル」は物理ではなく離散化の産物ということになる。
//   その場合、boost を上げても**まだらに強い雨**を作るだけである。
//
//   実在の構造(総観規模の低気圧)なら、相関長は 1000km 級のはず。
//
// 何を出すか:
//   1. 隣接セルとの符号一致率(東西・南北)。
//      **雑音なら 50% 近く**、実在の構造なら明確に 50% を超える。
//   2. 距離をずらしたときの相関(1〜8 セル)。相関長が何 km か。
//   3. 3x3 平滑をかけたときに、収束強度の平均がどう変わるか。
//      雑音なら平滑で消えて平均が下がる。構造なら残る。
//
// 実行: npx tsx scripts/diag_convergence_scale.ts

import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow, cellWidthKm, wrapCol } from '../src/domain/grid';
import { convergenceStrength01 } from '../src/sim/step06_precipitation';
import { openAccel } from './accel_cli';

const K = MODEL_CONSTANTS as unknown as Record<string, number>;

async function main(): Promise<void> {
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
  const W = grid.widthCells;
  const H = grid.heightCells;
  const land = r.context.terrain.landMask;
  const norm = K['moistureConvergenceNorm'] ?? 2;

  /** 中緯度の陸(|lat| 25〜55°)で測る */
  const inBand = (row: number): boolean => {
    const a = Math.abs(latDegOfRow(grid, row));
    return a >= 25 && a <= 55;
  };

  console.log('【1】隣接セルとの符号一致率（中緯度 25〜55° の陸）');
  console.log('  **雑音なら 50% 近く**、実在の構造なら明確に上回る');
  let sameE = 0, sameN = 0, nE = 0, nN = 0;
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const c = d.convergenceIndex[m];
    if (!c) continue;
    for (let row = 1; row < H - 1; row++) {
      if (!inBand(row)) continue;
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        if (!land[i]) continue;
        const e = row * W + wrapCol(grid, col + 1);
        const s = (row + 1) * W + col;
        const v0 = c[i] ?? 0;
        if (land[e]) { if (Math.sign(v0) === Math.sign(c[e] ?? 0)) sameE++; nE++; }
        if (land[s]) { if (Math.sign(v0) === Math.sign(c[s] ?? 0)) sameN++; nN++; }
      }
    }
  }
  console.log(`  東西方向 ${((100 * sameE) / Math.max(1, nE)).toFixed(1)}%  （${nE} 対）`);
  console.log(`  南北方向 ${((100 * sameN) / Math.max(1, nN)).toFixed(1)}%  （${nN} 対）`);

  console.log('\n【2】東西にずらしたときの相関（中緯度の陸、年平均）');
  const dxKm = cellWidthKm(grid, Math.round(H * 0.28), r.context.params.body.radiusKm);
  console.log(`  1 セル ≈ ${dxKm.toFixed(0)} km（40°付近）`);
  console.log('  ずれ(セル)  距離km   相関');
  for (const lag of [1, 2, 3, 4, 6, 8]) {
    let sxy = 0, sxx = 0, syy = 0, mx = 0, my = 0, n = 0;
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      const c = d.convergenceIndex[m];
      if (!c) continue;
      for (let row = 1; row < H - 1; row++) {
        if (!inBand(row)) continue;
        for (let col = 0; col < W; col++) {
          const i = row * W + col;
          const j = row * W + wrapCol(grid, col + lag);
          if (!land[i] || !land[j]) continue;
          mx += c[i] ?? 0; my += c[j] ?? 0; n++;
        }
      }
    }
    mx /= n; my /= n;
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      const c = d.convergenceIndex[m];
      if (!c) continue;
      for (let row = 1; row < H - 1; row++) {
        if (!inBand(row)) continue;
        for (let col = 0; col < W; col++) {
          const i = row * W + col;
          const j = row * W + wrapCol(grid, col + lag);
          if (!land[i] || !land[j]) continue;
          const a = (c[i] ?? 0) - mx, b = (c[j] ?? 0) - my;
          sxy += a * b; sxx += a * a; syy += b * b;
        }
      }
    }
    console.log(
      `${String(lag).padStart(9)}  ${(lag * dxKm).toFixed(0).padStart(6)}` +
        `  ${(sxy / Math.max(1e-9, Math.sqrt(sxx * syy))).toFixed(3).padStart(6)}`,
    );
  }

  console.log('\n【3】3x3 平滑をかけると収束強度はどう変わるか');
  console.log('  **雑音なら平滑で消えて平均が下がる**。構造なら残る');
  let rawS = 0, smoothS = 0, cnt = 0;
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const c = d.convergenceIndex[m];
    if (!c) continue;
    for (let row = 1; row < H - 1; row++) {
      if (!inBand(row)) continue;
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        if (!land[i]) continue;
        let sm = 0, k = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = row + dr;
            if (rr < 0 || rr >= H) continue;
            sm += c[rr * W + wrapCol(grid, col + dc)] ?? 0;
            k++;
          }
        }
        rawS += convergenceStrength01(c[i] ?? 0, norm);
        smoothS += convergenceStrength01(sm / k, norm);
        cnt++;
      }
    }
  }
  console.log(`  生の強度   平均 ${(rawS / cnt).toFixed(4)}`);
  console.log(`  3x3 平滑後 平均 ${(smoothS / cnt).toFixed(4)}`);
  console.log(`  比 ${(smoothS / Math.max(1e-9, rawS)).toFixed(3)}`);
  console.log(
    '\n読み: 符号一致率が 50% 近く・相関が 1 セルで急落・平滑で強度が大きく下がる\n' +
      '  なら、収束指数は**格子スケールの雑音**である。その場合 boost を上げても\n' +
      '  まだらに強い雨を作るだけで、中位の陸は湿らない。',
  );
}

void main();
