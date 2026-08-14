// 診断: **中位の陸に水が届かないのは、移流か・拡散か・途中の凝結か。**
//
// なぜ要るか(2026-08-15):
//   段 22〜30 で 9 回測って 9 回棄却した。**すべて凝結側(G)を触る手**だった。
//   だが診断が示した問題は「中位の陸の正味流入が 49mm/年、必要 212」であり、
//   **運ぶ側**である。輸送の内訳は一度も見ていない。
//
//   保存型の定常収支は、セルごとに
//     −∇·(uW) + D∇²W + E − rate·W = 0
//   移流流入・拡散流入・源(蒸発)・凝結の 4 項で閉じる。
//   **どの項が中位の陸で足りないのか**を数えれば、処方が決まる:
//     移流が小さい → 風か上流の W が足りない
//     拡散が小さい → 渦拡散が足りない（ただし探索空間の天井に張り付いている）
//     凝結が大きい → 途中で落ちている（= これまで触ってきた側）
//
// 実行: npx tsx scripts/diag_transport_budget.ts

import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow, cellWidthKm, cellHeightKm, wrapCol } from '../src/domain/grid';
import { SECONDS_PER_MONTH } from '../src/sim/moisture_transport';
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
  const clim = getClimObs();
  const dyKm = cellHeightKm(grid, r.context.params.body.radiusKm);
  const travelKmPerMonth = ((K['condensationRefWindMs'] ?? 0) * SECONDS_PER_MONTH) / 1000;
  const dM2 = K['moistureEddyDiffusivityM2PerS'] ?? 0;
  /** 拡散係数を km²/月 へ */
  const dKm2 = (dM2 * SECONDS_PER_MONTH) / 1e6;

  interface Cell { i: number; w: number; p: number; adv: number; dif: number; src: number; cond: number }
  const cells: Cell[] = [];
  for (let row = 1; row < H - 1; row++) {
    const lat = latDegOfRow(grid, row);
    if (lat <= -60) continue;
    const cw = Math.cos((lat * Math.PI) / 180);
    const dxKm = Math.max(20, cellWidthKm(grid, row, r.context.params.body.radiusKm));
    const cr = Math.min(clim.heightCells - 1, Math.round((row / grid.heightCells) * clim.heightCells));
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      if (!land[i]) continue;
      const cc = Math.min(clim.widthCells - 1, Math.round((col / grid.widthCells) * clim.widthCells));
      const ci = cr * clim.widthCells + cc;
      let ok = true;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        const v = clim.monthlyPrecipitationMm[m]?.[ci];
        if (v === undefined || v <= -9000) { ok = false; break; }
      }
      if (!ok) continue;

      let adv = 0, dif = 0, src = 0, cond = 0, p = 0;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        const w = d.waterMm[m];
        const u = r.airflow.monthlyWindU[m];
        const v = r.airflow.monthlyWindV[m];
        const g = d.condRateG[m];
        if (!w || !u || !v || !g) continue;
        const iE = row * W + wrapCol(grid, col + 1);
        const iW = row * W + wrapCol(grid, col - 1);
        const iN = (row - 1) * W + col;
        const iS = (row + 1) * W + col;
        // 移流流入 −∇·(uW)（風は m/s → km/月 へ）
        const kx = SECONDS_PER_MONTH / 1000;
        const fE = 0.5 * (((u[i] ?? 0) * (w[i] ?? 0)) + ((u[iE] ?? 0) * (w[iE] ?? 0))) * kx;
        const fW = 0.5 * (((u[i] ?? 0) * (w[i] ?? 0)) + ((u[iW] ?? 0) * (w[iW] ?? 0))) * kx;
        const fN = 0.5 * (((v[i] ?? 0) * (w[i] ?? 0)) + ((v[iN] ?? 0) * (w[iN] ?? 0))) * kx;
        const fS = 0.5 * (((v[i] ?? 0) * (w[i] ?? 0)) + ((v[iS] ?? 0) * (w[iS] ?? 0))) * kx;
        adv += -((fE - fW) / (2 * dxKm) + (fN - fS) / (2 * dyKm));
        // 拡散流入 D∇²W
        const lap =
          ((w[iE] ?? 0) + (w[iW] ?? 0) - 2 * (w[i] ?? 0)) / (dxKm * dxKm) +
          ((w[iN] ?? 0) + (w[iS] ?? 0) - 2 * (w[i] ?? 0)) / (dyKm * dyKm);
        dif += dKm2 * lap;
        // 源(陸面蒸発散)と凝結
        src += r.precipitation.land?.monthlyEtMm?.[m]?.[i] ?? 0;
        const lKm = K['moistureDecayLandKm'] ?? 1;
        cond += Math.max(0.05, (travelKmPerMonth / Math.max(1, lKm)) * (g[i] ?? 0)) * (w[i] ?? 0);
        p += r.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;
      }
      cells.push({ i, w: cw, p, adv, dif, src, cond });
    }
  }

  const pairs = cells.map((c) => [c.p, c.w] as [number, number]);
  const q25 = wquantile(pairs, 0.25);
  const q75 = wquantile(pairs, 0.75);
  const groups: Array<[string, Cell[]]> = [
    ['乾いた側 (下位25%)', cells.filter((c) => c.p < q25)],
    ['**中位 (25〜75%)**', cells.filter((c) => c.p >= q25 && c.p <= q75)],
    ['湿った側 (上位25%)', cells.filter((c) => c.p > q75)],
  ];
  const wm = (g: Cell[], f: (c: Cell) => number): number => {
    let s = 0, w = 0;
    for (const c of g) { s += c.w * f(c); w += c.w; }
    return s / Math.max(1e-9, w);
  };

  console.log(`陸セル ${cells.length}（南極を除く）  分位 25% = ${q25.toFixed(0)} / 75% = ${q75.toFixed(0)} mm/年\n`);
  console.log('保存型の定常収支: −∇·(uW) + D∇²W + E − rate·W = 0   （mm/年）');
  console.log('群                    移流流入  拡散流入   源 E   凝結 rate·W  残差');
  for (const [name, g] of groups) {
    const a = wm(g, (c) => c.adv), df = wm(g, (c) => c.dif);
    const s = wm(g, (c) => c.src), cd = wm(g, (c) => c.cond);
    console.log(
      `${name.padEnd(22)} ${a.toFixed(1).padStart(8)} ${df.toFixed(1).padStart(9)}` +
        ` ${s.toFixed(1).padStart(7)} ${cd.toFixed(1).padStart(11)} ${(a + df + s - cd).toFixed(1).padStart(7)}`,
    );
  }
  console.log(
    '\n読み: 中位で「移流流入」と「拡散流入」のどちらが小さいかで処方が変わる。\n' +
      '  移流が小さい → 風か上流の W が足りない\n' +
      '  拡散が小さい → 渦拡散が足りない（ただし探索空間の天井に張り付いている）\n' +
      '  凝結が大きい → 途中で落ちている（= 段 22〜30 で触ってきた側）\n' +
      '  残差は差分の取り方(セル中心 vs 面)の違いで出るので、**符号と桁**で読む。',
  );
}

void main();
