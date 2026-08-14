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

/** 分位(単純分位。面積重みは平均にだけ使う) */
function quantile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] ?? 0;
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

function variance(l: number[]): number {
  const m = l.reduce((a, b) => a + b, 0) / l.length;
  return l.reduce((a, b) => a + (b - m) * (b - m), 0) / l.length;
}

function covariance(a: number[], b: number[]): number {
  const ma = a.reduce((x, y) => x + y, 0) / a.length;
  const mb = b.reduce((x, y) => x + y, 0) / b.length;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += ((a[i] ?? 0) - ma) * ((b[i] ?? 0) - mb);
  return s / a.length;
}

function correlation(a: number[], b: number[]): number {
  const va = variance(a);
  const vb = variance(b);
  if (va <= 0 || vb <= 0) return 0;
  return covariance(a, b) / Math.sqrt(va * vb);
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

  // ---- 1. 分布 ----
  const sortedG = cells.map((c) => c.g).sort((a, b) => a - b);
  const sortedW = cells.map((c) => c.water).sort((a, b) => a - b);
  const sortedP = cells.map((c) => c.p).sort((a, b) => a - b);
  const sortedO = cells.map((c) => c.obs).sort((a, b) => a - b);
  console.log('\n【1】全陸セルの分布');
  console.log('分位      実効G        W(mm)     降水モデル   降水観測');
  for (const q of [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99]) {
    console.log(
      `${(q * 100).toFixed(0).padStart(3)}%  ${quantile(sortedG, q).toExponential(3).padStart(11)}` +
        `  ${quantile(sortedW, q).toFixed(3).padStart(10)}` +
        `  ${quantile(sortedP, q).toFixed(0).padStart(9)}` +
        `  ${quantile(sortedO, q).toFixed(0).padStart(9)}`,
    );
  }
  const g99 = quantile(sortedG, 0.99);
  const g01 = quantile(sortedG, 0.01);
  console.log(
    `\n実効 G の 1〜99% 幅   ${(g99 / Math.max(1e-12, g01)).toFixed(1)} 倍` +
      `   （最大/最小 ${((sortedG[sortedG.length - 1] ?? 0) / Math.max(1e-12, sortedG[0] ?? 0)).toFixed(1)} 倍）`,
  );
  console.log(
    `対数標準偏差   実効G ${logStd(cells.map((c) => c.g), 1e-9).toFixed(3)}` +
      `   W ${logStd(cells.map((c) => c.water), 1e-6).toFixed(3)}` +
      `   降水モデル ${logStd(cells.map((c) => c.p), 1).toFixed(3)}` +
      `   降水観測 ${logStd(cells.map((c) => c.obs), 1).toFixed(3)}`,
  );

  // ---- 2. 分散分解 ----
  // log P = log λ + log G + log W。λ は陸で定数なので分散に効かない
  const lg = logVals(cells.map((c) => c.g), 1e-9);
  const lw = logVals(cells.map((c) => c.water), 1e-6);
  const lp = logVals(cells.map((c) => c.p), 1);
  const vg = variance(lg);
  const vw = variance(lw);
  const cgw = covariance(lg, lw);
  const vTotal = vg + vw + 2 * cgw;
  console.log('\n【2】分散分解  Var(log P) = Var(log G) + Var(log W) + 2Cov(log G, log W)');
  console.log(`  Var(log G)          ${vg.toFixed(4)}   (${((100 * vg) / vTotal).toFixed(1)}%)`);
  console.log(`  Var(log W)          ${vw.toFixed(4)}   (${((100 * vw) / vTotal).toFixed(1)}%)`);
  console.log(`  2Cov(log G, log W)  ${(2 * cgw).toFixed(4)}   (${((100 * 2 * cgw) / vTotal).toFixed(1)}%)`);
  console.log(`  合計                ${vTotal.toFixed(4)}   （床再配分前。実測 Var(log P) = ${variance(lp).toFixed(4)}）`);
  console.log(`  相関 corr(log G, log W) = ${correlation(lg, lw).toFixed(3)}`);

  // ---- 3. 観測に合わせるのに要る補正 ----
  // W を固定した一次の見積り。G_req/G = P_obs/P
  const ratio = cells.map((c) => c.obs / Math.max(1, c.p));
  const lr = logVals(ratio, 1e-3);
  const sortedR = [...ratio].sort((a, b) => a - b);
  console.log('\n【3】観測に合わせるのに要る G の補正 G_req/G = P_obs/P（W 固定の一次見積り）');
  console.log('分位      補正倍率');
  for (const q of [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99]) {
    console.log(`${(q * 100).toFixed(0).padStart(3)}%  ${quantile(sortedR, q).toFixed(3).padStart(10)}`);
  }
  console.log(`対数標準偏差  ${logStd(ratio, 1e-3).toFixed(3)}`);
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
  for (const [name, f] of factors) {
    const lf = logVals(cells.map(f), 1e-9);
    console.log(`  ${name.padEnd(34)} corr = ${correlation(lr, lf).toFixed(3).padStart(7)}`);
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
