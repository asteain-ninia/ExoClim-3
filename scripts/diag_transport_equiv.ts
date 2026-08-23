// 同値検証: 水蒸気輸送ソルバの新経路(線緩和前処理つき BiCGSTAB)が、
// 参照実装(従来の線緩和 SOR)と**同じ不動点**へ収束することを実測で示す。
//
// 積み残し 11(docs/積み残し一覧_2026-08-23.md)の絶対条件:
//   「収束後の W と凝結量が許容差(相対 1e-6)で一致すること」
//
// **何を比べているかを取り違えないこと。** 許容差 1e-5 で止めた解は
// それ自体が厳密解から 2e-6 ほど離れている(下の「物差し」節で測る)ので、
// 2 本の解の差はその 2 倍まで出うる。そこで 2 段で示す:
//   1. **不動点の一致**: 両経路を許容差 1e-8 まで詰めて突き合わせる。
//      ここが 1e-6 を超えたら「別の方程式を解いている」ということなので棄却。
//   2. **出荷時の一致**: 既定の許容差 1e-5 での差。判定は 1 の物差しで読む。
//
// 実行:
//   npx tsx scripts/diag_transport_equiv.ts            合成場での組み合わせ検証
//   npx tsx scripts/diag_transport_equiv.ts --pipeline  1° の全体実行で突き合わせ(約 7 分)

import { createGrid, latDegOfRow, lonDegOfCol } from '../src/domain/grid';
import {
  solveMoistureTransport,
  TRANSPORT_SOLVER_OVERRIDE,
  type MoistureTransportOptions,
} from '../src/sim/moisture_transport';

const RADIUS_KM = 6371;
const MONTHS = 12;

/** 相対差の最大。**小さすぎる基準値で割って嘘の大差を作らない**ため下駄を履かせる */
function maxRelDiff(a: ArrayLike<number>, b: ArrayLike<number>): { rel: number; abs: number } {
  let scale = 0;
  for (let i = 0; i < b.length; i++) scale = Math.max(scale, Math.abs(b[i] ?? 0));
  const floor = 1e-6 * scale;
  let rel = 0;
  let abs = 0;
  for (let i = 0; i < a.length; i++) {
    const bv = Math.abs(b[i] ?? 0);
    const d = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    if (d > abs) abs = d;
    if (bv > floor && d / bv > rel) rel = d / bv;
  }
  return { rel, abs };
}

/**
 * 1° の月別の場を決定的に組む(乱数は使わない)。
 * 実物そのものではないが、**輸送ソルバが見る形**(帯状ジェット + 季節反転 +
 * 海陸で違う源泉と凝結率)は写してある。地理を決め打ちしないため、
 * 陸は経度・緯度の三角関数だけで作る。
 */
function buildMonthlyFields(grid: ReturnType<typeof createGrid>) {
  const n = grid.cellCount;
  const land = new Float32Array(n);
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    for (let col = 0; col < grid.widthCells; col++) {
      const lon = lonDegOfCol(grid, col);
      const f =
        Math.sin((lon * Math.PI) / 60) * Math.cos((lat * Math.PI) / 70) +
        0.6 * Math.cos((lon * Math.PI) / 25 + 1) * Math.sin((lat * Math.PI) / 40);
      land[row * grid.widthCells + col] = f > 0.15 ? 1 : 0;
    }
  }
  const months: Array<{ u: Float32Array; v: Float32Array; src: Float32Array; rate: Float32Array }> =
    [];
  for (let m = 0; m < MONTHS; m++) {
    const phase = (2 * Math.PI * m) / MONTHS;
    const decl = 23.4 * Math.sin(phase);
    const u = new Float32Array(n);
    const v = new Float32Array(n);
    const src = new Float32Array(n);
    const rate = new Float32Array(n);
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = latDegOfRow(grid, row);
      const y = ((lat - decl * 0.4) * Math.PI) / 180;
      for (let col = 0; col < grid.widthCells; col++) {
        const i = row * grid.widthCells + col;
        const lon = lonDegOfCol(grid, col);
        const isLand = land[i] === 1;
        // 貿易風 + 偏西風 + 経度の波(定常波を模す)
        u[i] =
          -7 * Math.cos(2 * y) * Math.exp(-((lat / 55) ** 4)) +
          11 * Math.sin(2 * y) * Math.sin(y) +
          2.5 * Math.sin((lon * Math.PI) / 45 + phase);
        // 子午面: ITCZ へ吸い込み + 季節反転
        v[i] = -6 * Math.sin(2 * y) * Math.exp(-((((lat - decl) / 25) ** 2))) +
          1.5 * Math.cos((lon * Math.PI) / 60);
        const warmth = Math.max(0, Math.cos(((lat - decl * 0.8) * Math.PI) / 180));
        src[i] = isLand ? 20 * warmth ** 2 : 40 + 110 * warmth ** 1.5;
        rate[i] = Math.max(0.05, (isLand ? 9 : 4) * (0.4 + warmth));
      }
    }
    months.push({ u, v, src, rate });
  }
  return { land, months };
}

interface Combo {
  label: string;
  diff: number | Float32Array;
  capacity: Float32Array | null;
  vExport: Float32Array | null;
}

function buildCombos(grid: ReturnType<typeof createGrid>): Combo[] {
  const n = grid.cellCount;
  const field = new Float32Array(n);
  for (let row = 0; row < grid.heightCells; row++) {
    const aLat = Math.abs(latDegOfRow(grid, row));
    const boost = aLat > 30 && aLat < 60 ? 4 : 1;
    for (let col = 0; col < grid.widthCells; col++) field[row * grid.widthCells + col] = 1.0e6 * boost;
  }
  const cap = new Float32Array(n);
  for (let row = 0; row < grid.heightCells; row++) {
    const warm = Math.max(0, Math.cos((latDegOfRow(grid, row) * Math.PI) / 180));
    for (let col = 0; col < grid.widthCells; col++) cap[row * grid.widthCells + col] = 2 + 18 * warm;
  }
  const vx = new Float32Array(n);
  for (let row = 0; row < grid.heightCells; row++) {
    const aLat = Math.abs(latDegOfRow(grid, row));
    const sink = aLat > 18 && aLat < 35 ? 1.2 : 0;
    for (let col = 0; col < grid.widthCells; col++) vx[row * grid.widthCells + col] = sink;
  }
  return [
    { label: '拡散なし(純移流)      ', diff: 0, capacity: null, vExport: null },
    { label: '拡散スカラー 3e6       ', diff: 3.0e6, capacity: null, vExport: null },
    { label: '拡散が場(帯で 4 倍)   ', diff: field, capacity: null, vExport: null },
    { label: 'スカラー + 鉛直輸出    ', diff: 3.0e6, capacity: null, vExport: vx },
    { label: 'スカラー + 容量        ', diff: 3.0e6, capacity: cap, vExport: null },
    { label: 'スカラー + 容量 0      ', diff: 3.0e6, capacity: new Float32Array(n), vExport: null },
    { label: '場 + 容量 + 鉛直輸出   ', diff: field, capacity: cap, vExport: vx },
  ];
}

function runCombo(
  grid: ReturnType<typeof createGrid>,
  months: ReturnType<typeof buildMonthlyFields>['months'],
  combo: Combo,
  tolerance: number,
  mode: 'auto' | 'relaxation',
): { w: Float32Array[]; c: Float32Array[]; sweeps: number; ms: number; nonConverged: number } {
  const w: Float32Array[] = [];
  const c: Float32Array[] = [];
  let sweeps = 0;
  let nonConverged = 0;
  // 温間開始も本番と同じように効かせる(前の月の解を渡す)
  let warm: Float32Array | null = null;
  const t0 = performance.now();
  for (const mo of months) {
    const opts: MoistureTransportOptions = {
      diffusivityM2PerS: combo.diff,
      tolerance,
      maxIterations: 60000,
      solver: mode,
      ...(combo.capacity ? { holdingCapacityMm: combo.capacity } : {}),
      ...(combo.vExport ? { verticalExportRatePerMonth: combo.vExport } : {}),
      ...(warm ? { initialGuessMm: warm } : {}),
    };
    const r = solveMoistureTransport(grid, RADIUS_KM, mo.u, mo.v, mo.src, mo.rate, opts);
    if (!r.converged) nonConverged++;
    sweeps += r.iterations;
    w.push(r.waterMm);
    c.push(r.condensationMm);
    warm = r.waterMm;
  }
  return { w, c, sweeps, ms: performance.now() - t0, nonConverged };
}

async function main(): Promise<void> {
  const grid = createGrid(1);
  const { months } = buildMonthlyFields(grid);
  const combos = buildCombos(grid);

  console.log(`格子 ${grid.widthCells}×${grid.heightCells}(1°、${grid.cellCount} セル)× ${MONTHS} か月\n`);

  /** 2 本の月別解の最大相対差(W と凝結の大きい方) */
  const diffOf = (
    a: { w: Float32Array[]; c: Float32Array[] },
    b: { w: Float32Array[]; c: Float32Array[] },
  ): { w: number; c: number } => {
    let dw = 0;
    let dc = 0;
    for (let m = 0; m < MONTHS; m++) {
      dw = Math.max(dw, maxRelDiff(a.w[m]!, b.w[m]!).rel);
      dc = Math.max(dc, maxRelDiff(a.c[m]!, b.c[m]!).rel);
    }
    return { w: dw, c: dc };
  };

  // ---- 1. 不動点の一致(両経路を 1e-8 まで詰める)----
  console.log('■ 1. 不動点の一致(両経路とも許容差 1e-8 まで詰める)');
  console.log('   ここが 1e-6 を超えたら「別の方程式を解いている」ということなので棄却。');
  console.log(
    '  配置                     W の最大相対差  凝結の最大相対差   掃引(参照→新)      時間(参照→新)',
  );
  {
    let worst = 0;
    for (const combo of combos) {
      const ref = runCombo(grid, months, combo, 1e-8, 'relaxation');
      const now = runCombo(grid, months, combo, 1e-8, 'auto');
      const d = diffOf(now, ref);
      worst = Math.max(worst, d.w, d.c);
      console.log(
        `  ${combo.label}  ${d.w.toExponential(2)}       ${d.c.toExponential(2)}` +
          `        ${String(ref.sweeps).padStart(6)} → ${String(now.sweeps).padStart(6)}` +
          `   ${(ref.ms / 1000).toFixed(2)}s → ${(now.ms / 1000).toFixed(2)}s (${(ref.ms / Math.max(1e-9, now.ms)).toFixed(2)}×)` +
          (ref.nonConverged + now.nonConverged > 0
            ? `  × 未収束 ${ref.nonConverged}/${now.nonConverged}`
            : ''),
      );
    }
    console.log(
      `  最悪 ${worst.toExponential(2)}  ${worst <= 1e-6 ? '○ 1e-6 以内 = 同じ不動点' : '× 1e-6 を超えた'}\n`,
    );
  }

  // ---- 2. 出荷時(許容差 1e-5)----
  // **差だけを見ても読めない。** 許容差 1e-5 で止めた解はそれ自体が厳密解から
  // 離れているので、参照実装の「自分の緩さ」と並べて出す。
  console.log('■ 2. 出荷時(両経路とも既定の許容差 1e-5)— 厳密解(1e-9)を物差しに置く');
  console.log(
    '  配置                     参照↔厳密   新↔厳密   参照↔新     掃引(参照→新)      時間(参照→新)',
  );
  {
    for (const combo of combos) {
      const ref = runCombo(grid, months, combo, 1e-5, 'relaxation');
      const now = runCombo(grid, months, combo, 1e-5, 'auto');
      const dPair = diffOf(now, ref);
      const worstOf = (x: { w: number; c: number }): number => Math.max(x.w, x.c);
      // **容量ありは厳密解を採らない。** 閾値凝結は非線形で、1e-9 まで詰めると
      // 半陰的な枝の切り替えが収まらず何万掃引でも終わらない(2026-08-23 に
      // 実際に 30 分回して止めた)。どのみち両経路とも同じ線緩和を通るので
      // 差は厳密に 0 であり、物差しは要らない
      const hasCap = combo.capacity !== null && combo.capacity.some((x) => x > 0);
      let refCol = '   ―    ';
      let nowCol = '   ―    ';
      if (!hasCap) {
        const exact = runCombo(grid, months, combo, 1e-9, 'relaxation');
        refCol = worstOf(diffOf(ref, exact)).toExponential(2);
        nowCol = worstOf(diffOf(now, exact)).toExponential(2);
      }
      console.log(
        `  ${combo.label}  ${refCol}   ${nowCol}` +
          `  ${worstOf(dPair).toExponential(2)}` +
          `    ${String(ref.sweeps).padStart(6)} → ${String(now.sweeps).padStart(6)}` +
          `   ${(ref.ms / 1000).toFixed(2)}s → ${(now.ms / 1000).toFixed(2)}s (${(ref.ms / Math.max(1e-9, now.ms)).toFixed(2)}×)`,
      );
    }
    console.log(
      '  → 「参照↔新」は「参照↔厳密」と同じ桁に収まっていること。新経路は\n' +
        '     内側の目標を 1 桁厳しく取るので、**厳密解へは参照より近い**。\n',
    );
  }

  if (!process.argv.includes('--pipeline')) {
    console.log('(--pipeline を付けると 1° の全体実行でも突き合わせる。約 7 分)');
    return;
  }

  // ---- 3. パイプライン全体(1°)----
  const { runPipeline } = await import('../src/sim/pipeline');
  const { EARTH_PARAMS } = await import('../src/domain/planetParams');
  const { CONSERVATIVE_STATS } = await import('../src/sim/step06_precipitation');
  const { openAccel } = await import('./accel_cli');
  console.log('■ 3. 1° の全体実行で突き合わせ');
  const accel = await openAccel(true);
  try {
    const runs: Record<string, { annual: Float32Array; ms: number; sweeps: number; bad: number }> = {};
    for (const mode of ['relaxation', 'auto'] as const) {
      TRANSPORT_SOLVER_OVERRIDE.mode = mode;
      CONSERVATIVE_STATS.iterations = 0;
      CONSERVATIVE_STATS.nonConverged = 0;
      const t0 = performance.now();
      const r = await runPipeline(EARTH_PARAMS, accel.opts);
      const ms = performance.now() - t0;
      runs[mode] = {
        annual: Float32Array.from(r.precipitation.annualPrecipMm),
        ms,
        sweeps: CONSERVATIVE_STATS.iterations,
        bad: CONSERVATIVE_STATS.nonConverged,
      };
      console.log(
        `  ${mode.padEnd(11)} 全体 ${(ms / 1000).toFixed(1)} s  輸送の掃引合計 ${CONSERVATIVE_STATS.iterations}  未収束 ${CONSERVATIVE_STATS.nonConverged}`,
      );
    }
    TRANSPORT_SOLVER_OVERRIDE.mode = null;
    const a = runs['relaxation']!;
    const b = runs['auto']!;
    const d = maxRelDiff(b.annual, a.annual);
    console.log(
      `  年降水の最大相対差 ${d.rel.toExponential(2)}(最大絶対差 ${d.abs.toExponential(2)} mm/年)`,
    );
    console.log(`  全体の速度 ${(a.ms / b.ms).toFixed(2)} 倍`);
  } finally {
    accel.close();
  }
}

await main();
