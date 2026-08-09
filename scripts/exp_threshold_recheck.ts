// 実験(段 7): 閾値凝結を**収束するソルバ**で測り直す。
//
// 事前登録: docs/事前登録_閾値凝結の測り直し_2026-08-09.md
// 前回の棄却: docs/実験記録_保存型水蒸気輸送_2026-08-04.md
//
// なぜ測り直すか:
//   2026-08-04 に閾値凝結を棄却したときのソルバは、
//   (a) 収束判定が「1 反復あたりの変化量」で、収束の判定になっていなかった
//   (b) 点緩和で、極の経度剛性のせいで実際には 40 万掃引を要する配置だった
//   1451 掃引で「収束」と報告していたので、**未収束の解で棄却した可能性が高い**。
//
//   源泉も当時は手作りの定数(E=120 × qs × 風の弱い依存)だった。
//   いまは S2 で独立に検証したバルク式がある。閾値凝結は
//   「暑い乾燥域は W_crit が大きいので水が通過する」という機構なので、
//   **W の絶対値が正しくないと働かない**。源泉を正しくして測り直す価値がある。
//
// なぜ古いスクリプトを使わないか:
//   `exp_transport_threshold.ts` は FIELDS = 5 を仮定しているが、
//   いまの書き出しは 6 面(後から沈降残存が足された)。そのまま回すと別の場を読む。
//
// 物差し(2026-08-04 と同じ): **砂漠の年降水 / 陸平均降水**。尺度に依らない。
//   観測 0.055 / 現行(非保存) 0.085 / 前回の保存型 0.12〜0.37
//
// 判定(事前登録):
//   比 ≤ 0.09        → 前回の棄却は数値の産物。閾値凝結を採る
//   比 0.09〜0.12     → 判断保留
//   比 ≥ 0.12         → 前回の棄却は正しかった
//
// GPU 不使用(書き出し済みの場を読む)。
// 実行: npx tsx scripts/exp_threshold_recheck.ts

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createGrid, latDegOfRow } from '../src/domain/grid';
import {
  globalBalanceResidual,
  solveMoistureTransport,
  SECONDS_PER_MONTH,
} from '../src/sim/moisture_transport';
import { saturationVaporPressureHpa } from '../src/sim/step06_precipitation';
import { saturationSpecificHumidity } from '../src/sim/evaporation';
import { MODEL_CONSTANTS as K } from '../src/sim/constants';

const DIR = 'out/exp';
const META = path.join(DIR, 'transport_inputs.json');
const BIN = path.join(DIR, 'transport_inputs.bin');
const MONTHS = 12;
const FIELDS = 6; // windU / windV / tempC / etMm / liftProduct / subsidenceResidual

interface Meta {
  widthCells: number;
  heightCells: number;
  cellCount: number;
  resolutionDeg: number;
  radiusKm: number;
  offsets: { monthly: number; landMask: number; precipMm: number };
}

interface Case {
  label: string;
  /** 閾値の大きさ。0 なら閾値なし(C = λG·W) */
  capScale: number;
  /** 閾値ありのときの凝結率(1/月)。G は閾値側へ回す */
  lambda: number;
  /** 鉛直輸出率(1/月)。0 なら無し */
  exportRate: number;
}

// **係数は物理から決めた 2〜3 点だけ振る**(事前登録で「目的関数で較正して
// から比べない」と決めている)。cap は可降水量の代表値 25mm の前後、
// λ は凝結寿命 1〜6 か月の範囲
const CASES: Case[] = [
  { label: '閾値なし(段 3 相当)', capScale: 0, lambda: 0, exportRate: 0 },
  { label: 'cap=15 λ=2', capScale: 15, lambda: 2, exportRate: 0 },
  { label: 'cap=25 λ=2', capScale: 25, lambda: 2, exportRate: 0 },
  { label: 'cap=25 λ=6', capScale: 25, lambda: 6, exportRate: 0 },
  { label: 'cap=40 λ=6', capScale: 40, lambda: 6, exportRate: 0 },
  { label: 'cap=25 λ=6 輸出15', capScale: 25, lambda: 6, exportRate: 15 },
  { label: 'cap=25 λ=6 輸出40', capScale: 25, lambda: 6, exportRate: 40 },
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
  const W = meta.widthCells;
  const grid = createGrid(meta.resolutionDeg);
  const land = all.subarray(meta.offsets.landMask, meta.offsets.landMask + N);

  // 乾燥セル: 観測で年降水が非常に少ない陸(サハラ・アラビア・豪州内陸)。
  // **地理を決め打ちしないため、観測降水の下位で選ぶ**
  const curAnnual = new Float32Array(N);
  for (let m = 0; m < MONTHS; m++) {
    const p = all.subarray(meta.offsets.precipMm + m * N, meta.offsets.precipMm + (m + 1) * N);
    for (let i = 0; i < N; i++) curAnnual[i] = (curAnnual[i] ?? 0) + (p[i] ?? 0);
  }
  // 観測が無いので、**現行モデルの乾燥域**ではなく緯度と現行降水から選ぶと
  // 循環参照になる。ここでは 2026-08-04 と同じく「現行モデルで年 100mm 未満の陸」
  // を乾燥セルとする(前回と同じ集合を使うことが比較の条件)
  const dryCells: number[] = [];
  for (let i = 0; i < N; i++) if (land[i] && (curAnnual[i] ?? 0) < 100) dryCells.push(i);

  const landMean = (v: ArrayLike<number>): number => {
    let s = 0;
    let w = 0;
    for (let row = 0; row < meta.heightCells; row++) {
      const cw = Math.cos((latDegOfRow(grid, row) * Math.PI) / 180);
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        if (!land[i]) continue;
        s += cw * (v[i] ?? 0);
        w += cw;
      }
    }
    return s / Math.max(1e-9, w);
  };
  const cellMean = (v: ArrayLike<number>, cells: number[]): number => {
    let s = 0;
    for (const i of cells) s += v[i] ?? 0;
    return s / Math.max(1, cells.length);
  };

  const curLand = landMean(curAnnual);
  const curDry = cellMean(curAnnual, dryCells);
  console.log(`乾燥セル ${dryCells.length} 個（現行モデルで年 100mm 未満の陸）`);
  console.log('観測の比 0.055 / 現行(非保存) の比を下に出す\n');
  console.log('案                    陸平均   砂漠年   **比**   収支残差  最大掃引  未収束  秒');
  console.log(
    `${'現行(風上追跡)'.padEnd(20)} ${curLand.toFixed(0).padStart(6)} ` +
      `${curDry.toFixed(0).padStart(7)} ${(curDry / curLand).toFixed(3).padStart(7)}`,
  );

  const pressureHpa = 1013.25;
  const travelKmPerMonth = (K.condensationRefWindMs * SECONDS_PER_MONTH) / 1000;

  for (const c of CASES) {
    const t0 = performance.now();
    const annual = new Float32Array(N);
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
      const sub = all.subarray(base + 5 * N, base + 6 * N);

      const source = new Float32Array(N);
      const rate = new Float32Array(N);
      const cap = c.capScale > 0 ? new Float32Array(N) : null;
      const xr = c.exportRate > 0 ? new Float32Array(N) : null;
      for (let i = 0; i < N; i++) {
        const tc = t[i] ?? 0;
        if (land[i]) {
          source[i] = et[i] ?? 0;
        } else {
          // **S2 で検証したバルク式**（当時は手作りの定数だった）
          const spd = Math.max(K.evapMinWindMs, Math.hypot(u[i] ?? 0, v[i] ?? 0));
          const qs = saturationSpecificHumidity(tc, pressureHpa);
          const kgPerM2PerS = 1.2 * K.evapBulkCoef * spd * qs * (1 - K.evapOceanRelHumidity);
          source[i] = Math.max(0, kgPerM2PerS * SECONDS_PER_MONTH);
        }
        const gi = Math.max(0.02, g[i] ?? 1);
        if (cap) {
          // 持ち上げは閾値を下げる(断熱冷却で凝結しやすくなる物理)
          const qsRel = saturationVaporPressureHpa(tc) / saturationVaporPressureHpa(20);
          cap[i] = (c.capScale * qsRel) / gi;
          rate[i] = c.lambda;
        } else {
          const lKm = land[i] ? K.moistureDecayLandKm : K.moistureDecayOceanKm;
          rate[i] = Math.max(0.05, (travelKmPerMonth / lKm) * gi);
        }
        if (xr) xr[i] = c.exportRate * Math.max(0, 1 - (sub[i] ?? 1));
      }
      const r = solveMoistureTransport(grid, meta.radiusKm, u, v, source, rate, {
        diffusivityM2PerS: K.moistureEddyDiffusivityM2PerS,
        maxIterations: 40000,
        ...(cap ? { holdingCapacityMm: cap } : {}),
        ...(xr ? { verticalExportRatePerMonth: xr } : {}),
      });
      for (let i = 0; i < N; i++) annual[i] = (annual[i] ?? 0) + (r.condensationMm[i] ?? 0);
      worstBal = Math.max(worstBal, globalBalanceResidual(grid, source, r.condensationMm));
      maxIter = Math.max(maxIter, r.iterations);
      if (!r.converged) unconverged++;
    }
    const lm = landMean(annual);
    const dry = cellMean(annual, dryCells);
    console.log(
      `${c.label.padEnd(20)} ${lm.toFixed(0).padStart(6)} ${dry.toFixed(0).padStart(7)} ` +
        `${(dry / Math.max(1e-9, lm)).toFixed(3).padStart(7)} ` +
        `${worstBal.toExponential(1).padStart(9)} ${String(maxIter).padStart(9)} ` +
        `${String(unconverged).padStart(6)} ${((performance.now() - t0) / 1000).toFixed(0).padStart(4)}`,
    );
  }
  console.log(
    '\n判定(事前登録): 比 ≤ 0.09 なら採る / 0.09〜0.12 は保留 / ≥ 0.12 なら前回の棄却が正しい。' +
      '\n**未収束の案は比較対象にしない。**',
  );
}

main();
