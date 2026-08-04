// 実験: 鉛直輸出項 + ハドレー閉包で、保存型輸送が亜熱帯を乾かせるか。
//
// 対応 spec: docs/FB_2026-07-31.md P2-1。
// 経緯: docs/実験記録_保存型水蒸気輸送_2026-08-04.md
//
// これまでに分かっていること:
//   - 単純な置き換え(C = λG·W)も閾値凝結も砂漠を乾かせない。
//   - 理由は 2 次元の柱収支が「乾いた収束」を表せないこと。サハラの熱的低気圧は
//     地表で収束流を作るので、柱収支しか無ければ必ずどこかで降らせるしかない。
//
// 今回入れるもの:
//   ∂W/∂t = E − P − ∇·(WV) − X
//   X = σ·W        沈降域で柱から抜ける水蒸気(降水にならない)
//   σ = exportRate × (1 − 沈降残存)   沈降が強いほど大きい
//
//   X は水の破壊ではない。単層モデルが解けない鉛直輸送であり、**抜けた水は
//   上昇域へ返して全球で閉じる**(ハドレー循環の閉包)。返さなければ水が消えて
//   全球水収支が合わなくなる — それは「乾いた」のではなく「壊れた」である。
//
//   返し先の重み: 持上げ倍率 G > 1 のセル(上昇域)に (G − 1) で比例配分。
//   外側ループで「輸出量 → 返す量 → 解き直し」を繰り返し、収支が閉じるまで回す。
//
// **事前に登録する判定**:
//   成立 … 砂漠(観測<100mm/年)の 砂漠/陸平均 比が現行の 0.085 より下がり、
//     観測の 0.055 に近づく。かつ全球水収支の残差(源と降水の差)が 1e-3 以下。
//   不成立 … 比が下がらない、または輸出を強めると陸平均が崩れる(湿潤域まで乾く)。
//     その場合、2 次元の柱では亜熱帯乾燥を作れないという結論になり、
//     現行の風上追跡 + 抑制倍率を維持する判断になる。
//
// **GPU を使わない**(書き出した場を読む)。較正と並行して回せる。
// 実行: npx tsx scripts/exp_transport_hadley.ts

import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createGrid, latDegOfRow } from '../src/domain/grid';
import { solveMoistureTransport } from '../src/sim/moisture_transport';
import { saturationVaporPressureHpa } from '../src/sim/step06_precipitation';
import { getClimObs } from './scoring';

const BIN = 'out/exp/transport_inputs.bin';
const META = 'out/exp/transport_inputs.json';
const MONTHS = 12;
const FIELDS = 6;

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
  oceanEvap: number;
  lambda: number;
  capScale: number;
  /** 鉛直輸出の強さ(1/月、沈降残存 0 のとき) */
  exportRate: number;
  /**
   * 抜いた水の返し方:
   *   'source' … 上昇域へ**地表の源**として返す(再び移流される)
   *   'precip' … 上昇域の**降水として直接**計上する(再移流しない)
   *   'none'   … 返さない(全球収支が合わない。切り分け用の参照)
   * 'source' は実物と噛み合わない可能性がある — ハドレーの戻り流は上空の
   * 乾いた空気なので、ITCZ へ足した水が地表風で亜熱帯へ戻るのは筋が違う。
   */
  returnAs: 'source' | 'precip' | 'none';
}

const CASES: Case[] = [
  { label: '輸出なし', oceanEvap: 80, lambda: 6, capScale: 30, exportRate: 0, returnAs: 'none' },
  { label: '輸出15 源で返す', oceanEvap: 80, lambda: 6, capScale: 30, exportRate: 15, returnAs: 'source' },
  { label: '輸出40 源で返す', oceanEvap: 80, lambda: 6, capScale: 30, exportRate: 40, returnAs: 'source' },
  { label: '輸出15 降水で返す', oceanEvap: 80, lambda: 6, capScale: 30, exportRate: 15, returnAs: 'precip' },
  { label: '輸出40 降水で返す', oceanEvap: 80, lambda: 6, capScale: 30, exportRate: 40, returnAs: 'precip' },
  { label: '輸出15 返さない', oceanEvap: 80, lambda: 6, capScale: 30, exportRate: 15, returnAs: 'none' },
  { label: '輸出40 返さない', oceanEvap: 80, lambda: 6, capScale: 30, exportRate: 40, returnAs: 'none' },
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
  const q0 = saturationVaporPressureHpa(20);
  const land = all.subarray(meta.offsets.landMask, meta.offsets.landMask + N);

  // 面積(相対)
  const areaOf = new Float64Array(meta.heightCells);
  for (let row = 0; row < meta.heightCells; row++) {
    areaOf[row] = Math.max(0, Math.cos((latDegOfRow(grid, row) * Math.PI) / 180));
  }
  const cellArea = (i: number): number => areaOf[Math.floor(i / meta.widthCells)] ?? 0;

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

  const landMean = (v: ArrayLike<number>): number => {
    let s = 0;
    let w = 0;
    for (let i = 0; i < N; i++) {
      if (!land[i]) continue;
      const a = cellArea(i);
      s += a * (v[i] ?? 0);
      w += a;
    }
    return s / Math.max(1e-9, w);
  };

  // 現行降水の基準
  const curAnnual = new Float32Array(N);
  for (let m = 0; m < MONTHS; m++) {
    const p = all.subarray(meta.offsets.precipMm + m * N, meta.offsets.precipMm + (m + 1) * N);
    for (let i = 0; i < N; i++) curAnnual[i] = (curAnnual[i] ?? 0) + (p[i] ?? 0);
  }
  let curDry = 0;
  for (const gi of dryCells) curDry += curAnnual[gi] ?? 0;
  curDry /= Math.max(1, dryCells.length);
  const curLand = landMean(curAnnual);
  console.log(`乾燥セル ${dryCells.length} 個。観測: 砂漠 44mm / 陸平均 ≈ 800mm / 比 0.055`);
  console.log('\n案               陸平均   砂漠年   砂漠/陸平均   水収支残差  外側反復  秒');
  console.log(
    `${'現行(風上追跡)'.padEnd(16)} ${curLand.toFixed(0).padStart(6)} ${curDry.toFixed(0).padStart(7)} ` +
      `${(curDry / curLand).toFixed(3).padStart(11)}`,
  );

  for (const c of CASES) {
    const t0 = performance.now();
    const annual = new Float32Array(N);
    let worstImbalance = 0;
    let outerMax = 0;
    for (let m = 0; m < MONTHS; m++) {
      const base = meta.offsets.monthly + m * FIELDS * N;
      const u = all.subarray(base, base + N);
      const v = all.subarray(base + N, base + 2 * N);
      const t = all.subarray(base + 2 * N, base + 3 * N);
      const et = all.subarray(base + 3 * N, base + 4 * N);
      const g = all.subarray(base + 4 * N, base + 5 * N);
      const sub = all.subarray(base + 5 * N, base + 6 * N);

      const baseSource = new Float32Array(N);
      const rate = new Float32Array(N);
      const cap = c.capScale > 0 ? new Float32Array(N) : null;
      const xr = new Float32Array(N);
      // 上昇域の重み(返し先)
      const upW = new Float64Array(N);
      let upTotal = 0;
      for (let i = 0; i < N; i++) {
        const qs = saturationVaporPressureHpa(t[i] ?? 0) / q0;
        if (land[i]) {
          baseSource[i] = et[i] ?? 0;
        } else {
          const spd = Math.hypot(u[i] ?? 0, v[i] ?? 0);
          baseSource[i] = c.oceanEvap * qs * Math.min(2, (0.4 + spd / 5) / 1.4);
        }
        const gi = Math.max(0.02, g[i] ?? 1);
        if (cap) {
          cap[i] = (c.capScale * qs) / gi;
          rate[i] = c.lambda;
        } else {
          rate[i] = c.lambda * gi;
        }
        // 沈降が強い(残存が小さい)ほど鉛直に抜ける
        xr[i] = c.exportRate * Math.max(0, 1 - (sub[i] ?? 1));
        // 返し先: 持上げが強いセル
        const up = Math.max(0, gi - 1);
        upW[i] = up * cellArea(i);
        upTotal += upW[i]!;
      }

      // 外側ループ: 輸出 → 上昇域へ返す → 解き直す
      const source = Float32Array.from(baseSource);
      let outer = 0;
      let imbalance = 1;
      let cond: Float32Array = new Float32Array(N);
      for (outer = 1; outer <= 12; outer++) {
        const r = solveMoistureTransport(grid, meta.radiusKm, u, v, source, rate, {
          maxIterations: 6000,
          ...(cap ? { holdingCapacityMm: cap } : {}),
          ...(c.exportRate > 0 ? { verticalExportRatePerMonth: xr } : {}),
        });
        cond = r.condensationMm;
        // 抜けた総量を上昇域へ返す
        let exported = 0;
        for (let i = 0; i < N; i++) exported += cellArea(i) * (r.exportedMm[i] ?? 0);
        if (upTotal <= 0 || c.exportRate === 0 || c.returnAs !== 'source') {
          // 返さない場合はそのまま(収支は合わない — 切り分け用)
          if (c.returnAs === 'precip' && upTotal > 0 && c.exportRate > 0) {
            // 上昇域の**降水として直接**計上する。地表の源にしないので再移流しない
            const perWeight = exported / upTotal;
            const withReturn = Float32Array.from(cond);
            for (let i = 0; i < N; i++) {
              withReturn[i] = (cond[i] ?? 0) + perWeight * Math.max(0, (g[i] ?? 1) - 1);
            }
            cond = withReturn;
          }
          imbalance = 0;
          break;
        }
        const perWeight = exported / upTotal;
        for (let i = 0; i < N; i++) {
          source[i] = (baseSource[i] ?? 0) + perWeight * Math.max(0, (g[i] ?? 1) - 1);
        }
        // 収支: 源(元の蒸発)と降水の総量が合っているか
        let sSum = 0;
        let pSum = 0;
        for (let i = 0; i < N; i++) {
          const a = cellArea(i);
          sSum += a * (baseSource[i] ?? 0);
          pSum += a * (cond[i] ?? 0);
        }
        imbalance = Math.abs(sSum - pSum) / Math.max(1e-9, sSum);
        if (imbalance < 1e-3) break;
      }
      outerMax = Math.max(outerMax, outer);
      worstImbalance = Math.max(worstImbalance, imbalance);
      for (let i = 0; i < N; i++) annual[i] = (annual[i] ?? 0) + (cond[i] ?? 0);
    }
    let dry = 0;
    for (const gi of dryCells) dry += annual[gi] ?? 0;
    dry /= Math.max(1, dryCells.length);
    const lm = landMean(annual);
    console.log(
      `${c.label.padEnd(16)} ${lm.toFixed(0).padStart(6)} ${dry.toFixed(0).padStart(7)} ` +
        `${(dry / Math.max(1e-9, lm)).toFixed(3).padStart(11)} ` +
        `${worstImbalance.toExponential(1).padStart(11)} ${String(outerMax).padStart(9)} ` +
        `${((performance.now() - t0) / 1000).toFixed(0).padStart(4)}`,
    );
  }
  console.log('\n判定: 砂漠/陸平均 が 0.085 より下がって 0.055 へ近づき、水収支残差 ≤ 1e-3 なら成立');
}

main();
