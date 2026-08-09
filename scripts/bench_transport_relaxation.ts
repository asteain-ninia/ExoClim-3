// 測定: 逐次過緩和(SOR)の係数 ω が輸送ソルバの収束にどう効くか。
//
// 対応 spec: docs/検証_輸送の収束と初期値依存_2026-08-09.md
//
// 背景: この系は拡散が凝結より 2 桁速い楕円型なので、点ガウス=ザイデルでも
// 反復は O(格子幅²) で伸びる(実測 27 万反復)。楕円型なら過緩和が桁で効く
// はずだが、移流項があるので古典の最適 ω(≈1.98)がそのまま使えるとは限らない。
// **どの ω まで安定で、どれだけ速くなるかを実測する。**
//
// ω は速度だけの量で、**不動点は変わらない**(収束点では w = wGs)。
// したがって較正定数ではなく、探索空間にも入れない。
//
// 実行: npx tsx scripts/bench_transport_relaxation.ts [月]

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

const M = Number(process.argv[2] ?? 0);
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

const SECONDS_PER_MONTH = 30.44 * 86400;
const u = field(M, 0);
const v = field(M, 1);
const et = field(M, 3);
const g = field(M, 4);
const src = new Float32Array(N);
const rate = new Float32Array(N);
const travelKmPerMonth = (8 * SECONDS_PER_MONTH) / 1000;
for (let i = 0; i < N; i++) {
  src[i] = landMask[i] ? (et[i] ?? 0) : 100;
  rate[i] = Math.max(0.05, (travelKmPerMonth / (landMask[i] ? 2400 : 1636)) * (g[i] ?? 0));
}

// 上限を固定して「同じ仕事量でどこまで残差が下がるか」を見る。
// 収束まで走らせると発散する ω で時間を浪費するため
const CAP = 20000;
console.log(`月 ${M} / 上限 ${CAP} 掃引で到達した残差`);
console.log('ω      残差        収束  掃引    秒');
for (const omega of [1.0, 1.2, 1.4, 1.6, 1.8, 1.9, 1.95]) {
  const t0 = process.hrtime.bigint();
  const r = solveMoistureTransport(grid, head.radiusKm, u, v, src, rate, {
    diffusivityM2PerS: 1.5e6,
    maxIterations: CAP,
    relaxation: omega, // 明示すると自動の落としは行わない(素の挙動を見る)
  });
  const sec = Number(process.hrtime.bigint() - t0) / 1e9;
  console.log(
    `${omega.toFixed(2)}   ${r.residual.toExponential(2).padStart(10)}   ` +
      `${r.converged ? '○' : '×'}   ${String(r.iterations).padStart(6)}  ${sec.toFixed(1).padStart(5)}`,
  );
}
console.log(
  '\n読み方: 残差が小さいほど良い。× でも残差が桁で小さければ、その ω は\n' +
    '        安定で速い。発散する ω は残差が ∞ になる(自動で 1.0 へ落とす対象)。',
);
