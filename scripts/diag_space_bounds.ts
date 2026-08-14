// 診断: **較正が探索空間の端に張り付いている定数はどれか。**
//
// なぜ要るか(2026-08-15):
//   `moistureEddyDiffusivityM2PerS` を調べていて、現行値 2.98e6 が
//   探索範囲 [5e5, 3e6] の**上端 99.2%** にあることに気づいた。
//   渦拡散は拡散長 sqrt(D/λG) を通じて **W の下限**を決めており、
//   その下限が「本当に乾いた場所を作れない」ことの直接の原因である
//   (docs/診断_乾いた端が作れない_2026-08-15.md)。
//
//   **端に張り付いた定数は、目的関数が「もっと欲しい」と言っている印**である。
//   同時に、その方向が物理的に妥当かは誰も確かめていない。
//   探索範囲は人が決めた数であって、物理が決めた数ではない。
//
//   これは既知の型でもある — 隠しパラメータ(計算に効くのに仕様書にも UI にも
//   無い量)を 3 件踏んでいる(docs/教訓.md)。**範囲の端は、隠れた上限が
//   答えを決めている状態**であり、同じ型に属する。
//
// 実行: npx tsx scripts/diag_space_bounds.ts

import { MODEL_CONSTANTS } from '../src/sim/constants';
import { SPACE } from './optimize_lib';

const K = MODEL_CONSTANTS as unknown as Record<string, number>;

interface Row {
  name: string;
  lo: number;
  hi: number;
  v: number;
  /** 範囲内の位置 0〜1 */
  pos: number;
}

const rows: Row[] = [];
for (const [name, lo, hi] of SPACE) {
  const v = K[name];
  if (v === undefined) {
    console.log(`  ⚠ 探索空間にあるが定数に無い: ${name}`);
    continue;
  }
  rows.push({ name, lo, hi, v, pos: (v - lo) / Math.max(1e-30, hi - lo) });
}

rows.sort((a, b) => Math.min(a.pos, 1 - a.pos) - Math.min(b.pos, 1 - b.pos));

console.log(`探索空間の定数 ${rows.length} 件を、範囲の端への近さで並べる。\n`);
console.log('位置    定数                                  下端        現行値        上端');
let atEdge = 0;
for (const r of rows) {
  const edge = Math.min(r.pos, 1 - r.pos);
  const mark = edge < 0.02 ? ' ←← 端' : edge < 0.05 ? ' ← 端に近い' : '';
  if (edge < 0.05) atEdge++;
  console.log(
    `${(100 * r.pos).toFixed(1).padStart(5)}%  ${r.name.padEnd(34)}` +
      `${r.lo.toExponential(2).padStart(10)}  ${r.v.toExponential(4).padStart(12)}  ${r.hi.toExponential(2).padStart(10)}${mark}`,
  );
}
console.log(
  `\n端(範囲の 5% 以内)にある定数: ${atEdge} / ${rows.length} 件\n\n` +
    '読み: 端に張り付いた定数は、目的関数が「範囲の外へ行きたい」と言っている。\n' +
    '  そこで問うのは 2 つ — (a) 範囲の外は物理的に妥当か、\n' +
    '  (b) その定数が**別の欠陥を補償している**のではないか。\n' +
    '  補償なら範囲を広げても直らず、補償される側の欠陥が残るだけである。',
);
