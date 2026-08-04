// 実験: 保存型輸送に**閾値凝結**を入れると、亜熱帯砂漠が乾くか。
//
// 対応 spec: docs/FB_2026-07-31.md P2-1。
//
// 経緯(2026-08-04):
//   保存型輸送を C = λG·W(通過する水を必ず降らせる)で試したら、砂漠 6 月が
//   8.1 → 20〜28mm と**悪化**した。理由は保存則の性質で、凝結率を下げても水は
//   消えず下流で降るだけなので「抑制」が総量を動かせない。
//
//   実在の亜熱帯が乾いているのは水を消しているからではなく、**貿易風で
//   赤道側へ輸出している**から。これを表すには閾値が要る:
//
//     P = λ · max(0, W − W_crit),   W_crit = capScale · W_sat(T) / G
//
//   暑い乾燥域は W_crit が Clausius-Clapeyron で大きいので、水が通過しても
//   閾値を超えず、降らずに下流へ運ばれる。持ち上げ G は閾値を**下げる**形で
//   入る(断熱冷却で凝結しやすくなる物理そのもの)。
//
// **事前に登録する判定**:
//   成立 … 砂漠(観測<100mm/年)の 6 月降水が現行の 8.1mm より下がり、
//     かつ陸平均が観測(約 800mm)から離れない(±30% 以内)。
//     全球の水収支残差が 1e-4 以下、全月が収束すること。
//   不成立 … 閾値を強めると砂漠と一緒に湿潤域まで乾く(陸平均が崩れる)。
//     その場合、閾値の置き方(W_sat 依存の形)が違う。
//
//   注: 較正定数は風上追跡向けのままなので、v3 の絶対値は比較に使わない。
//   **砂漠の降水と陸平均の分布**だけで判定する。
//
// 入力は scripts/dump_transport_inputs.ts が書き出した場(CPU だけで回る)。
// 実行: npx tsx scripts/exp_transport_threshold.ts

import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createGrid, latDegOfRow } from '../src/domain/grid';
import { solveMoistureTransport, globalBalanceResidual } from '../src/sim/moisture_transport';
import { saturationVaporPressureHpa } from '../src/sim/step06_precipitation';
import { getClimObs } from './scoring';

const BIN = 'out/exp/transport_inputs.bin';
const META = 'out/exp/transport_inputs.json';
const MONTHS = 12;

interface Meta {
  widthCells: number;
  heightCells: number;
  cellCount: number;
  resolutionDeg: number;
  radiusKm: number;
  offsets: { monthly: number; landMask: number; precipMm: number; tempMonthly: number };
}

interface Case {
  label: string;
  /** 海面蒸発の係数(mm/月) */
  oceanEvap: number;
  /** 凝結の時定数の逆数(1/月)。閾値超過分をどれだけ速く落とすか */
  lambda: number;
  /** 保持容量の基準(mm、飽和比 1・持上げ 1 のとき) */
  capScale: number;
}

const CASES: Case[] = [
  { label: '閾値なし(前回)', oceanEvap: 120, lambda: 2.0, capScale: 0 },
  { label: 'cap=10  λ=2', oceanEvap: 120, lambda: 2.0, capScale: 10 },
  { label: 'cap=20  λ=2', oceanEvap: 120, lambda: 2.0, capScale: 20 },
  { label: 'cap=30  λ=2', oceanEvap: 120, lambda: 2.0, capScale: 30 },
  { label: 'cap=20  λ=6', oceanEvap: 120, lambda: 6.0, capScale: 20 },
  { label: 'cap=30  λ=6', oceanEvap: 120, lambda: 6.0, capScale: 30 },
  { label: 'cap=30  λ=6 E=80', oceanEvap: 80, lambda: 6.0, capScale: 30 },
  { label: 'cap=45  λ=6 E=80', oceanEvap: 80, lambda: 6.0, capScale: 45 },
];

function main(): void {
  if (!fs.existsSync(BIN)) {
    console.log('入力がない。先に scripts/dump_transport_inputs.ts を実行');
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

  // 観測が乾燥している 1° 陸セル
  const clim = getClimObs();
  const f = Math.round(2 / meta.resolutionDeg);
  const dryCells: number[] = [];
  for (let cr = 0; cr < clim.heightCells; cr++) {
    for (let cc = 0; cc < clim.widthCells; cc++) {
      const ci = cr * clim.widthCells + cc;
      let sum = 0;
      let ok = true;
      for (let m = 0; m < MONTHS; m++) {
        const p = clim.monthlyPrecipitationMm[m]?.[ci] ?? -9999;
        if (p === -9999) {
          ok = false;
          break;
        }
        sum += p;
      }
      if (!ok || sum > 100) continue;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const gr = cr * f + dr;
          const gc = cc * f + dc;
          if (gr >= meta.heightCells || gc >= meta.widthCells) continue;
          const gi = gr * meta.widthCells + gc;
          if (land[gi]) dryCells.push(gi);
        }
      }
    }
  }

  /** 陸だけの面積重み平均 */
  const landMean = (v: ArrayLike<number>): number => {
    let s = 0;
    let w = 0;
    for (let row = 0; row < meta.heightCells; row++) {
      const cw = Math.cos((latDegOfRow(grid, row) * Math.PI) / 180);
      for (let col = 0; col < meta.widthCells; col++) {
        const i = row * meta.widthCells + col;
        if (!land[i]) continue;
        s += cw * (v[i] ?? 0);
        w += cw;
      }
    }
    return s / Math.max(1e-9, w);
  };

  // 現行降水の基準
  const curAnnual = new Float32Array(N);
  let curJun = 0;
  for (let m = 0; m < MONTHS; m++) {
    const p = all.subarray(meta.offsets.precipMm + m * N, meta.offsets.precipMm + (m + 1) * N);
    for (let i = 0; i < N; i++) curAnnual[i] = (curAnnual[i] ?? 0) + (p[i] ?? 0);
    if (m === 5) for (const gi of dryCells) curJun += p[gi] ?? 0;
  }
  curJun /= Math.max(1, dryCells.length);
  let curDry = 0;
  for (const gi of dryCells) curDry += curAnnual[gi] ?? 0;
  curDry /= Math.max(1, dryCells.length);
  console.log(`乾燥セル ${dryCells.length} 個(観測: 年 44mm / 6月 3.0mm、陸平均の観測 ≈ 800mm)`);
  console.log('\n案                    陸平均   砂漠年  砂漠6月  収支残差  最大反復  未収束月  秒');
  console.log(
    `${'現行(風上追跡)'.padEnd(20)} ${landMean(curAnnual).toFixed(0).padStart(6)} ` +
      `${curDry.toFixed(0).padStart(7)} ${curJun.toFixed(1).padStart(7)}`,
  );

  for (const c of CASES) {
    const t0 = performance.now();
    const annual = new Float32Array(N);
    let jun = 0;
    let worstBal = 0;
    let maxIter = 0;
    let unconverged = 0;
    for (let m = 0; m < MONTHS; m++) {
      const base = meta.offsets.monthly + m * FIELDS * N;
      const u = all.subarray(base, base + N);
      const v = all.subarray(base + N, base + 2 * N);
      const t = all.subarray(base + 2 * N, base + 3 * N);
      const et = all.subarray(base + 3 * N, base + 4 * N);
      const g = all.subarray(base + 4 * N, base + 5 * N);
      const source = new Float32Array(N);
      const rate = new Float32Array(N);
      const cap = c.capScale > 0 ? new Float32Array(N) : null;
      for (let i = 0; i < N; i++) {
        const qs = saturationVaporPressureHpa(t[i] ?? 0) / q0;
        if (land[i]) {
          source[i] = et[i] ?? 0;
        } else {
          const spd = Math.hypot(u[i] ?? 0, v[i] ?? 0);
          source[i] = c.oceanEvap * qs * Math.min(2, (0.4 + spd / 5) / 1.4);
        }
        const gi = Math.max(0.02, g[i] ?? 1);
        if (cap) {
          // 持ち上げは閾値を下げる(断熱冷却で凝結しやすくなる)
          cap[i] = (c.capScale * qs) / gi;
          rate[i] = c.lambda;
        } else {
          rate[i] = c.lambda * gi;
        }
      }
      const r = solveMoistureTransport(grid, meta.radiusKm, u, v, source, rate, {
        maxIterations: 6000,
        ...(cap ? { holdingCapacityMm: cap } : {}),
      });
      for (let i = 0; i < N; i++) annual[i] = (annual[i] ?? 0) + (r.condensationMm[i] ?? 0);
      if (m === 5) for (const gi of dryCells) jun += r.condensationMm[gi] ?? 0;
      worstBal = Math.max(worstBal, globalBalanceResidual(grid, source, r.condensationMm));
      maxIter = Math.max(maxIter, r.iterations);
      if (!r.converged) unconverged++;
    }
    jun /= Math.max(1, dryCells.length);
    let dry = 0;
    for (const gi of dryCells) dry += annual[gi] ?? 0;
    dry /= Math.max(1, dryCells.length);
    console.log(
      `${c.label.padEnd(20)} ${landMean(annual).toFixed(0).padStart(6)} ` +
        `${dry.toFixed(0).padStart(7)} ${jun.toFixed(1).padStart(7)} ` +
        `${worstBal.toExponential(1).padStart(9)} ${String(maxIter).padStart(9)} ` +
        `${String(unconverged).padStart(9)} ${((performance.now() - t0) / 1000).toFixed(0).padStart(4)}`,
    );
  }
}

main();
