// 診断: 保存型の `P = λ·G·W` で、**降水の散らばりを実際に作っているのは
// どちらか**(凝結率 G か、可降水量 W か)。
//
// なぜ要るか(2026-08-15):
//   2026-08-13 に同じ日付で、互いに噛み合わない 2 つの文書が書かれている。
//
//   [考察_凝結率の意味]  「モデルの G は 3.8 倍しか動かないのに実物の降水は
//                        57 倍動く。**G の幅が 2 桁足りない**」
//   [診断_降水の分布]    「モデルの年降水の対数標準偏差は 1.052、観測は 0.586。
//                        **モデルの散らばりは観測の 1.8 倍**ある」
//
//   前者は「幅が足りない」、後者は「幅が有り余っている」と言っている。
//   どちらかが誤っているか、**別のものを測っている**。
//
//   実際、前者の「3.8 倍」は**地域ゲート 7 点の平均**から出した数字である
//   (congo/india/west/antarctica/us/east/tibet)。7 点の平均の最大最小は
//   全セルの分布の幅ではない。前世代が繰り返した
//   「不完全な走査から断定する」型([docs/教訓.md])に当てはまる疑いがある。
//
//   **処方(G の幅を作る)は、この読みの上に立っている。** 段 20 の CRH 指数抑制も
//   「幅が 2 桁足りない」を前提に選ばれた手だった。前提が違えば手も違う。
//   だから測る。
//
// 何を出すか:
//   1. 全陸セルでの G・W・P の分布(分位と対数標準偏差)。
//      7 点平均の 3.8 倍が全セルでいくつになるかを直接見る。
//   2. **分散分解**。log P = log λ + log G + log W なので
//      Var(log P) = Var(log G) + Var(log W) + 2 Cov(log G, log W)。
//      散らばりを担っているのが G か W かはこれで決まる。
//   3. 観測に合わせるのに要る G の補正 `G_req/G = P_obs/P`(W を固定した一次の見積り)。
//      その対数標準偏差が「G の幅がどれだけ足りない / 余っている」の答え。
//   4. 補正の向きが、既存のどの倍率と相関しているか。
//      **既にある変数で足りるなら新しい機構は要らない。**
//
// 一次の見積りである点は動かない: G を変えれば W も動く(G は W を決める
// 方程式の係数)。したがって 3・4 は**場の形**を読むためのもので、
// 「この倍率を掛ければ観測になる」という意味ではない。
//
// 実行: npx tsx scripts/diag_condensation_width.ts

import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow, lonDegOfCol } from '../src/domain/grid';
import { getClimObs, REGION_GATES } from './scoring';
import { SECONDS_PER_MONTH } from '../src/sim/moisture_transport';
import { openAccel } from './accel_cli';

const K = MODEL_CONSTANTS as unknown as Record<string, number>;

/**
 * **面積重みつき分位。** 値と重みの組を渡す(並べ替えは内部で行う)。
 * 重み無しで採ると 1° 格子では極のセル数が過大に効く
 * (南極は陸セルの 28.3% だが面積では 9.5%)。
 */
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

/** 対数標準偏差(底 10)。0 以下は floor で潰す */
function logStd(vals: number[], floor: number): number {
  const l = vals.map((v) => Math.log10(Math.max(floor, v)));
  const m = l.reduce((a, b) => a + b, 0) / l.length;
  return Math.sqrt(l.reduce((a, b) => a + (b - m) * (b - m), 0) / l.length);
}

function logVals(vals: number[], floor: number): number[] {
  return vals.map((v) => Math.log10(Math.max(floor, v)));
}

/**
 * 分散・共分散・相関は**面積重みつき**で採る。
 *
 * **重みを外すと極が支配する(2026-08-15 に実害)。** 1° 格子では南極が
 * 陸セルの 28.3% を占めるが、面積では 9.5% でしかない。重み無しで測ると
 * 「陸の下位 25% が壊滅的に乾いている」という結論が出るが、
 * その正体はほぼ南極のセル数である
 * (docs/診断_降水の分布_2026-08-13.md も重み無しで、同じ偏りを持つ)。
 * 比較のため重み無しも併記する。
 */
function variance(l: number[], w?: number[]): number {
  if (!w) {
    const m = l.reduce((a, b) => a + b, 0) / l.length;
    return l.reduce((a, b) => a + (b - m) * (b - m), 0) / l.length;
  }
  const ws = w.reduce((a, b) => a + b, 0);
  let m = 0;
  for (let i = 0; i < l.length; i++) m += (w[i] ?? 0) * (l[i] ?? 0);
  m /= ws;
  let s = 0;
  for (let i = 0; i < l.length; i++) s += (w[i] ?? 0) * ((l[i] ?? 0) - m) * ((l[i] ?? 0) - m);
  return s / ws;
}

function covariance(a: number[], b: number[], w?: number[]): number {
  const ws = w ? w.reduce((x, y) => x + y, 0) : a.length;
  const wi = (i: number): number => (w ? (w[i] ?? 0) : 1);
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    ma += wi(i) * (a[i] ?? 0);
    mb += wi(i) * (b[i] ?? 0);
  }
  ma /= ws;
  mb /= ws;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += wi(i) * ((a[i] ?? 0) - ma) * ((b[i] ?? 0) - mb);
  return s / ws;
}

function correlation(a: number[], b: number[], w?: number[]): number {
  const va = variance(a, w);
  const vb = variance(b, w);
  if (va <= 0 || vb <= 0) return 0;
  return covariance(a, b, w) / Math.sqrt(va * vb);
}

async function main(): Promise<void> {
  if (K['conservativeMoisture'] === 0) {
    console.log('保存型が無効(conservativeMoisture = 0)。この診断は保存型でのみ意味を持つ。');
    return;
  }
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

  if (d.waterMm.length === 0 || d.condRateG.length === 0) {
    console.log('W / G の診断が空。保存型で走っているか確認すること。');
    return;
  }

  /** λ(セルごと。陸と海で距離が違う) */
  const travelKmPerMonth = ((K['condensationRefWindMs'] ?? 0) * SECONDS_PER_MONTH) / 1000;
  const lambdaOf = (i: number): number =>
    travelKmPerMonth / Math.max(1, land[i] ? (K['moistureDecayLandKm'] ?? 1) : (K['moistureDecayOceanKm'] ?? 1));

  interface Cell {
    i: number;
    /** 面積重み */
    w: number;
    /** モデル年降水 mm/年 */
    p: number;
    /** 観測年降水 mm/年 */
    obs: number;
    /** 年平均 W mm */
    water: number;
    /**
     * **実効の G**。P = λ·G·W を年で閉じる形、つまり
     * G_eff = Σ_m P_m / (λ · Σ_m W_m)。月ごとの G の単純平均ではない
     * (降水が出ていない月の G は降水に効いていないので、平均に入れると
     *  幅を過小評価する)
     */
    g: number;
    /** 既存の倍率(年平均) */
    subs: number;
    block: number;
    crh: number;
    lifts: number;
  }

  const cells: Cell[] = [];
  for (let row = 0; row < grid.heightCells; row++) {
    const cw = Math.cos((latDegOfRow(grid, row) * Math.PI) / 180);
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

      let pre = 0;
      let water = 0;
      let subs = 0;
      let block = 0;
      let crh = 0;
      let lifts = 0;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        pre += d.preAdjustMm[m]?.[i] ?? 0;
        water += d.waterMm[m]?.[i] ?? 0;
        subs += d.subsidenceResidual[m]?.[i] ?? 1;
        block += d.upwindBlock[m]?.[i] ?? 1;
        crh += d.crhSuppression[m]?.[i] ?? 1;
        lifts +=
          (d.liftItcz[m]?.[i] ?? 1) *
          (d.liftFrontal[m]?.[i] ?? 1) *
          (d.liftConvergence[m]?.[i] ?? 1) *
          (d.liftOrographic[m]?.[i] ?? 1) *
          (d.liftOther[m]?.[i] ?? 1);
      }
      const waterAnnual = water / MONTHS_PER_YEAR;
      // 実効 G: 年凝結量 / (λ × 年の W の総和)。W の総和 = 年平均 × 12
      const g = pre / Math.max(1e-9, lambdaOf(i) * water);
      let p = 0;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) p += r.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;
      cells.push({
        i,
        w: cw,
        p,
        obs,
        water: waterAnnual,
        g,
        subs: subs / MONTHS_PER_YEAR,
        block: block / MONTHS_PER_YEAR,
        crh: crh / MONTHS_PER_YEAR,
        lifts: lifts / MONTHS_PER_YEAR,
      });
    }
  }

  const wsum = cells.reduce((a, c) => a + c.w, 0);
  const wmean = (f: (c: Cell) => number): number =>
    cells.reduce((a, c) => a + c.w * f(c), 0) / wsum;

  console.log(`陸セル ${cells.length}（観測が欠損でないもの）`);
  console.log(
    `面積重み平均   降水 モデル ${wmean((c) => c.p).toFixed(0)} / 観測 ${wmean((c) => c.obs).toFixed(0)} mm/年` +
      `   W ${wmean((c) => c.water).toFixed(2)} mm   実効 G ${wmean((c) => c.g).toFixed(3)}`,
  );

  // ---- 1. 分布(面積重みつき)----
  const pg = cells.map((c) => [c.g, c.w] as [number, number]);
  const pw = cells.map((c) => [c.water, c.w] as [number, number]);
  const pp = cells.map((c) => [c.p, c.w] as [number, number]);
  const po = cells.map((c) => [c.obs, c.w] as [number, number]);
  console.log('\n【1】全陸セルの分布（**面積重みつき**分位）');
  console.log('分位      実効G        W(mm)     降水モデル   降水観測');
  for (const q of [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99]) {
    console.log(
      `${(q * 100).toFixed(0).padStart(3)}%  ${wquantile(pg, q).toExponential(3).padStart(11)}` +
        `  ${wquantile(pw, q).toFixed(3).padStart(10)}` +
        `  ${wquantile(pp, q).toFixed(0).padStart(9)}` +
        `  ${wquantile(po, q).toFixed(0).padStart(9)}`,
    );
  }
  const g99 = wquantile(pg, 0.99);
  const g01 = wquantile(pg, 0.01);
  console.log(
    `\n実効 G の 1〜99% 幅   ${(g99 / Math.max(1e-12, g01)).toFixed(1)} 倍` +
      `     W の 1〜99% 幅  ${(wquantile(pw, 0.99) / Math.max(1e-12, wquantile(pw, 0.01))).toFixed(1)} 倍`,
  );
  const awAll = cells.map((c) => c.w);
  const lstdW = (f: (c: Cell) => number, floor: number): string =>
    Math.sqrt(variance(logVals(cells.map(f), floor), awAll)).toFixed(3);
  console.log(
    `対数標準偏差(面積重み)   実効G ${lstdW((c) => c.g, 1e-9)}` +
      `   W ${lstdW((c) => c.water, 1e-6)}` +
      `   降水モデル ${lstdW((c) => c.p, 1)}` +
      `   降水観測 ${lstdW((c) => c.obs, 1)}`,
  );
  console.log(
    `対数標準偏差(重み無し)   実効G ${logStd(cells.map((c) => c.g), 1e-9).toFixed(3)}` +
      `   W ${logStd(cells.map((c) => c.water), 1e-6).toFixed(3)}` +
      `   降水モデル ${logStd(cells.map((c) => c.p), 1).toFixed(3)}` +
      `   降水観測 ${logStd(cells.map((c) => c.obs), 1).toFixed(3)}` +
      '   ← 診断_降水の分布_2026-08-13 はこちら',
  );

  // ---- 2. 分散分解 ----
  // log P = log λ + log G + log W。λ は陸で定数なので分散に効かない
  const lg = logVals(cells.map((c) => c.g), 1e-9);
  const lw = logVals(cells.map((c) => c.water), 1e-6);
  const aw = cells.map((c) => c.w);
  console.log('\n【2】分散分解  Var(log P) = Var(log G) + Var(log W) + 2Cov(log G, log W)');
  for (const [label, w] of [
    ['面積重みつき（こちらを主に読む）', aw],
    ['重み無し（セル数。極が過大に効く — 比較用）', undefined],
  ] as Array<[string, number[] | undefined]>) {
    const vg = variance(lg, w);
    const vw = variance(lw, w);
    const cgw = covariance(lg, lw, w);
    const vTotal = vg + vw + 2 * cgw;
    console.log(`  ${label}`);
    console.log(`    Var(log G)          ${vg.toFixed(4)}   (${((100 * vg) / vTotal).toFixed(1)}%)`);
    console.log(`    Var(log W)          ${vw.toFixed(4)}   (${((100 * vw) / vTotal).toFixed(1)}%)`);
    console.log(
      `    2Cov(log G, log W)  ${(2 * cgw).toFixed(4)}   (${((100 * 2 * cgw) / vTotal).toFixed(1)}%)`,
    );
    console.log(`    合計 = Var(log P)   ${vTotal.toFixed(4)}   相関 ${correlation(lg, lw, w).toFixed(3)}`);
  }
  // **南極を除いた分解も出す。** 成績を南極抜きでも見るのと同じ理由で、
  // 一様に EF を返す大陸が結論を独占していないかを確かめる
  const noAq = cells.filter((c) => latDegOfRow(grid, Math.floor(c.i / WC)) > -60);
  {
    const g2 = logVals(noAq.map((c) => c.g), 1e-9);
    const w2 = logVals(noAq.map((c) => c.water), 1e-6);
    const a2 = noAq.map((c) => c.w);
    const vg = variance(g2, a2);
    const vw = variance(w2, a2);
    const cgw = covariance(g2, w2, a2);
    const vTotal = vg + vw + 2 * cgw;
    console.log(`  南極(60S 以南)を除く・面積重みつき  セル ${noAq.length}`);
    console.log(`    Var(log G)          ${vg.toFixed(4)}   (${((100 * vg) / vTotal).toFixed(1)}%)`);
    console.log(`    Var(log W)          ${vw.toFixed(4)}   (${((100 * vw) / vTotal).toFixed(1)}%)`);
    console.log(
      `    2Cov(log G, log W)  ${(2 * cgw).toFixed(4)}   (${((100 * 2 * cgw) / vTotal).toFixed(1)}%)`,
    );
    console.log(`    合計 = Var(log P)   ${vTotal.toFixed(4)}   相関 ${correlation(g2, w2, a2).toFixed(3)}`);
  }

  // ---- 3. 観測に合わせるのに要る補正 ----
  // W を固定した一次の見積り。G_req/G = P_obs/P
  const ratio = cells.map((c) => c.obs / Math.max(1, c.p));
  const lr = logVals(ratio, 1e-3);
  const pr = cells.map((c, k) => [ratio[k] ?? 0, c.w] as [number, number]);
  console.log('\n【3】観測に合わせるのに要る G の補正 G_req/G = P_obs/P（W 固定の一次見積り）');
  console.log('分位      補正倍率（面積重みつき）');
  for (const q of [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99]) {
    console.log(`${(q * 100).toFixed(0).padStart(3)}%  ${wquantile(pr, q).toFixed(3).padStart(10)}`);
  }
  console.log(`対数標準偏差  ${Math.sqrt(variance(lr, awAll)).toFixed(3)}`);
  console.log(
    '  読み: この対数標準偏差が 0 に近ければ「G の**形**は合っており、\n' +
      '  足りないのは全体の水準だけ」。大きければ形が違う。',
  );

  // ---- 4. 補正の向きは既存のどの倍率と相関するか ----
  console.log('\n【4】要る補正 log(P_obs/P) と既存の倍率の相関');
  console.log('  正の相関 = その倍率が小さいところで、モデルは観測より乾いている');
  const factors: Array<[string, (c: Cell) => number]> = [
    ['沈降残存 subsidenceResidual', (c) => c.subs],
    ['風上遮蔽 upwindBlock', (c) => c.block],
    ['CRH 抑制 crhSuppression', (c) => c.crh],
    ['持上げの積 lifts', (c) => c.lifts],
    ['実効 G', (c) => c.g],
    ['可降水量 W', (c) => c.water],
  ];
  console.log('  （面積重みつき。( ) 内は南極 60S 以南を除いた値）');
  const idxNoAq = cells
    .map((c, k) => [c, k] as [Cell, number])
    .filter(([c]) => latDegOfRow(grid, Math.floor(c.i / WC)) > -60);
  const lrNoAq = idxNoAq.map(([, k]) => lr[k] ?? 0);
  const awNoAq = idxNoAq.map(([c]) => c.w);
  for (const [name, f] of factors) {
    const lf = logVals(cells.map(f), 1e-9);
    const lfNoAq = idxNoAq.map(([, k]) => lf[k] ?? 0);
    console.log(
      `  ${name.padEnd(34)} corr = ${correlation(lr, lf, awAll).toFixed(3).padStart(7)}` +
        `  (${correlation(lrNoAq, lfNoAq, awNoAq).toFixed(3).padStart(6)})`,
    );
  }

  // ---- 4b. 南極を除いた分布(**ここが判断の要**)----
  //
  // 南極はケッペン判定では観測もモデルも一律 EF なので、降水が 30 倍外れても
  // 成績には出ない(docs/診断_枯渇しているのは南極だけ_2026-08-15.md)。
  // **伸びしろのある陸で、モデルの散らばりが観測より広いのか狭いのか**が
  // 方針を決める。広いなら幅を削る話、狭いなら幅を作る話になる。
  console.log('\n【4b】南極(60S 以南)を除いた分布（面積重みつき）');
  const awNo = noAq.map((c) => c.w);
  const lstdNo = (f: (c: Cell) => number, floor: number): number =>
    Math.sqrt(variance(logVals(noAq.map(f), floor), awNo));
  console.log(
    `  対数標準偏差   降水モデル ${lstdNo((c) => c.p, 1).toFixed(3)}` +
      `   降水観測 ${lstdNo((c) => c.obs, 1).toFixed(3)}` +
      `   W ${lstdNo((c) => c.water, 1e-6).toFixed(3)}` +
      `   実効G ${lstdNo((c) => c.g, 1e-9).toFixed(3)}`,
  );
  console.log(
    '  ↑ 降水モデル > 降水観測 なら**広すぎる**、< なら**狭すぎる**。\n' +
      '    全陸（南極込み）では 0.709 対 0.560 で広すぎた。南極を抜くとどうか。',
  );
  const pwNo = noAq.map((c) => [c.water, c.w] as [number, number]);
  const pgNo = noAq.map((c) => [c.g, c.w] as [number, number]);
  const ppNo = noAq.map((c) => [c.p, c.w] as [number, number]);
  const poNo = noAq.map((c) => [c.obs, c.w] as [number, number]);
  console.log('  分位      実効G        W(mm)     降水モデル   降水観測');
  for (const q of [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99]) {
    console.log(
      `  ${(q * 100).toFixed(0).padStart(3)}%  ${wquantile(pgNo, q).toExponential(3).padStart(11)}` +
        `  ${wquantile(pwNo, q).toFixed(3).padStart(10)}` +
        `  ${wquantile(ppNo, q).toFixed(0).padStart(9)}` +
        `  ${wquantile(poNo, q).toFixed(0).padStart(9)}`,
    );
  }
  console.log(
    `  1〜99% 幅   実効G ${(wquantile(pgNo, 0.99) / Math.max(1e-12, wquantile(pgNo, 0.01))).toFixed(1)} 倍` +
      `   W ${(wquantile(pwNo, 0.99) / Math.max(1e-12, wquantile(pwNo, 0.01))).toFixed(1)} 倍` +
      `   降水モデル ${(wquantile(ppNo, 0.99) / Math.max(1e-12, wquantile(ppNo, 0.01))).toFixed(1)} 倍` +
      `   降水観測 ${(wquantile(poNo, 0.99) / Math.max(1e-12, wquantile(poNo, 0.01))).toFixed(1)} 倍`,
  );
  {
    const rNo = noAq.map((c) => c.obs / Math.max(1, c.p));
    console.log(
      `  要る補正 P_obs/P の対数標準偏差 ${Math.sqrt(variance(logVals(rNo, 1e-3), awNo)).toFixed(3)}` +
        `   中央 ${wquantile(noAq.map((c, k) => [rNo[k] ?? 0, c.w] as [number, number]), 0.5).toFixed(3)}`,
    );
  }

  // ---- 5. 7 点の地域平均(考察_凝結率の意味 との突合)----
  console.log('\n【5】地域平均の実効 G（考察_凝結率の意味_2026-08-13 の 3.8 倍と突き合わせる）');
  const named = ['congo_tropical', 'india_tropical', 'antarctica_ice', 'east_asia_humid'];
  const regionG: Array<[string, number]> = [];
  for (const id of named) {
    const gate = REGION_GATES.find((g) => g.id === id);
    if (!gate) continue;
    let s = 0;
    let w = 0;
    for (const c of cells) {
      const row = Math.floor(c.i / WC);
      const lat = latDegOfRow(grid, row);
      if (lat < gate.latMin || lat > gate.latMax) continue;
      const lon = lonDegOfCol(grid, c.i % WC);
      const inLon =
        gate.lonMin <= gate.lonMax
          ? lon >= gate.lonMin && lon <= gate.lonMax
          : lon >= gate.lonMin || lon <= gate.lonMax;
      if (!inLon) continue;
      s += c.w * c.g;
      w += c.w;
    }
    if (w > 0) regionG.push([id, s / w]);
  }
  for (const [id, g] of regionG) console.log(`  ${id.padEnd(20)} ${g.toExponential(3)}`);
  if (regionG.length >= 2) {
    const vals = regionG.map((x) => x[1]);
    console.log(
      `  地域平均どうしの幅 ${(Math.max(...vals) / Math.max(1e-12, Math.min(...vals))).toFixed(1)} 倍` +
        `  ← 全セルの 1〜99% 幅 ${(g99 / Math.max(1e-12, g01)).toFixed(1)} 倍と比べること`,
    );
  }
}

void main();
