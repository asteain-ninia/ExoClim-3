// 診断: **中位の陸で、収束が立つ月と水がある月は噛み合っているか。**
//
// なぜ要るか(2026-08-15):
//   段 29 で収束持上げを生き返らせたが強さが足りなかった。分布を見ると
//   50% 分位で**収束強度は 0.129 あるのに湿潤ゲートが 0.036 まで閉じて**おり、
//   掛け算で消えていた(docs/診断_風は帯状一様ではなかった_2026-08-15.md)。
//
//   中位の陸の供給は年 80(月平均 6.7)あるので、**年で見れば足りている**。
//   つまり「収束が立つ月には乾いている」= **季節(位相)のずれ**の疑いがある。
//
//   ずれなら処方は「その月に水を届かせる」、ずれていないなら
//   `convergenceWetnessNorm = 3` が供給の絶対値に対して高すぎる、という
//   定数の話になる。**処方がまったく変わるので、掃引の前に測る。**
//
// 実行: npx tsx scripts/diag_convergence_phase.ts

import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow } from '../src/domain/grid';
import { convergenceStrength01, wetnessGate01 } from '../src/sim/step06_precipitation';
import { getClimObs } from './scoring';
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
  // 収束の場を埋めるため boost を入れて走らせる(診断時は diagM があれば
  // convIndex は計算されるが、実際の効きも見たいので有効にする)
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
  const clim = getClimObs();

  // 中位の陸を、年降水の面積重み分位 25〜75% で選ぶ(他の診断と同じ定義)
  const rows: Array<{ i: number; w: number; p: number }> = [];
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    if (lat <= -60) continue;
    const cw = Math.cos((lat * Math.PI) / 180);
    const cr = Math.min(clim.heightCells - 1, Math.round((row / grid.heightCells) * clim.heightCells));
    for (let col = 0; col < WC; col++) {
      const i = row * WC + col;
      if (!land[i]) continue;
      const cc = Math.min(clim.widthCells - 1, Math.round((col / grid.widthCells) * clim.widthCells));
      const ci = cr * clim.widthCells + cc;
      let ok = true;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        const v = clim.monthlyPrecipitationMm[m]?.[ci];
        if (v === undefined || v <= -9000) { ok = false; break; }
      }
      if (!ok) continue;
      let p = 0;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) p += r.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;
      rows.push({ i, w: cw, p });
    }
  }
  const pairs = rows.map((c) => [c.p, c.w] as [number, number]);
  const q25 = wquantile(pairs, 0.25);
  const q75 = wquantile(pairs, 0.75);
  const mid = rows.filter((c) => c.p >= q25 && c.p <= q75);
  const ws = mid.reduce((a, c) => a + c.w, 0);

  const norm = K['moistureConvergenceNorm'] ?? 2;
  const wetNorm = K['convergenceWetnessNorm'] ?? 3;
  console.log(`中位の陸 ${mid.length} セル（面積重み分位 25〜75%: ${q25.toFixed(0)}〜${q75.toFixed(0)} mm/年）`);
  console.log(`moistureConvergenceNorm = ${norm} / convergenceWetnessNorm = ${wetNorm}\n`);
  console.log('月   収束指数  強度  供給   湿潤ゲート  積(wetConv)  降水mm  観測mm');
  const sum = { conv: 0, gate: 0, both: 0 };
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    let ci = 0, sup = 0, st = 0, gt = 0, wc = 0, pm = 0;
    for (const c of mid) {
      const cv = d.convergenceIndex[m]?.[c.i] ?? 0;
      const sp =
        (d.supplyOcean[m]?.[c.i] ?? 0) + (d.supplyLand[m]?.[c.i] ?? 0) + (d.supplyStorm[m]?.[c.i] ?? 0);
      ci += c.w * cv;
      sup += c.w * sp;
      st += c.w * convergenceStrength01(cv, norm);
      gt += c.w * wetnessGate01(sp, wetNorm);
      wc += c.w * convergenceStrength01(cv, norm) * wetnessGate01(sp, wetNorm);
      pm += c.w * (r.precipitation.monthlyPrecipMm[m]?.[c.i] ?? 0);
    }
    ci /= ws; sup /= ws; st /= ws; gt /= ws; wc /= ws; pm /= ws;
    sum.conv += st; sum.gate += gt; sum.both += wc;
    console.log(
      `${String(m + 1).padStart(2)}  ${ci.toFixed(2).padStart(8)} ${st.toFixed(3).padStart(6)}` +
        ` ${sup.toFixed(2).padStart(6)} ${gt.toFixed(3).padStart(9)} ${wc.toFixed(4).padStart(11)}` +
        `  ${pm.toFixed(1).padStart(6)}`,
    );
  }
  console.log(
    `\n年平均: 強度 ${(sum.conv / 12).toFixed(3)} / ゲート ${(sum.gate / 12).toFixed(3)}` +
      ` / 積 ${(sum.both / 12).toFixed(4)}`,
  );
  console.log(
    `\n**位相の判定**: 強度と積の比 = ${(sum.both / Math.max(1e-9, sum.conv)).toFixed(3)}\n` +
      '  これが年平均のゲート値とほぼ同じなら、強度とゲートは**独立**\n' +
      '  (= 位相はずれていない。ゲートの水準そのものが低い)。\n' +
      '  年平均ゲートより明確に小さければ、**強い月ほどゲートが閉じている**\n' +
      '  = 位相がずれている。',
  );
}

void main();
