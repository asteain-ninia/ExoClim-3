// 診断: **可降水量 W が 0 へ潰れているのはどこか。なぜ水が届かないのか。**
//
// 前段: docs/診断_幅を作っているのはGではなくW_2026-08-15.md
//   降水の散らばりの 91% は W が作っており、W は 1% の 0.007mm から
//   99% の 6.76mm まで**約 1000 倍**動く(実物はせいぜい 50 倍)。
//   25% 分位(0.037mm)と 50% 分位(1.400mm)のあいだに 38 倍の段差があり、
//   分布が事実上 2 つの山に割れている。
//
// **見当はついているが(南極内陸・チベット・大陸内部)、見当で書かない。**
// 乾いた側の山がどこで、なぜ水が届かないのかを数える。
//
// 何を分けたいか:
//   **寒いから乾いているのか、遠いから乾いているのか。**
//   この 2 つは処方が正反対になる。
//     寒い  → 源(蒸発)が無い。輸送を強めても近くに水源が無い
//     遠い  → 源はあるが届かない。輸送の到達距離が足りない
//   海岸距離 × 年平均気温の 2 元表で median W を出せば分けられる。
//
// 到達距離の理論値も並べる。定常の 1 次元では W は源から
//   移流長  L_adv = U / (λG)
//   拡散長  L_dif = sqrt(D / (λG))
// で減衰する。実測の減衰長がどちらに近いかで、律速している経路が分かる。
//
// 実行: npx tsx scripts/diag_water_starved.ts

import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow, lonDegOfCol } from '../src/domain/grid';
import { SECONDS_PER_MONTH } from '../src/sim/moisture_transport';
import { getClimObs } from './scoring';
import { openAccel } from './accel_cli';

const K = MODEL_CONSTANTS as unknown as Record<string, number>;

/** 中央値(破壊的でない) */
function median(vals: number[]): number {
  if (vals.length === 0) return NaN;
  const a = [...vals].sort((x, y) => x - y);
  const h = a.length >> 1;
  return a.length % 2 ? (a[h] ?? 0) : ((a[h - 1] ?? 0) + (a[h] ?? 0)) / 2;
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
  const elev = r.context.terrain.elevationMeters;
  const coastKm = r.context.landDistToCoastKm;
  const clim = getClimObs();

  if (d.waterMm.length === 0) {
    console.log('W の診断が空。保存型で走っているか確認すること。');
    return;
  }

  interface Cell {
    i: number;
    lat: number;
    lon: number;
    /** 年平均 W mm */
    w: number;
    /** 年平均気温 °C */
    t: number;
    /** 標高 m */
    elev: number;
    /** 海岸距離 km */
    coast: number;
    /** モデル年降水 mm/年 */
    p: number;
    /** 観測年降水 mm/年(欠損は NaN) */
    obs: number;
    /** 年蒸発散 mm/年(陸面。無効なら 0) */
    et: number;
    /** 年平均の実効 G */
    g: number;
  }

  const travelKmPerMonth = ((K['condensationRefWindMs'] ?? 0) * SECONDS_PER_MONTH) / 1000;
  const lambdaLand = travelKmPerMonth / Math.max(1, K['moistureDecayLandKm'] ?? 1);

  const cells: Cell[] = [];
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    const cr = Math.min(clim.heightCells - 1, Math.round((row / grid.heightCells) * clim.heightCells));
    for (let col = 0; col < WC; col++) {
      const i = row * WC + col;
      if (!land[i]) continue;
      let w = 0;
      let t = 0;
      let p = 0;
      let et = 0;
      let pre = 0;
      let wSum = 0;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        w += d.waterMm[m]?.[i] ?? 0;
        wSum += d.waterMm[m]?.[i] ?? 0;
        t += r.temperature.monthlyTemperatureC[m]?.[i] ?? 0;
        p += r.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;
        et += r.precipitation.land?.monthlyEtMm?.[m]?.[i] ?? 0;
        pre += d.preAdjustMm[m]?.[i] ?? 0;
      }
      const cc = Math.min(clim.widthCells - 1, Math.round((col / grid.widthCells) * clim.widthCells));
      const ci = cr * clim.widthCells + cc;
      let obs = 0;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        const v = clim.monthlyPrecipitationMm[m]?.[ci];
        if (v === undefined || v <= -9000) {
          obs = NaN;
          break;
        }
        obs += v;
      }
      cells.push({
        i,
        lat,
        lon: lonDegOfCol(grid, col),
        w: w / MONTHS_PER_YEAR,
        t: t / MONTHS_PER_YEAR,
        elev: elev[i] ?? 0,
        coast: coastKm[i] ?? 0,
        p,
        obs,
        et,
        g: pre / Math.max(1e-12, lambdaLand * wSum),
      });
    }
  }

  // ---- 1. 乾いた側の山はどこか ----
  // 25% 分位 0.037mm と 50% 分位 1.400mm のあいだに段差がある。
  // 閾値は**その谷**に置く(0.2mm)。閾値を動かして頑健さも見る
  console.log(`陸セル ${cells.length}\n`);
  console.log('【1】W の閾値ごとの陸の割合と、そこの降水');
  console.log('閾値W      セル数   陸の%   モデル降水  観測降水   中央値W    中央緯度');
  for (const th of [0.05, 0.1, 0.2, 0.5, 1.0]) {
    const s = cells.filter((c) => c.w < th);
    const withObs = s.filter((c) => Number.isFinite(c.obs));
    console.log(
      `<${th.toFixed(2)}    ${String(s.length).padStart(6)}  ${((100 * s.length) / cells.length).toFixed(1).padStart(6)}` +
        `  ${median(s.map((c) => c.p)).toFixed(0).padStart(9)}` +
        `  ${median(withObs.map((c) => c.obs)).toFixed(0).padStart(8)}` +
        `  ${median(s.map((c) => c.w)).toExponential(2).padStart(9)}` +
        `  ${median(s.map((c) => c.lat)).toFixed(1).padStart(8)}`,
    );
  }

  const starved = cells.filter((c) => c.w < 0.2);
  console.log(`\n枯渇セル(W < 0.2mm)= ${starved.length} 個。緯度の分布:`);
  const latBins: Array<[string, (c: Cell) => boolean]> = [
    ['90〜60S', (c) => c.lat < -60],
    ['60〜30S', (c) => c.lat >= -60 && c.lat < -30],
    ['30S〜30N', (c) => c.lat >= -30 && c.lat <= 30],
    ['30〜60N', (c) => c.lat > 30 && c.lat <= 60],
    ['60〜90N', (c) => c.lat > 60],
  ];
  for (const [name, f] of latBins) {
    const s = starved.filter(f);
    const all = cells.filter(f);
    console.log(
      `  ${name.padEnd(9)} ${String(s.length).padStart(5)} / ${String(all.length).padStart(5)}` +
        `  (帯の ${((100 * s.length) / Math.max(1, all.length)).toFixed(0)}%)` +
        `  中央標高 ${median(s.map((c) => c.elev)).toFixed(0)}m` +
        `  中央海岸距離 ${median(s.map((c) => c.coast)).toFixed(0)}km` +
        `  中央気温 ${median(s.map((c) => c.t)).toFixed(1)}°C`,
    );
  }

  // ---- 2. 寒いからか、遠いからか ----
  console.log('\n【2】海岸距離 × 年平均気温 の 2 元表（中央値 W mm。( ) 内はセル数）');
  const coastBins = [0, 250, 500, 1000, 2000, 1e9];
  const tempBins = [-1e9, -20, -5, 10, 25, 1e9];
  const tempName = ['〜−20', '−20〜−5', '−5〜10', '10〜25', '25〜'];
  const coastName = ['〜250', '250〜500', '500〜1000', '1000〜2000', '2000〜'];
  console.log('海岸km \\ 気温 ' + tempName.map((s) => s.padStart(14)).join(''));
  for (let ci = 0; ci < coastBins.length - 1; ci++) {
    let line = coastName[ci]?.padEnd(13) ?? '';
    for (let ti = 0; ti < tempBins.length - 1; ti++) {
      const s = cells.filter(
        (c) =>
          c.coast >= (coastBins[ci] ?? 0) &&
          c.coast < (coastBins[ci + 1] ?? 0) &&
          c.t >= (tempBins[ti] ?? 0) &&
          c.t < (tempBins[ti + 1] ?? 0),
      );
      line +=
        s.length === 0
          ? '             —'
          : `${median(s.map((c) => c.w)).toFixed(2)}(${s.length})`.padStart(14);
    }
    console.log(line);
  }
  console.log(
    '  読み: 行方向(遠くなる)に落ちるなら**届いていない**、\n' +
      '        列方向(寒くなる)に落ちるなら**源が無い**。両方なら両方。',
  );

  // 同じ表を降水で出す。**観測もそこで乾いているなら誤りではない。**
  // モデル / 観測 / 比 の 3 枚を同じ枠で並べる — 比だけ見ると
  // 「両方 0 に近い」場所で桁が暴れるので、絶対値も必ず並べる
  for (const [label, f] of [
    ['観測年降水 mm/年（中央値）', (c: Cell) => c.obs],
    ['モデル年降水 mm/年（中央値）', (c: Cell) => c.p],
  ] as Array<[string, (c: Cell) => number]>) {
    console.log(`\n  対照: 同じ枠の${label}`);
    console.log('海岸km \\ 気温 ' + tempName.map((s) => s.padStart(14)).join(''));
    for (let ci = 0; ci < coastBins.length - 1; ci++) {
      let line = coastName[ci]?.padEnd(13) ?? '';
      for (let ti = 0; ti < tempBins.length - 1; ti++) {
        const s = cells.filter(
          (c) =>
            Number.isFinite(c.obs) &&
            c.coast >= (coastBins[ci] ?? 0) &&
            c.coast < (coastBins[ci + 1] ?? 0) &&
            c.t >= (tempBins[ti] ?? 0) &&
            c.t < (tempBins[ti + 1] ?? 0),
        );
        line += s.length === 0 ? '             —' : `${median(s.map(f)).toFixed(0)}`.padStart(14);
      }
      console.log(line);
    }
  }

  // ---- 3. 到達距離の理論値 ----
  // 実効の凝結率 λG(枯渇セルの中央値)から、移流長と拡散長を出す
  const gMed = median(starved.map((c) => c.g));
  const rateMed = Math.max(0.05, lambdaLand * gMed); // /月
  const dM2 = K['moistureEddyDiffusivityM2PerS'] ?? 0;
  const dKm2PerMonth = (dM2 * SECONDS_PER_MONTH) / 1e6;
  const lAdv = travelKmPerMonth / rateMed; // km。U を基準風速で代表させる
  const lDif = Math.sqrt(dKm2PerMonth / rateMed);
  console.log('\n【3】到達距離の理論値（枯渇セルの中央値 G から）');
  console.log(`  λ(陸) = ${lambdaLand.toFixed(2)} /月    枯渇セルの中央 G = ${gMed.toFixed(3)}`);
  console.log(`  実効の凝結率 λG = ${rateMed.toFixed(2)} /月 → 滞留 ${(30.44 / rateMed).toFixed(1)} 日`);
  console.log(`  移流長 L_adv = U/(λG) = ${lAdv.toFixed(0)} km`);
  console.log(`  拡散長 L_dif = sqrt(D/(λG)) = ${lDif.toFixed(0)} km   （D = ${dM2.toExponential(2)} m²/s）`);
  console.log(
    `  枯渇セルの中央海岸距離 = ${median(starved.map((c) => c.coast)).toFixed(0)} km` +
      `  → 拡散長の ${(median(starved.map((c) => c.coast)) / Math.max(1, lDif)).toFixed(1)} 倍`,
  );
  console.log(
    '  読み: 海岸距離が拡散長の数倍あるなら、指数で潰れて当然である\n' +
      '        (exp(−3) = 0.05、exp(−5) = 0.007)。W が 1000 倍動く正体はこれ。',
  );

  // ---- 4. 実測の減衰長 ----
  // 海岸距離のビンごとに median W を出し、対数の傾きから実測の減衰長を出す
  console.log('\n【4】実測の減衰長（寒い側と暖かい側で分ける）');
  for (const [label, f] of [
    ['寒い陸 (年平均 < −5°C)', (c: Cell) => c.t < -5],
    ['温暖な陸 (年平均 ≥ 10°C)', (c: Cell) => c.t >= 10],
  ] as Array<[string, (c: Cell) => boolean]>) {
    const pts: Array<[number, number]> = [];
    for (let ci = 0; ci < coastBins.length - 1; ci++) {
      const s = cells.filter(
        (c) => f(c) && c.coast >= (coastBins[ci] ?? 0) && c.coast < (coastBins[ci + 1] ?? 0),
      );
      if (s.length < 20) continue;
      pts.push([median(s.map((c) => c.coast)), median(s.map((c) => c.w))]);
    }
    if (pts.length < 2) {
      console.log(`  ${label}: セルが足りず測れない`);
      continue;
    }
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    const decayKm =
      (last[0] - first[0]) / Math.max(1e-9, Math.log(Math.max(1e-12, first[1] / Math.max(1e-12, last[1]))));
    console.log(
      `  ${label}  ` +
        pts.map(([x, y]) => `${x.toFixed(0)}km:${y.toFixed(3)}`).join('  ') +
        `\n     → 実測の減衰長 ${decayKm.toFixed(0)} km`,
    );
  }
}

void main();
