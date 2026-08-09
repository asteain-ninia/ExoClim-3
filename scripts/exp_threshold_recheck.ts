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
  /** true なら 2026-08-04 の手作りの源泉を使う(対照) */
  oldSource?: boolean;
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
  // ---- 対照: 源泉だけ 2026-08-04 の手作りに戻す ----
  // ソルバ(収束)と源泉(バルク式)を同時に変えているので、
  // **どちらが効いて結論が逆転したのか**を分離する
  { label: '[対照] 閾値なし・旧源泉', capScale: 0, lambda: 0, exportRate: 0, oldSource: true },
  { label: '[対照] cap=25 λ=6・旧源泉', capScale: 25, lambda: 6, exportRate: 0, oldSource: true },
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

  const curAnnual = new Float32Array(N);
  for (let m = 0; m < MONTHS; m++) {
    const p = all.subarray(meta.offsets.precipMm + m * N, meta.offsets.precipMm + (m + 1) * N);
    for (let i = 0; i < N; i++) curAnnual[i] = (curAnnual[i] ?? 0) + (p[i] ?? 0);
  }

  // 乾燥セル: **観測のケッペンが砂漠(BWh/BWk)**の陸セル。
  //
  // 最初の版は「現行モデルで年 100mm 未満の陸」で選んでいた。これは循環参照で、
  // 基準の現行モデルが良く見えるのは当たり前になる(実際 0.028 が出て、
  // 2026-08-04 の 0.085 と比べられなかった)。**観測で選ぶ。**
  // 緯度経度の決め打ちではなく観測由来なので、地理中立の原則にも反しない。
  const kob = JSON.parse(
    fs.readFileSync('tests/fixtures/earth_koppen_1deg.json', 'utf8'),
  ) as { classes: string[]; classRaster: number[] };
  const bwIds = new Set<number>();
  kob.classes.forEach((c, idx) => {
    if (c === 'BWh' || c === 'BWk') bwIds.add(idx);
  });
  const dryCells: number[] = [];
  for (let i = 0; i < N; i++) {
    if (land[i] && bwIds.has(kob.classRaster[i] ?? 0)) dryCells.push(i);
  }
  // **2 つの集合を出す。** 2026-08-04 は観測 44mm の極乾燥核を見ており、
  // BW 全域(観測 139mm)とは別物である。同じ実験の結論が集合の取り方で
  // 逆転しうるので、両方を並べて「どちらの話なのか」を曖昧にしない

  // 観測の比も**この集合で**計算する(古い記録の 0.055 を鵜呑みにしない)。
  // 観測降水は 2° なので 1° セルを 2 で割って引く
  const clim = JSON.parse(
    fs.readFileSync('tests/fixtures/earth_climate_2deg.json', 'utf8'),
  ) as { widthCells: number; monthlyPrecipitationMm: number[][] };
  const obsAnnual = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const oi = Math.floor(Math.floor(i / W) / 2) * clim.widthCells + Math.floor((i % W) / 2);
    let sum = 0;
    let ok = true;
    for (let m = 0; m < MONTHS; m++) {
      const v = clim.monthlyPrecipitationMm[m]?.[oi] ?? -9999;
      if (v < 0) {
        ok = false;
        break;
      }
      sum += v;
    }
    obsAnnual[i] = ok ? sum : -1;
  }

  // 極乾燥核: 観測の年降水が 100mm 未満の陸(2026-08-04 の 44mm 集合に近い)
  const coreCells: number[] = [];
  for (let i = 0; i < N; i++) {
    const o = obsAnnual[i] ?? -1;
    if (land[i] && o >= 0 && o < 100) coreCells.push(i);
  }

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
  // 観測の比(降水が欠損しているセルは除く)
  const obsCells = dryCells.filter((i) => (obsAnnual[i] ?? -1) >= 0);
  let obsLandSum = 0;
  let obsLandW = 0;
  for (let row = 0; row < meta.heightCells; row++) {
    const cw = Math.cos((latDegOfRow(grid, row) * Math.PI) / 180);
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      if (!land[i] || (obsAnnual[i] ?? -1) < 0) continue;
      obsLandSum += cw * (obsAnnual[i] ?? 0);
      obsLandW += cw;
    }
  }
  const obsLand = obsLandSum / Math.max(1e-9, obsLandW);
  const obsDry = cellMean(obsAnnual, obsCells);
  console.log(`乾燥セル ${dryCells.length} 個（観測のケッペンが BWh/BWk の陸、降水あり ${obsCells.length} 個）`);
  console.log(
    `観測              陸平均 ${obsLand.toFixed(0)} / 砂漠年 ${obsDry.toFixed(0)} / ` +
      `**比 ${(obsDry / obsLand).toFixed(3)}**\n`,
  );
  console.log(
    `極乾燥核 ${coreCells.length} 個（観測の年降水 100mm 未満の陸、観測 ` +
      `${cellMean(obsAnnual, coreCells).toFixed(0)}mm / 比 ` +
      `${(cellMean(obsAnnual, coreCells) / obsLand).toFixed(3)}）
`,
  );
  console.log('案                    陸平均   BW年  BW比   核年   **核比**  収支残差  掃引  秒');
  console.log(
    `${'現行(風上追跡)'.padEnd(20)} ${curLand.toFixed(0).padStart(6)} ` +
      `${curDry.toFixed(0).padStart(5)} ${(curDry / curLand).toFixed(3).padStart(5)} ` +
      `${cellMean(curAnnual, coreCells).toFixed(0).padStart(6)} ` +
      `${(cellMean(curAnnual, coreCells) / curLand).toFixed(3).padStart(8)}`,
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
        } else if (c.oldSource) {
          // 2026-08-04 の手作りの源泉(E=120 × qs相対 × 風の弱い依存)
          const spd = Math.hypot(u[i] ?? 0, v[i] ?? 0);
          const qsRel = saturationVaporPressureHpa(tc) / saturationVaporPressureHpa(20);
          source[i] = 120 * qsRel * Math.min(2, (0.4 + spd / 5) / 1.4);
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
    const core = cellMean(annual, coreCells);
    console.log(
      `${c.label.padEnd(20)} ${lm.toFixed(0).padStart(6)} ${dry.toFixed(0).padStart(5)} ` +
        `${(dry / Math.max(1e-9, lm)).toFixed(3).padStart(5)} ` +
        `${core.toFixed(0).padStart(6)} ${(core / Math.max(1e-9, lm)).toFixed(3).padStart(8)} ` +
        `${worstBal.toExponential(1).padStart(8)} ${String(maxIter).padStart(5)} ` +
        `${unconverged > 0 ? '未収束' : ''}${((performance.now() - t0) / 1000).toFixed(0).padStart(4)}`,
    );
  }
  console.log(
    '\n判定(事前登録): 比 ≤ 0.09 なら採る / 0.09〜0.12 は保留 / ≥ 0.12 なら前回の棄却が正しい。' +
      '\n**未収束の案は比較対象にしない。**',
  );
}

main();
