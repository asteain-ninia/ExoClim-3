// 診断: モデルの降水は**平されすぎていないか**。
//
// 2026-08-13(段 18)で、同じモデルの中に相反する 2 つの誤りがあると分かった:
//   サハラ    観測の 4.74 倍（水が来すぎている）
//   east_asia 観測の 0.17 倍（水が来ない）
// 陸平均は 722 対 観測 794 で、**全体量は足りている**。
// つまり量ではなく**配り方**の誤りで、しかも「乾いた所が湿り、湿った所が乾く」
// = **分布が圧縮されている**という 1 つの症状として書ける可能性がある。
//
// 分布そのものを見れば分かる。**平されているなら、モデルの分位が観測より
// 中央へ寄る**(下位分位が高く、上位分位が低い)。
//
// ---- 訂正(2026-08-15): 初版は面積の重みを外していた ----
//
// この道具の初版は分位も対数標準偏差も**セル数**で採っており、
// 「モデルの散らばりは観測の 1.8 倍。圧縮ではなく過剰な広がり」と結論した
// (docs/診断_降水の分布_2026-08-13.md)。**その結論は成り立たない。**
//
// 1° 格子では**南極が陸セルの 28.3% を占めるが、面積では 9.5%** しかない
// (極はセルが小さいのに数が多い)。重み無しの分位は南極が買い占める。
// しかも南極は観測もモデルも一律 EF なので、降水が 30 倍外れても成績に出ない。
//
//   対数標準偏差       モデル   観測
//   重み無し・南極込み  1.052   0.586   ← 初版の結論
//   面積重み・南極込み  0.709   0.560
//   面積重み・南極を除く 0.429  0.530   ← **逆転する**
//
// **正しく測ると、初版が「外れた」と書いた当初の仮説(中央へ圧縮されている)
// のほうが当たっていた。** 詳細は docs/診断_乾いた端が作れない_2026-08-15.md。
//
// そこで 3 通りすべてを並べて出す。**重み無しの数字を単独で読まないこと。**
//
// 実行: npx tsx scripts/diag_precip_distribution.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow } from '../src/domain/grid';
import { getClimObs } from './scoring';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

async function main(): Promise<void> {
  const accel = await openAccel(true);
  let r: PipelineResult;
  try {
    r = await runPipeline(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }
  const grid = r.context.grid;
  const W = grid.widthCells;
  const clim = getClimObs();

  /** 陸セルの（モデル年降水, 観測年降水, 面積重み, 緯度） */
  const rows: Array<[number, number, number, number]> = [];
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    const cw = Math.cos((lat * Math.PI) / 180);
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      if (!r.context.terrain.landMask[i]) continue;
      const cr = Math.min(clim.heightCells - 1, Math.round((row / grid.heightCells) * clim.heightCells));
      const cc = Math.min(clim.widthCells - 1, Math.round((col / grid.widthCells) * clim.widthCells));
      const ci = cr * clim.widthCells + cc;
      let o = 0;
      let bad = false;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        const v = clim.monthlyPrecipitationMm[m]?.[ci];
        if (v === undefined || v <= -9000) {
          bad = true;
          break;
        }
        o += v;
      }
      if (bad) continue;
      let p = 0;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) p += r.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;
      rows.push([p, o, cw, lat]);
    }
  }

  /** 面積重みつき分位。重みを 1 にすればセル数の分位になる */
  const q = (pairs: Array<[number, number]>, p: number): number => {
    const a = [...pairs].sort((x, y) => x[0] - y[0]);
    const total = a.reduce((s, [, w]) => s + w, 0);
    let acc = 0;
    for (const [v, w] of a) {
      acc += w;
      if (acc >= p * total) return v;
    }
    return a[a.length - 1]?.[0] ?? 0;
  };
  /** 面積重みつき対数標準偏差(降水は桁で散る量なので対数で見る) */
  const lstd = (pairs: Array<[number, number]>): number => {
    const ws = pairs.reduce((s, [, w]) => s + w, 0);
    let m = 0;
    for (const [v, w] of pairs) m += w * Math.log10(Math.max(1, v));
    m /= ws;
    let s = 0;
    for (const [v, w] of pairs) {
      const d = Math.log10(Math.max(1, v)) - m;
      s += w * d * d;
    }
    return Math.sqrt(s / ws);
  };

  const wsum = rows.reduce((a, b) => a + b[2], 0);
  const wmean = (f: (x: [number, number, number, number]) => number): number =>
    rows.reduce((a, b) => a + b[2] * f(b), 0) / wsum;

  console.log(`陸セル ${rows.length}（観測が欠損でないもの）`);
  console.log(
    `面積重み平均   モデル ${wmean((x) => x[0]).toFixed(0)} / 観測 ${wmean((x) => x[1]).toFixed(0)} mm/年`,
  );

  // 3 通りの集計を並べる。**重み無しの数字を単独で読まないこと**(冒頭の訂正)
  const noAq = rows.filter((x) => x[3] > -60);
  const views: Array<[string, Array<[number, number, number, number]>, boolean]> = [
    ['① 重み無し・南極込み（2026-08-13 の初版。**読むな**）', rows, false],
    ['② 面積重み・南極込み', rows, true],
    ['③ 面積重み・南極(60S 以南)を除く ← **判断はこれで**', noAq, true],
  ];
  for (const [label, set, weighted] of views) {
    const model: Array<[number, number]> = set.map((x) => [x[0], weighted ? x[2] : 1]);
    const obs: Array<[number, number]> = set.map((x) => [x[1], weighted ? x[2] : 1]);
    console.log(`\n${label}   セル ${set.length}`);
    console.log('分位     モデル    観測    モデル/観測');
    for (const p of [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99]) {
      const mv = q(model, p);
      const ov = q(obs, p);
      console.log(
        `${(p * 100).toFixed(0).padStart(3)}%  ${mv.toFixed(0).padStart(8)} ${ov.toFixed(0).padStart(7)}` +
          `   ${(mv / Math.max(1, ov)).toFixed(2).padStart(8)}`,
      );
    }
    console.log(`対数標準偏差   モデル ${lstd(model).toFixed(3)} / 観測 ${lstd(obs).toFixed(3)}`);
  }
  console.log(
    '\n読み: 下位分位でモデル/観測が 1 を大きく超え、上位分位で 1 を下回るなら\n' +
      '  **分布が中央へ圧縮されている**（乾いた所が湿り、湿った所が乾く）。\n' +
      '  対数標準偏差がモデル < 観測なら、同じことを 1 つの数で言える。\n' +
      '  ①と③で符号が逆になるので、**どの集計で見ているかを必ず書くこと。**',
  );
}

void main();
