// 検査: 温間開始が**答えを変えず、反復だけを減らす**ことを確かめる。
//
// 対応 spec: docs/計画_保存則の段階的置換_2026-08-09.md
//
// なぜ要るか:
//   保存型では同じ月を結合反復で何度も解き直すので、前回の解から始めれば
//   反復数が大きく減る。だが**速度のために答えが動いてはいけない**。
//   到達する定常解は初期値に依らないはずだが、収束判定は有限の許容差で
//   打ち切るので、**初期値が違えば許容差ぶんだけ違う解で止まりうる**。
//   その差が採点に効く大きさかどうかは、憶測ではなく実測で決める。
//
// GPU を使わない: 入力は `dump_transport_inputs.ts` が書き出した場を読む。
// 較正や段の測定と取り合わない。
//
// 実行: npx tsx scripts/check_transport_warmstart.ts

import * as fs from 'node:fs';
import * as path from 'node:path';
import { solveMoistureTransport } from '../src/sim/moisture_transport';
import type { Grid } from '../src/domain/grid';

interface Header {
  widthCells: number;
  heightCells: number;
  cellCount: number;
  resolutionDeg: number;
  radiusKm: number;
  months: number;
  offsets: { monthly: number; landMask: number };
}

const DIR = 'out/exp';
const head = JSON.parse(
  fs.readFileSync(path.join(DIR, 'transport_inputs.json'), 'utf8'),
) as Header;
const raw = fs.readFileSync(path.join(DIR, 'transport_inputs.bin'));
const all = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);

const N = head.cellCount;
const FIELDS = 6;
const grid: Grid = {
  widthCells: head.widthCells,
  heightCells: head.heightCells,
  cellCount: N,
  resolutionDeg: head.resolutionDeg,
};
const field = (m: number, f: number): Float32Array =>
  all.subarray(m * FIELDS * N + f * N, m * FIELDS * N + (f + 1) * N);
const landMask = all.subarray(head.offsets.landMask, head.offsets.landMask + N);

// 凝結率は段 1 と同じ形。定数の絶対値はここでは重要でない
// (温間開始が答えを変えるかどうかだけを見る)
const DECAY_LAND_KM = 2400;
const DECAY_OCEAN_KM = 1636;
const REF_WIND_MS = 8;
const SECONDS_PER_MONTH = 30.44 * 86400;
const DIFFUSIVITY = 1.5e6;

/**
 * **検査のやり直し(2026-08-09)**。最初の版は「cold と warm を上限 20000 で
 * 走らせて比べる」だったが、**cold が全月で上限に張り付いた**(未収束)ため、
 * 差 0.29 は「温間開始が答えを変えた」ではなく「cold が収束していない」の
 * 意味しか持たなかった。比較対象が壊れていた。
 *
 * 組み直した検査は次のとおり:
 *   1. 上限を十分に上げて **cold を収束させる**(収束しなければその月は捨てる)
 *   2. その解を **1.5 倍に崩したもの**から warm で解き直す
 *   3. 両方収束したうえで一致すれば「答えは初期値に依らない」
 *
 * 崩した解から始めるのは、前月の解より**厳しい**初期値だからである。
 * これで一致するなら、結合反復での温間開始は安全に使える。
 */
const HIGH_CAP = 400000;
const MONTHS_TO_CHECK = [0, 3, 6, 9];

console.log('月   cold反復  収束   warm反復  収束   最大相対差   cold(s)  warm(s)');
let worst = 0;
let anyUnconverged = false;
for (const m of MONTHS_TO_CHECK) {
  const u = field(m, 0);
  const v = field(m, 1);
  const et = field(m, 3);
  const g = field(m, 4);
  const src = new Float32Array(N);
  const rate = new Float32Array(N);
  const travelKmPerMonth = (REF_WIND_MS * SECONDS_PER_MONTH) / 1000;
  for (let i = 0; i < N; i++) {
    src[i] = landMask[i] ? (et[i] ?? 0) : 100;
    const lKm = landMask[i] ? DECAY_LAND_KM : DECAY_OCEAN_KM;
    rate[i] = Math.max(0.05, (travelKmPerMonth / lKm) * (g[i] ?? 0));
  }

  const t0 = process.hrtime.bigint();
  const cold = solveMoistureTransport(grid, head.radiusKm, u, v, src, rate, {
    diffusivityM2PerS: DIFFUSIVITY,
    maxIterations: HIGH_CAP,
  });
  const t1 = process.hrtime.bigint();
  const perturbed = new Float32Array(N);
  for (let i = 0; i < N; i++) perturbed[i] = (cold.waterMm[i] ?? 0) * 1.5;
  const warm = solveMoistureTransport(grid, head.radiusKm, u, v, src, rate, {
    diffusivityM2PerS: DIFFUSIVITY,
    maxIterations: HIGH_CAP,
    initialGuessMm: perturbed,
  });
  const t2 = process.hrtime.bigint();

  let meanP = 0;
  for (let i = 0; i < N; i++) meanP += cold.condensationMm[i] ?? 0;
  meanP /= N;
  let maxRel = 0;
  for (let i = 0; i < N; i++) {
    const d = Math.abs((warm.condensationMm[i] ?? 0) - (cold.condensationMm[i] ?? 0));
    maxRel = Math.max(maxRel, d / Math.max(1e-9, meanP));
  }
  if (!cold.converged || !warm.converged) anyUnconverged = true;
  else worst = Math.max(worst, maxRel);
  console.log(
    `${String(m).padStart(2)}   ${String(cold.iterations).padStart(7)}   ` +
      `${cold.converged ? '○' : '×'}   ${String(warm.iterations).padStart(7)}   ` +
      `${warm.converged ? '○' : '×'}   ${maxRel.toExponential(2).padStart(10)}   ` +
      `${(Number(t1 - t0) / 1e9).toFixed(1).padStart(6)}  ${(Number(t2 - t1) / 1e9).toFixed(1).padStart(6)}`,
  );
}

console.log(
  `\n収束した月だけで見た降水の最大相対差 ${worst.toExponential(2)}` +
    (anyUnconverged ? '  ※上限に達した月があり、そこは判定から除外した' : ''),
);
console.log(
  '\n判定: 収束した月どうしで相対差が許容差(1e-5)と同程度なら\n' +
    '      「答えは初期値に依らない」。**速度のために答えを動かさない。**',
);
