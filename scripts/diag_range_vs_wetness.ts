// 診断: 気温の年較差の誤差は、その土地の**湿り具合**で説明できるか。
//
// 対応 spec: なし(構造の診断)。
//
// なぜ測るか(2026-08-03 の比較画像から):
//   年較差の差分図が明確な二極に分かれていた。
//     中央シベリア・中央アジア・北米中央部 … モデルの振幅が**大きすぎる**
//     サハラ・アラビア・オーストラリア・北極沿岸 … **小さすぎる**
//   陸の熱容量は全球で 1 つの定数(landEffectiveWaterDepthM = 1.2 m 水相当)
//   なので、この分布は原理的に両立しない。実際の陸は湿っていれば熱容量が
//   大きく(振幅が小さく)、乾いていれば小さい(振幅が大きい)。
//
// 事前に登録する判定:
//   **成立** … 年較差の誤差(モデル − 観測)が観測降水量と**正の相関**を持つ。
//     湿った土地ほどモデルの振幅が過大 = 熱容量が足りない、
//     乾いた土地ほど過小 = 熱容量が余っている、という向きになる。
//     このとき熱容量を土壌水分に結び付ければ両端が同時に直る。
//   **不成立** … 相関が無い / 符号が逆。原因は熱容量ではないので、
//     日射の季節振幅・雪氷アルベドの季節変化など別の筋を探す。
//
//   湿り具合の物差しに**観測**降水量を使うのは意図的。モデルの降水を使うと
//   「降水の誤差」と「気温の誤差」が混ざり、どちらの話か分からなくなる。
//
// 実行: npx tsx scripts/diag_range_vs_wetness.ts [パラメータJSON]

import * as fs from 'node:fs';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { getClimObs } from './scoring';
import { openAccel } from './accel_cli';

const PARAM_PATH = process.argv[2];

interface Cell {
  lat: number;
  modelRange: number;
  obsRange: number;
  err: number;
  obsPrecip: number;
  /** 面積重み */
  w: number;
  /**
   * 年較差の誤差 = 最暖月の誤差 − 最寒月の誤差。**分解して見ることが要点** —
   * 「夏が暑すぎる」と「冬が寒すぎる」は同じ年較差の過大を作るが、
   * 原因も直し方も違う(前者は夏の蒸発冷却・熱容量、後者は冬の熱輸送・雪氷)。
   * 月は観測の最暖月・最寒月で揃える(モデル側で取り直すと位相のずれが混ざる)
   */
  warmBias: number;
  coldBias: number;
}

function pearson(xs: number[], ys: number[], ws: number[]): number {
  let sw = 0,
    sx = 0,
    sy = 0;
  for (let i = 0; i < xs.length; i++) {
    sw += ws[i]!;
    sx += ws[i]! * xs[i]!;
    sy += ws[i]! * ys[i]!;
  }
  const mx = sx / sw;
  const my = sy / sw;
  let cxy = 0,
    cxx = 0,
    cyy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    cxy += ws[i]! * dx * dy;
    cxx += ws[i]! * dx * dx;
    cyy += ws[i]! * dy * dy;
  }
  return cxy / Math.sqrt(cxx * cyy);
}

async function main(): Promise<void> {
  if (PARAM_PATH) {
    const patch = JSON.parse(fs.readFileSync(PARAM_PATH, 'utf8')) as Record<string, number>;
    const target = MODEL_CONSTANTS as unknown as Record<string, number>;
    for (const [k, v] of Object.entries(patch)) if (k in target) target[k] = v;
    console.log(`パラメータ: ${PARAM_PATH}`);
  }
  const accel = await openAccel();
  const result = await (async () => {
    try {
      return await runPipeline(EARTH_PARAMS, accel.opts);
    } finally {
      accel.close();
    }
  })();

  const clim = getClimObs();
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const f = Math.round(2 / grid.resolutionDeg);
  const cells: Cell[] = [];

  for (let cr = 0; cr < clim.heightCells; cr++) {
    const lat = 89 - cr * 2;
    const w = Math.cos((lat * Math.PI) / 180);
    for (let cc = 0; cc < clim.widthCells; cc++) {
      const ci = cr * clim.widthCells + cc;
      const tMon = new Array<number>(12).fill(0);
      let n = 0;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const gr = cr * f + dr;
          const gc = cc * f + dc;
          if (gr >= grid.heightCells || gc >= grid.widthCells) continue;
          const gi = gr * grid.widthCells + gc;
          if (!land[gi]) continue;
          n++;
          for (let m = 0; m < 12; m++) {
            tMon[m] = (tMon[m] ?? 0) + (result.temperature.monthlyTemperatureC[m]?.[gi] ?? 0);
          }
        }
      }
      if (n === 0) continue;
      for (let m = 0; m < 12; m++) tMon[m] = (tMon[m] ?? 0) / n;

      const tObs: number[] = [];
      let pObs = 0;
      let ok = true;
      for (let m = 0; m < 12; m++) {
        const t = clim.monthlyTemperatureDeciC[m]?.[ci] ?? -9999;
        const p = clim.monthlyPrecipitationMm[m]?.[ci] ?? -9999;
        if (t === -9999 || p === -9999) {
          ok = false;
          break;
        }
        tObs.push(t / 10);
        pObs += p;
      }
      if (!ok) continue;

      const modelRange = Math.max(...tMon) - Math.min(...tMon);
      const obsRange = Math.max(...tObs) - Math.min(...tObs);
      // 観測の最暖月・最寒月を基準にモデルの同じ月を引く
      let mWarm = 0;
      let mCold = 0;
      for (let m = 1; m < 12; m++) {
        if (tObs[m]! > tObs[mWarm]!) mWarm = m;
        if (tObs[m]! < tObs[mCold]!) mCold = m;
      }
      cells.push({
        lat,
        modelRange,
        obsRange,
        err: modelRange - obsRange,
        obsPrecip: pObs,
        w,
        warmBias: tMon[mWarm]! - tObs[mWarm]!,
        coldBias: tMon[mCold]! - tObs[mCold]!,
      });
    }
  }

  console.log(`比較できた 2° 陸セル: ${cells.length}`);

  // ---- 湿り具合で層別 ----
  const bins = [0, 100, 250, 500, 800, 1200, 2000, 1e9];
  const names = ['<100', '100-250', '250-500', '500-800', '800-1200', '1200-2000', '>2000'];
  console.log('\n観測年降水量 [mm]   セル数   誤差(モデル−観測)   モデル年較差   観測年較差');
  for (let b = 0; b < bins.length - 1; b++) {
    const g = cells.filter((c) => c.obsPrecip >= bins[b]! && c.obsPrecip < bins[b + 1]!);
    if (g.length === 0) continue;
    const sw = g.reduce((a, c) => a + c.w, 0);
    const me = g.reduce((a, c) => a + c.w * c.err, 0) / sw;
    const mm = g.reduce((a, c) => a + c.w * c.modelRange, 0) / sw;
    const mo = g.reduce((a, c) => a + c.w * c.obsRange, 0) / sw;
    console.log(
      `  ${names[b]!.padStart(9)}      ${String(g.length).padStart(5)}   ` +
        `${me >= 0 ? '+' : ''}${me.toFixed(2).padStart(6)} °C        ` +
        `${mm.toFixed(1).padStart(5)} °C      ${mo.toFixed(1).padStart(5)} °C`,
    );
  }

  const r = pearson(
    cells.map((c) => c.obsPrecip),
    cells.map((c) => c.err),
    cells.map((c) => c.w),
  );
  const rLog = pearson(
    cells.map((c) => Math.log1p(c.obsPrecip)),
    cells.map((c) => c.err),
    cells.map((c) => c.w),
  );
  console.log(`\n面積重み付き相関 r(降水, 年較差の誤差) = ${r.toFixed(3)}`);
  console.log(`                 r(log 降水, 同)        = ${rLog.toFixed(3)}`);

  // 緯度の交絡を外す: 高緯度ほど湿っている/乾いているという偏りがあると
  // 「湿り具合の効果」に見えてしまう。緯度帯の中だけで相関を取り直す
  console.log('\n緯度帯ごとの相関(緯度の交絡を外す)');
  for (const [lo, hi] of [
    [-90, -30],
    [-30, 0],
    [0, 30],
    [30, 50],
    [50, 90],
  ] as const) {
    const g = cells.filter((c) => c.lat >= lo && c.lat < hi);
    if (g.length < 20) continue;
    const rr = pearson(
      g.map((c) => Math.log1p(c.obsPrecip)),
      g.map((c) => c.err),
      g.map((c) => c.w),
    );
    console.log(`  ${String(lo).padStart(4)}〜${String(hi).padStart(3)}°   n=${String(g.length).padStart(4)}   r=${rr.toFixed(3)}`);
  }

  // ---- 年較差の誤差を「夏のズレ」と「冬のズレ」へ分解 ----
  // 同じ「年較差が大きすぎる」でも、夏が暑すぎるのか冬が寒すぎるのかで
  // 直す場所が変わる。ここを見ないまま熱容量をいじると当てずっぽうになる
  const table = (
    title: string,
    groups: Array<[string, Cell[]]>,
  ): void => {
    console.log(`\n${title}`);
    console.log('                 n     最暖月のズレ   最寒月のズレ   年較差の誤差');
    for (const [name, g] of groups) {
      if (g.length < 20) continue;
      const sw = g.reduce((a, c) => a + c.w, 0);
      const wb = g.reduce((a, c) => a + c.w * c.warmBias, 0) / sw;
      const cb = g.reduce((a, c) => a + c.w * c.coldBias, 0) / sw;
      const er = g.reduce((a, c) => a + c.w * c.err, 0) / sw;
      const f = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`.padStart(7);
      console.log(
        `  ${name.padEnd(12)} ${String(g.length).padStart(5)}    ${f(wb)} °C     ${f(cb)} °C     ${f(er)} °C`,
      );
    }
  };

  table(
    '湿り具合ごとの季節分解',
    names.map((nm, b) => [
      nm,
      cells.filter((c) => c.obsPrecip >= bins[b]! && c.obsPrecip < bins[b + 1]!),
    ]),
  );
  table(
    '緯度帯ごとの季節分解',
    ([
      [-90, -30],
      [-30, 0],
      [0, 30],
      [30, 50],
      [50, 90],
    ] as const).map(([lo, hi]) => [
      `${lo}〜${hi}°`,
      cells.filter((c) => c.lat >= lo && c.lat < hi),
    ]),
  );
  // 中緯度の半乾燥内陸(誤差が最大の層)だけを取り出す
  table('誤差が最大の層(30〜60°N かつ 250〜800mm)', [
    [
      '中緯度半乾燥',
      cells.filter((c) => c.lat >= 30 && c.lat < 60 && c.obsPrecip >= 250 && c.obsPrecip < 800),
    ],
  ]);

  fs.mkdirSync('out/compare', { recursive: true });
  fs.writeFileSync('out/compare/range_cells.json', JSON.stringify(cells));
  console.log('\nセル別の値を out/compare/range_cells.json に保存(再実行なしで追加解析できる)');
}

void main();
