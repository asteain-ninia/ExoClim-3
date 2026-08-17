// 診断: **水蒸気の拡散は、どの緯度帯でどれだけ輸送を担っているか。**
//
// なぜ要るか(2026-08-17):
//   文献調査(docs/調査_他のモデルは同じ壁に当たっているか_2026-08-17.md)で、
//   「拡散係数を定数とする仮定はほとんど正当化できない」
//   「拡散が妥当なのは中緯度の総観渦。熱帯・亜熱帯では過大」と分かった。
//   本モデルの `moistureEddyDiffusivityM2PerS` は全球・全季節で 1 つの定数である。
//
//   次の一手は「拡散係数に緯度・季節・海陸の構造を持たせる」だが、
//   **当てずっぽうで変調の形を決めない。** まず現状の拡散が
//   どの緯度帯・どの季節でどれだけ輸送を担っているかを測り、
//   文献の言う「過大な場所」が本モデルのどこかを特定してから設計する。
//
// 測る前の見立て(外したら記録する):
//   文献に従えば、**亜熱帯(15〜35°)の陸への水輸入は拡散が主導**していて、
//   そこが「本来はモンスーン移流が担うべき場所」のはず。
//   中緯度(35〜60°)では移流(偏西風)と拡散が拮抗、と読む。
//
// 何を出すか:
//   緯度帯 × 季節(年 / 夏半年 / 冬半年)で、陸セルの
//     移流流入 −∇·(uW) / 拡散流入 D∇²W / 源 E / 凝結 rate·W (mm/年換算)
//   と、**正味輸入(移流+拡散)に占める拡散の割合**。
//
// 流束の離散化は diag_transport_budget.ts と同一(2dx の罠は修正済みの形)。
//
// 実行: npx tsx scripts/diag_diffusion_by_latitude.ts

import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow, cellWidthKm, cellHeightKm, wrapCol } from '../src/domain/grid';
import { SECONDS_PER_MONTH } from '../src/sim/moisture_transport';
import { openAccel } from './accel_cli';

const K = MODEL_CONSTANTS as unknown as Record<string, number>;

/** |緯度| の帯。文献の区分(熱帯 / 亜熱帯 / 中緯度 / 高緯度)に合わせる */
const BANDS: Array<[string, number, number]> = [
  ['熱帯      0〜15°', 0, 15],
  ['亜熱帯   15〜35°', 15, 35],
  ['中緯度   35〜60°', 35, 60],
  ['高緯度   60〜75°', 60, 75],
];

interface Acc {
  w: number;
  adv: number;
  dif: number;
  src: number;
  cond: number;
  p: number;
}

function emptyAcc(): Acc {
  return { w: 0, adv: 0, dif: 0, src: 0, cond: 0, p: 0 };
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
  const W = grid.widthCells;
  const H = grid.heightCells;
  const land = r.context.terrain.landMask;
  const dyKm = cellHeightKm(grid, r.context.params.body.radiusKm);
  const travelKmPerMonth = ((K['condensationRefWindMs'] ?? 0) * SECONDS_PER_MONTH) / 1000;
  const dM2 = K['moistureEddyDiffusivityM2PerS'] ?? 0;
  const dKm2 = (dM2 * SECONDS_PER_MONTH) / 1e6;
  const lKm = K['moistureDecayLandKm'] ?? 1;

  // 季節 × 帯 × 面種の積算。季節: 0 = 年、1 = 夏半年、2 = 冬半年
  // 面種: 0 = 陸、1 = 沿岸海(3 セル以内に陸)、2 = 外洋
  // **なぜ海も測るか(2026-08-17)**: 陸だけ測ったら亜熱帯の拡散は「排出」だった。
  // だが移流の輸入 u·W は海側の W に依存し、その W を保っているのが拡散かも
  // しれない(拡散は海の中で W を海岸へ寄せる係の可能性)。陸だけでは
  // 拡散の役割を見誤る。
  const SEASONS = ['年', '夏半年', '冬半年'];
  const SURFACES = ['陸', '沿岸海(≤3セル)', '外洋'];
  const acc: Acc[][][] = SEASONS.map(() => SURFACES.map(() => BANDS.map(() => emptyAcc())));

  // 沿岸海の判定: 3 セル以内(チェビシェフ距離)に陸があるか
  const nearLand = new Uint8Array(grid.cellCount);
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      if (land[i]) continue;
      outer: for (let dr = -3; dr <= 3; dr++) {
        const rr = row + dr;
        if (rr < 0 || rr >= H) continue;
        for (let dc = -3; dc <= 3; dc++) {
          if (land[rr * W + wrapCol(grid, col + dc)]) {
            nearLand[i] = 1;
            break outer;
          }
        }
      }
    }
  }

  for (let row = 1; row < H - 1; row++) {
    const lat = latDegOfRow(grid, row);
    const north = lat >= 0;
    const bandIdx = BANDS.findIndex(([, lo, hi]) => Math.abs(lat) >= lo && Math.abs(lat) < hi);
    if (bandIdx < 0) continue;
    const cw = Math.cos((lat * Math.PI) / 180);
    const dxKm = Math.max(20, cellWidthKm(grid, row, r.context.params.body.radiusKm));
    // 夏半年(ケッペンと同じ月): 北半球 3〜8、南半球 9〜2
    const summerMonths = north ? [3, 4, 5, 6, 7, 8] : [9, 10, 11, 0, 1, 2];
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      const surface = land[i] ? 0 : nearLand[i] ? 1 : 2;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        const w = d.waterMm[m];
        const u = r.airflow.monthlyWindU[m];
        const v = r.airflow.monthlyWindV[m];
        const g = d.condRateG[m];
        if (!w || !u || !v || !g) continue;
        const iE = row * W + wrapCol(grid, col + 1);
        const iW = row * W + wrapCol(grid, col - 1);
        const iN = (row - 1) * W + col;
        const iS = (row + 1) * W + col;
        const kx = SECONDS_PER_MONTH / 1000;
        const fE = 0.5 * (((u[i] ?? 0) * (w[i] ?? 0)) + ((u[iE] ?? 0) * (w[iE] ?? 0))) * kx;
        const fW = 0.5 * (((u[i] ?? 0) * (w[i] ?? 0)) + ((u[iW] ?? 0) * (w[iW] ?? 0))) * kx;
        const fN = 0.5 * (((v[i] ?? 0) * (w[i] ?? 0)) + ((v[iN] ?? 0) * (w[iN] ?? 0))) * kx;
        const fS = 0.5 * (((v[i] ?? 0) * (w[i] ?? 0)) + ((v[iS] ?? 0) * (w[iS] ?? 0))) * kx;
        // 面フラックスの発散は dx で割る(2dx ではない — 2026-08-15 の教訓)
        const adv = -((fE - fW) / dxKm + (fN - fS) / dyKm);
        const lap =
          ((w[iE] ?? 0) + (w[iW] ?? 0) - 2 * (w[i] ?? 0)) / (dxKm * dxKm) +
          ((w[iN] ?? 0) + (w[iS] ?? 0) - 2 * (w[i] ?? 0)) / (dyKm * dyKm);
        const dif = dKm2 * lap;
        // 源: 陸は蒸発散、海は d.supplyOcean 相当が無いので E − P の残差で見る
        // (海の E は診断に無い。海の行は src を 0 にし、収支は閉じないことを明示)
        const src = land[i] ? (r.precipitation.land?.monthlyEtMm?.[m]?.[i] ?? 0) : 0;
        const cond = Math.max(0.05, (travelKmPerMonth / Math.max(1, lKm)) * (g[i] ?? 0)) * (w[i] ?? 0);
        const p = r.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;

        const isSummer = summerMonths.includes(m);
        for (const si of isSummer ? [0, 1] : [0, 2]) {
          const a = acc[si]?.[surface]?.[bandIdx];
          if (!a) continue;
          a.w += cw;
          a.adv += cw * adv;
          a.dif += cw * dif;
          a.src += cw * src;
          a.cond += cw * cond;
          a.p += cw * p;
        }
      }
    }
  }

  console.log('保存型の定常収支: −∇·(uW) + D∇²W + E − rate·W = 0');
  console.log(`拡散係数 D = ${dM2.toExponential(2)} m²/s（全球一定 — これが疑いの対象）\n`);
  for (let si = 0; si < SEASONS.length; si++) {
    for (let sf = 0; sf < SURFACES.length; sf++) {
      console.log(`【${SEASONS[si]} / ${SURFACES[sf]}】(面積重み平均、mm/年換算${sf > 0 ? '。海の源 E は診断に無いため 0 表示' : ''})`);
      console.log('帯               移流流入  拡散流入  源E    降水P   移流+拡散');
      for (let bi = 0; bi < BANDS.length; bi++) {
        const a = acc[si]?.[sf]?.[bi];
        if (!a || a.w <= 0) continue;
        const scale = si === 0 ? 1 : 2;
        const adv = (scale * a.adv) / a.w;
        const dif = (scale * a.dif) / a.w;
        const src = (scale * a.src) / a.w;
        const p = (scale * a.p) / a.w;
        console.log(
          `${BANDS[bi]?.[0] ?? ''}   ${adv.toFixed(1).padStart(7)} ${dif.toFixed(1).padStart(9)}` +
            ` ${src.toFixed(0).padStart(6)} ${p.toFixed(0).padStart(7)} ${(adv + dif).toFixed(1).padStart(9)}`,
        );
      }
      console.log('');
    }
  }
  console.log(
    '読み: 「拡散の割合」が大きい帯ほど、輸送を拡散(均し)が代行している。\n' +
      '  文献の期待: 中緯度は拡散が妥当(傾圧渦の代理)、熱帯・亜熱帯では過大。\n' +
      '  亜熱帯の夏で拡散が主導していれば、そこが変調の狙い所になる。',
  );
}

void main();
