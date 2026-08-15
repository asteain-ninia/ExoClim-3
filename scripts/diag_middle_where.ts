// 診断: **中位の陸は地理的にどこか。地域ゲートと重なるか。**
//
// 利用者の見立て(2026-08-15):
//   「中位の陸……多分南中華とかアラブ・アメリカあたりを含みますよね?
//     南側だとアルゼンチンとか。あのへんが改善したら多分ゲート埋まるんでないかな」
//
//   私は段 37 で「地域ゲートと中位の分位は別の方向を向いている」と書いたが、
//   それは**前線を強めた 1 つの手でそう見えた**だけである。
//   **中位の陸が実際にどのゲートと重なるか**は数えていない。
//
//   重なるなら、「中位を直す」と「ゲートを埋める」は同じ仕事になる。
//   **利用者の見立てが正しければ、私の「別の方向」という結論は誤りである。**
//
// 実行: npx tsx scripts/diag_middle_where.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow, lonDegOfCol } from '../src/domain/grid';
import { getClimObs, REGION_GATES } from './scoring';
import { openAccel } from './accel_cli';

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
  let r;
  try {
    r = await runPipeline(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }
  const grid = r.context.grid;
  const WC = grid.widthCells;
  const land = r.context.terrain.landMask;
  const clim = getClimObs();

  interface C { i: number; w: number; lat: number; lon: number; p: number; obs: number }
  const cells: C[] = [];
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
      let obs = 0;
      let ok = true;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        const v = clim.monthlyPrecipitationMm[m]?.[ci];
        if (v === undefined || v <= -9000) { ok = false; break; }
        obs += v;
      }
      if (!ok) continue;
      let p = 0;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) p += r.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;
      cells.push({ i, w: cw, lat, lon: lonDegOfCol(grid, col), p, obs });
    }
  }
  const pairs = cells.map((c) => [c.p, c.w] as [number, number]);
  const q25 = wquantile(pairs, 0.25);
  const q75 = wquantile(pairs, 0.75);
  const isMid = (c: C): boolean => c.p >= q25 && c.p <= q75;

  console.log(`中位の定義: 面積重み分位 25〜75% = ${q25.toFixed(0)}〜${q75.toFixed(0)} mm/年`);
  console.log('');
  console.log('【1】各ゲートの領域のうち、何割が「中位の陸」か');
  console.log('ゲート                          陸セル  中位%  モデル/観測  ゲート判定');
  const rows: Array<[string, number, number]> = [];
  for (const g of REGION_GATES) {
    let n = 0, mid = 0, mp = 0, op = 0, w = 0;
    for (const c of cells) {
      if (c.lat < g.latMin || c.lat > g.latMax) continue;
      const inLon = g.lonMin <= g.lonMax
        ? c.lon >= g.lonMin && c.lon <= g.lonMax
        : c.lon >= g.lonMin || c.lon <= g.lonMax;
      if (!inLon) continue;
      n++;
      if (isMid(c)) mid++;
      mp += c.w * c.p; op += c.w * c.obs; w += c.w;
    }
    if (n === 0) continue;
    const pct = (100 * mid) / n;
    rows.push([g.id, pct, n]);
    console.log(
      `${g.id.padEnd(30)} ${String(n).padStart(6)} ${pct.toFixed(0).padStart(5)}%` +
        `  ${(mp / Math.max(1e-9, op)).toFixed(2).padStart(9)}`,
    );
  }
  rows.sort((a, b) => b[1] - a[1]);
  console.log('');
  console.log('【2】中位の割合が高いゲート（上位 8）');
  for (const [id, pct, n] of rows.slice(0, 8)) {
    console.log(`  ${id.padEnd(30)} ${pct.toFixed(0)}%  (陸セル ${n})`);
  }
  console.log('');
  console.log('読み: 中位の割合が高いゲートは、**中位の陸を直せば一緒に直る**候補。');
  console.log('  低いゲート（熱帯・極）は別の仕事。');
}

void main();
