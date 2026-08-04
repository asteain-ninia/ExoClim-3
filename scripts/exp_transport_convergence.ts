// 検査: 保存型水蒸気輸送の定常解は、反復回数に依らないか。
//
// 対応 spec: docs/FB_2026-07-31.md P2-1。
//
// なぜ最初にこれを測るか:
//   2026-08-04 の単体実験で **全 12 か月が 600 反復で未収束**だった。
//   反復回数が答えを決めている状態で接続すると、較正がその数値誤差に
//   当てはまりに行く — EBM で 3 回踏んだ「隠しパラメータ」と同じ型である
//   (docs/実験記録_EBM数値の点検_2026-08-02.md、教訓 §9)。
//   **接続の前に、収束条件が答えを一意に決めることを確かめる。**
//
// 入力はパイプラインを一度回して書き出した場を使う(GPU を較正に譲るため)。
//   npx tsx scripts/dump_transport_inputs.ts <パラメータJSON>
//
// **事前に登録する判定**:
//   合格 … 反復上限を 2 倍・4 倍と増やしたとき、降水場の面積重み平均の差が
//     許容差(0.1 mm/月)以下に収まり、かつ全球水収支の残差が 1e-4 以下。
//     このとき「答えは収束条件で決まっており、反復回数では決まらない」と言える。
//   不合格 … 上限を増やすと答えが動き続ける。接続してはいけない。
//     緩和法そのもの(掃引順・局所時間刻み・陰的化)を作り直す必要がある。
//
// 実行: npx tsx scripts/exp_transport_convergence.ts

import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createGrid, latDegOfRow } from '../src/domain/grid';
import { solveMoistureTransport, globalBalanceResidual } from '../src/sim/moisture_transport';
import { saturationVaporPressureHpa } from '../src/sim/step06_precipitation';

const BIN = 'out/exp/transport_inputs.bin';
const META = 'out/exp/transport_inputs.json';

interface Meta {
  widthCells: number;
  heightCells: number;
  cellCount: number;
  resolutionDeg: number;
  radiusKm: number;
  months: number;
  offsets: { monthly: number; landMask: number; precipMm: number; tempMonthly: number };
}

/** 面積重み平均 */
function areaMean(vals: ArrayLike<number>, W: number, H: number, res: number): number {
  const grid = createGrid(res);
  let s = 0;
  let w = 0;
  for (let row = 0; row < H; row++) {
    const cw = Math.cos((latDegOfRow(grid, row) * Math.PI) / 180);
    for (let col = 0; col < W; col++) {
      s += cw * (vals[row * W + col] ?? 0);
      w += cw;
    }
  }
  return s / Math.max(1e-9, w);
}

function main(): void {
  if (!fs.existsSync(BIN)) {
    console.log(`入力がない。先に実行: npx tsx scripts/dump_transport_inputs.ts <パラメータJSON>`);
    return;
  }
  const meta = JSON.parse(fs.readFileSync(META, 'utf8')) as Meta;
  const buf = fs.readFileSync(BIN);
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const N = meta.cellCount;
  const grid = createGrid(meta.resolutionDeg);
  const FIELDS = 5;
  const q0 = saturationVaporPressureHpa(20);
  const land = all.subarray(meta.offsets.landMask, meta.offsets.landMask + N);

  const monthInputs = (m: number) => {
    const base = meta.offsets.monthly + m * FIELDS * N;
    const u = all.subarray(base, base + N);
    const v = all.subarray(base + N, base + 2 * N);
    const t = all.subarray(base + 2 * N, base + 3 * N);
    const et = all.subarray(base + 3 * N, base + 4 * N);
    const g = all.subarray(base + 4 * N, base + 5 * N);
    const source = new Float32Array(N);
    const rate = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (land[i]) {
        source[i] = et[i] ?? 0;
      } else {
        const qs = saturationVaporPressureHpa(t[i] ?? 0) / q0;
        const spd = Math.hypot(u[i] ?? 0, v[i] ?? 0);
        source[i] = 120 * qs * Math.min(2, (0.4 + spd / 5) / 1.4);
      }
      rate[i] = 2.0 * Math.max(0.02, g[i] ?? 1);
    }
    return { u, v, source, rate };
  };

  console.log('反復上限   降水の面積重み平均   前段との差   水収支残差   実反復   秒');
  const LIMITS = [300, 600, 1200, 2400, 4800, 9600];
  let prev: Float32Array | null = null;
  for (const limit of LIMITS) {
    const t0 = performance.now();
    const acc = new Float32Array(N);
    let worstBal = 0;
    let maxIter = 0;
    let converged = 0;
    for (let m = 0; m < meta.months; m++) {
      const { u, v, source, rate } = monthInputs(m);
      const r = solveMoistureTransport(grid, meta.radiusKm, u, v, source, rate, {
        maxIterations: limit,
        // 上限だけを変えて答えが動くかを見たいので、判定は十分に厳しくしておく
        tolerance: 1e-7,
      });
      for (let i = 0; i < N; i++) acc[i] = (acc[i] ?? 0) + (r.condensationMm[i] ?? 0);
      worstBal = Math.max(worstBal, globalBalanceResidual(grid, source, r.condensationMm));
      maxIter = Math.max(maxIter, r.iterations);
      if (r.converged) converged++;
    }
    const mean = areaMean(acc, meta.widthCells, meta.heightCells, meta.resolutionDeg);
    let diff = Number.NaN;
    if (prev) {
      let s = 0;
      for (let i = 0; i < N; i++) s += Math.abs((acc[i] ?? 0) - (prev[i] ?? 0));
      diff = s / N;
    }
    const sec = (performance.now() - t0) / 1000;
    console.log(
      `${String(limit).padStart(7)}   ${mean.toFixed(3).padStart(14)} mm/年 ` +
        `${(Number.isNaN(diff) ? '—' : diff.toFixed(4)).padStart(11)} ` +
        `${worstBal.toExponential(1).padStart(11)} ${String(maxIter).padStart(7)} ` +
        `${sec.toFixed(0).padStart(5)}  収束 ${converged}/${meta.months} 月`,
    );
    prev = acc;
  }
  console.log(
    '\n判定: 上限を倍にしたときの差が 0.1 mm/月(= 1.2 mm/年)以下に収まり、\n' +
      '      水収支残差が 1e-4 以下なら「答えは反復回数で決まっていない」。',
  );
}

main();
