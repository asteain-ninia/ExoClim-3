// 診断: **水蒸気の滞留時間 τ = W / P の分布(位相の本丸、台帳 項目 1)。**
//
// なぜ要るか: 実物の大気の水蒸気滞留時間は約 9 日(可降水量 25mm / 降水 2.7mm 日)。
// モデルは全球平均 1.9 日と測られており(2026-08-15)、これが
//   ・中緯度の冬雨(W が夏に偏り G の冬振幅に勝てない)
//   ・亜熱帯の冬雨(G を立てても W が夏のまま)
//   ・降水分布の両端が潰れる
// のすべてに効いている。**まず τ がどこでどれだけ短いかを場として見る。**
//
// τ = W / (λ·G·W) = 1/rate なので、rate の分布そのものが滞留時間の逆数。
// ここでは実際に解いた W と凝結量から τ = W/C を出し(月・帯・海陸で分ける)、
// 観測(可降水量 25mm・降水 2.7mm/日 相当)と比べる。
// 実行: npx tsx scripts/diag_residence_time.ts
import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { latDegOfRow } from '../src/domain/grid';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { openAccel } from './accel_cli';

const K = MODEL_CONSTANTS as unknown as Record<string, number>;
if (process.env['DIAG_OVERRIDE']) {
  for (const part of process.env['DIAG_OVERRIDE'].split(',')) {
    const [n, v] = part.split('=');
    if (n && n.trim() in K) { K[n.trim()] = Number(v); console.log(`[上書き] ${n.trim()} = ${v}`); }
  }
}
const DAYS_PER_MONTH = 30.44;

async function main(): Promise<void> {
  const accel = await openAccel(true);
  let out;
  try { out = await runPipelineWithPrecipDiag(EARTH_PARAMS, accel.opts); } finally { accel.close(); }
  const r = out.result;
  const d = out.precipDiag;
  if (!d.waterMm.length) throw new Error('保存型でない(waterMm が空)');
  const grid = r.context.grid;
  const W = grid.widthCells;
  const land = r.context.terrain.landMask;

  const BANDS: Array<[string, number, number]> = [
    ['熱帯 0〜15', 0, 15], ['亜熱帯 15〜35', 15, 35], ['中緯度 35〜60', 35, 60], ['高緯度 60〜90', 60, 91],
  ];
  // [帯][海陸] の τ(面積重み平均)と W・P
  const acc = BANDS.map(() => [0, 1].map(() => ({ w: 0, tau: 0, water: 0, precip: 0 })));
  // 全球の月別 τ(季節変化を見る)
  const monthly = new Array(12).fill(0).map(() => ({ w: 0, tau: 0, water: 0 }));

  for (let m = 0; m < 12; m++) {
    const wat = d.waterMm[m];
    const pre = r.precipitation.monthlyPrecipMm[m];
    if (!wat || !pre) continue;
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = latDegOfRow(grid, row);
      const aLat = Math.abs(lat);
      const bi = BANDS.findIndex(([, lo, hi]) => aLat >= lo && aLat < hi);
      const cw = Math.cos((lat * Math.PI) / 180);
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        const wv = wat[i] ?? 0;
        const pv = pre[i] ?? 0;
        if (!(wv > 0) || !(pv > 0.01)) continue;
        // τ(日) = W(mm) / (P(mm/月) / 30.44 日)
        const tau = wv / (pv / DAYS_PER_MONTH);
        const li = land[i] ? 1 : 0;
        if (bi >= 0) {
          const a = acc[bi]![li]!;
          a.w += cw; a.tau += cw * tau; a.water += cw * wv; a.precip += cw * pv;
        }
        const mm = monthly[m]!;
        mm.w += cw; mm.tau += cw * tau; mm.water += cw * wv;
      }
    }
  }
  console.log('水蒸気の滞留時間 τ = W / P(日)。実物の全球平均 ≈ 9 日\n');
  console.log('帯                 海: τ(日)  W(mm)  P(mm/月) | 陸: τ(日)  W(mm)  P(mm/月)');
  for (let bi = 0; bi < BANDS.length; bi++) {
    const o = acc[bi]![0]!, l = acc[bi]![1]!;
    const f = (a: typeof o, k: 'tau' | 'water' | 'precip'): string =>
      (a.w > 0 ? a[k] / a.w : 0).toFixed(k === 'tau' ? 2 : 1).padStart(7);
    console.log(`${BANDS[bi]![0].padEnd(16)} ${f(o,'tau')} ${f(o,'water')} ${f(o,'precip')} |${f(l,'tau')} ${f(l,'water')} ${f(l,'precip')}`);
  }
  console.log('\n月別の全球 τ と W(季節性 — 冬に水が残るか)');
  console.log('月    ' + monthly.map((_, m) => String(m + 1).padStart(6)).join(''));
  console.log('τ(日)' + monthly.map((a) => (a.w > 0 ? a.tau / a.w : 0).toFixed(2).padStart(6)).join(''));
  console.log('W(mm)' + monthly.map((a) => (a.w > 0 ? a.water / a.w : 0).toFixed(1).padStart(6)).join(''));
  console.log(
    '\n読み: τ が実物(9 日)より短い = 大気が水をためずに即座に降らせている。' +
      '\n  τ が冬に短いほど「冬に水が残らない」= 冬雨機構が効かない構造。',
  );
}
void main();
