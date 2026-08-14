// 診断: **中位の陸(25〜75% 分位)はどこで、そこで何が足りないのか。**
//
// なぜ要るか(2026-08-15):
//   今日 5 つの機構を測って、**すべて中位の陸を痩せさせた**。
//     段19 滞留時間 / 段22 virga / 段25 CRH  → λG の平均を下げる → 中位が下がる
//     段27 地形性上昇の基準勾配              → 上げる → 中位が下がる
//     段28 その正規化                        → 平均を保っても中位が下がる
//
//   段 28 で「λ·G の面積平均」という共通原因の読みが**誤り**と分かった
//   (liftOro の面積平均はもともとほぼ 1 で、正規化しても何も起きなかった)。
//
//   残る説明は **「どこで消費されるか」** である:
//     段 27 は水が山地で消費され、下流の内陸へ届かない
//     段 22・25 は乾燥域で止めた水が**中位を通り過ぎて**湿潤域で降る
//   機構は逆向きなのに、どちらも中位の陸が「素通りされる」。
//
//   **中位の陸は水の通り道であり、そこで凝結を選択的に強めない限り湿らない。**
//   ならば「そこで何の因子が足りないのか」を数えるところから立て直す。
//
// 何を出すか:
//   1. 中位の陸(モデルの年降水が 25〜75% 分位)がどこか — 緯度・気温・海岸距離・
//      ケッペン大分類の内訳。**見当で書かないため。**
//   2. そこの G の因子分解(持上げ各種・沈降残存・遮蔽・CRH)を、
//      湿潤側(上位 25%)・乾燥側(下位 25%)と**並べて**出す。
//      **どの因子が中位で低いのか**が処方を決める。
//   3. 水収支(供給・凝結・正味流入)を同じ 3 群で並べる。
//      「水が来ていない」のか「来ているが降らない」のかを分ける。
//
// 実行: npx tsx scripts/diag_middle_band.ts

import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow } from '../src/domain/grid';
import { getClimObs } from './scoring';
import { openAccel } from './accel_cli';

/** 面積重みつき分位 */
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

function wmean(vals: number[], wts: number[]): number {
  let s = 0;
  let w = 0;
  for (let i = 0; i < vals.length; i++) {
    s += (wts[i] ?? 0) * (vals[i] ?? 0);
    w += wts[i] ?? 0;
  }
  return s / Math.max(1e-9, w);
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
  const WC = grid.widthCells;
  const land = r.context.terrain.landMask;
  const coastKm = r.context.landDistToCoastKm;
  const clim = getClimObs();

  interface Cell {
    i: number;
    w: number;
    lat: number;
    t: number;
    coast: number;
    p: number;
    obs: number;
    /** 年平均の因子(G の内訳) */
    block: number;
    itcz: number;
    frontal: number;
    conv: number;
    oro: number;
    subs: number;
    other: number;
    crh: number;
    g: number;
    /** 年の供給・蒸発散 */
    supply: number;
    et: number;
    water: number;
  }

  const cells: Cell[] = [];
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    // **南極は除く。** 観測もモデルも一律 EF で、面積の 9.5% だがセルの 28.3%
    if (lat <= -60) continue;
    const cw = Math.cos((lat * Math.PI) / 180);
    const cr = Math.min(clim.heightCells - 1, Math.round((row / grid.heightCells) * clim.heightCells));
    for (let col = 0; col < WC; col++) {
      const i = row * WC + col;
      if (!land[i]) continue;
      const cc = Math.min(clim.widthCells - 1, Math.round((col / grid.widthCells) * clim.widthCells));
      const ci = cr * clim.widthCells + cc;
      let obs = 0;
      let bad = false;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        const v = clim.monthlyPrecipitationMm[m]?.[ci];
        if (v === undefined || v <= -9000) {
          bad = true;
          break;
        }
        obs += v;
      }
      if (bad) continue;
      const acc = {
        p: 0, t: 0, block: 0, itcz: 0, frontal: 0, conv: 0, oro: 0,
        subs: 0, other: 0, crh: 0, g: 0, supply: 0, et: 0, water: 0,
      };
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        acc.p += r.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;
        acc.t += r.temperature.monthlyTemperatureC[m]?.[i] ?? 0;
        acc.block += d.upwindBlock[m]?.[i] ?? 1;
        acc.itcz += d.liftItcz[m]?.[i] ?? 1;
        acc.frontal += d.liftFrontal[m]?.[i] ?? 1;
        acc.conv += d.liftConvergence[m]?.[i] ?? 1;
        acc.oro += d.liftOrographic[m]?.[i] ?? 1;
        acc.subs += d.subsidenceResidual[m]?.[i] ?? 1;
        acc.other += d.liftOther[m]?.[i] ?? 1;
        acc.crh += d.crhSuppression[m]?.[i] ?? 1;
        acc.g += d.condRateG[m]?.[i] ?? 0;
        acc.supply +=
          (d.supplyOcean[m]?.[i] ?? 0) + (d.supplyLand[m]?.[i] ?? 0) + (d.supplyStorm[m]?.[i] ?? 0);
        acc.et += r.precipitation.land?.monthlyEtMm?.[m]?.[i] ?? 0;
        acc.water += d.waterMm[m]?.[i] ?? 0;
      }
      const M = MONTHS_PER_YEAR;
      cells.push({
        i, w: cw, lat, t: acc.t / M, coast: coastKm[i] ?? 0, p: acc.p, obs,
        block: acc.block / M, itcz: acc.itcz / M, frontal: acc.frontal / M,
        conv: acc.conv / M, oro: acc.oro / M, subs: acc.subs / M,
        other: acc.other / M, crh: acc.crh / M, g: acc.g / M,
        supply: acc.supply, et: acc.et, water: acc.water / M,
      });
    }
  }

  // 面積重みつきの分位でモデル降水を 3 群に割る
  const pairs = cells.map((c) => [c.p, c.w] as [number, number]);
  const q25 = wquantile(pairs, 0.25);
  const q75 = wquantile(pairs, 0.75);
  const dry = cells.filter((c) => c.p < q25);
  const mid = cells.filter((c) => c.p >= q25 && c.p <= q75);
  const wet = cells.filter((c) => c.p > q75);

  console.log(`陸セル ${cells.length}（南極 60S 以南を除く、観測が欠損でないもの）`);
  console.log(`面積重み分位で 3 群に割る: 25% = ${q25.toFixed(0)} / 75% = ${q75.toFixed(0)} mm/年\n`);

  const groups: Array<[string, Cell[]]> = [
    ['乾いた側 (下位25%)', dry],
    ['**中位 (25〜75%)**', mid],
    ['湿った側 (上位25%)', wet],
  ];

  console.log('【1】3 群はどこか');
  console.log('群                    セル数  面積%  年降水 モデル/観測  中央緯度 気温  海岸km');
  const totalW = cells.reduce((a, c) => a + c.w, 0);
  for (const [name, g] of groups) {
    const gw = g.reduce((a, c) => a + c.w, 0);
    const ws = g.map((c) => c.w);
    console.log(
      `${name.padEnd(22)} ${String(g.length).padStart(5)} ${((100 * gw) / totalW).toFixed(1).padStart(6)}` +
        `  ${wmean(g.map((c) => c.p), ws).toFixed(0).padStart(5)}/${wmean(g.map((c) => c.obs), ws).toFixed(0).padStart(5)}` +
        `  ${(wmean(g.map((c) => c.p), ws) / Math.max(1, wmean(g.map((c) => c.obs), ws))).toFixed(2)}` +
        `  ${wmean(g.map((c) => c.lat), ws).toFixed(0).padStart(6)}° ${wmean(g.map((c) => c.t), ws).toFixed(1).padStart(5)}°C` +
        ` ${wmean(g.map((c) => c.coast), ws).toFixed(0).padStart(6)}`,
    );
  }

  console.log('\n【2】G の因子分解（年平均、面積重み）— **中位で何が足りないか**');
  const factors: Array<[string, (c: Cell) => number]> = [
    ['風上遮蔽 upwindBlock', (c) => c.block],
    ['ITCZ 持上げ', (c) => c.itcz],
    ['前線 持上げ', (c) => c.frontal],
    ['収束 持上げ', (c) => c.conv],
    ['地形性 持上げ', (c) => c.oro],
    ['沈降残存', (c) => c.subs],
    ['その他(ストーム/寒流/高温湿潤)', (c) => c.other],
    ['CRH 抑制', (c) => c.crh],
    ['—— 実効 G', (c) => c.g],
  ];
  console.log('因子                            乾いた側    **中位**   湿った側   中位/湿');
  for (const [name, f] of factors) {
    const vd = wmean(dry.map(f), dry.map((c) => c.w));
    const vm = wmean(mid.map(f), mid.map((c) => c.w));
    const vw = wmean(wet.map(f), wet.map((c) => c.w));
    console.log(
      `${name.padEnd(30)} ${vd.toFixed(3).padStart(8)} ${vm.toFixed(3).padStart(9)} ${vw.toFixed(3).padStart(9)}` +
        `  ${(vm / Math.max(1e-9, vw)).toFixed(2).padStart(6)}`,
    );
  }

  console.log('\n【3】水収支（年、面積重み）— 「来ていない」のか「降らない」のか');
  const budget: Array<[string, (c: Cell) => number]> = [
    ['可降水量 W (mm)', (c) => c.water],
    ['供給場(無次元)', (c) => c.supply],
    ['陸面蒸発散 E (mm/年)', (c) => c.et],
    ['降水 P (mm/年)', (c) => c.p],
    ['正味流入 P−E (mm/年)', (c) => c.p - c.et],
  ];
  console.log('量                              乾いた側    **中位**   湿った側');
  for (const [name, f] of budget) {
    console.log(
      `${name.padEnd(30)} ${wmean(dry.map(f), dry.map((c) => c.w)).toFixed(2).padStart(8)}` +
        ` ${wmean(mid.map(f), mid.map((c) => c.w)).toFixed(2).padStart(9)}` +
        ` ${wmean(wet.map(f), wet.map((c) => c.w)).toFixed(2).padStart(9)}`,
    );
  }

  console.log(
    '\n読み: 【2】で中位/湿の比が小さい因子が「中位で足りていない」もの。\n' +
      '  【3】で中位の W が湿った側と同程度なら「水は来ているが降らない」、\n' +
      '  小さければ「そもそも来ていない」。処方が分かれる。',
  );
}

void main();
