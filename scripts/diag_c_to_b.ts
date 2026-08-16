// 診断: **観測 C(温帯)をモデルが B(乾燥)と誤判定している場所は、あと何 mm 足りないのか。**
//
// なぜ要るか(2026-08-16):
//   大分類の混同行列を見ると、失点が 1 か所に集中している。
//
//     観測 C の 45.3% しか当てられておらず、**48% を B と判定している**。
//     大分類の誤り 25.8 ポイントのうち、C↔B だけで 8.2 ポイント(32%)。
//
//   ケッペンの B/C 境界は**乾燥閾値**という明示式で決まる:
//
//     P_th(mm/年) = 20 × T + (280 なら夏雨 / 140 なら均等 / 0 なら冬雨)
//     年降水 P < P_th なら B(乾燥)、そうでなければ気温で A/C/D/E
//
//   **つまり「あと何 mm 降れば C になるか」が 1 セルずつ計算できる。**
//   これは「成績が伸び悩むのは限界か構造か」という問いに、
//   **必要な改善量という形で数値で答える**唯一の道である。
//
//   小さければ(数十 mm)射程内で、大きければ(数百 mm)機構が足りない。
//
// 何を出すか:
//   1. 観測 C・モデル B のセルの面積と、不足量 P_th − P_model の分布
//   2. その地理(緯度帯・海岸距離・大陸)。**見当で「南中国が」と言わないため**
//   3. 逆向き(観測 B・モデル C)の過剰量も同じ形で
//   4. 参考: 観測 C・モデル C(当たっている C)がどれだけ余裕を持っているか
//
// 実行: npx tsx scripts/diag_c_to_b.ts [--res 2]

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow } from '../src/domain/grid';
import { KOPPEN_CLASSES, MAJOR, majorClassOf } from '../src/domain/koppen';
import { getClimObs, getKoppenObs } from './scoring';
import { openAccel } from './accel_cli';

const resIdx = process.argv.indexOf('--res');
const RES = resIdx >= 0 ? Number(process.argv[resIdx + 1] ?? 1) : 1;

/**
 * ケッペンの乾燥閾値(mm/年)。
 *
 * **`src/sim/step07_koppen.ts` の `classifyKoppenCell` と同じ式でなければ
 * 「あと何 mm」が嘘になる**ので、あちらを写して同じにしてある:
 *
 * ```
 * pThreshBase = 2*T + 28  (夏雨: pSummer >= 0.7*P)
 *             = 2*T       (冬雨: pWinter >= 0.7*P)
 *             = 2*T + 14  (それ以外)
 * pThresh = max(0, pThreshBase) * 10   // mm/年
 * B になるのは pThresh > 0 かつ P < pThresh
 * ```
 *
 * **写しているので、分類器を変えたらここも変えること。**
 * (本来は分類器から閾値を返す口を生やすのが筋だが、
 *  分類器は「クラス ID を返す純粋関数」として凍結されているので触らない)
 */
function aridThresholdMm(annualTempC: number, monthlyP: number[], northern: boolean): number {
  const summerMonths = northern ? [3, 4, 5, 6, 7, 8] : [9, 10, 11, 0, 1, 2];
  const winterMonths = northern ? [9, 10, 11, 0, 1, 2] : [3, 4, 5, 6, 7, 8];
  const total = monthlyP.reduce((s, v) => s + Math.max(0, v), 0);
  const pSummer = summerMonths.reduce((s, m) => s + Math.max(0, monthlyP[m] ?? 0), 0);
  const pWinter = winterMonths.reduce((s, m) => s + Math.max(0, monthlyP[m] ?? 0), 0);
  let base = 2 * annualTempC + 14;
  if (total > 0) {
    if (pSummer >= 0.7 * total) base = 2 * annualTempC + 28;
    else if (pWinter >= 0.7 * total) base = 2 * annualTempC;
  }
  return Math.max(0, base) * 10;
}

interface Cell {
  w: number;
  lat: number;
  lon: number;
  coastKm: number;
  tC: number;
  pModel: number;
  pObs: number;
  threshold: number;
  /** 正なら「あと何 mm 足りない」、負なら余裕 */
  shortfall: number;
  obsSym: string;
}

function wsum(cells: Cell[]): number {
  return cells.reduce((a, c) => a + c.w, 0);
}
function wquantile(cells: Cell[], f: (c: Cell) => number, p: number): number {
  const a = [...cells].sort((x, y) => f(x) - f(y));
  const total = wsum(a);
  let acc = 0;
  for (const c of a) {
    acc += c.w;
    if (acc >= p * total) return f(c);
  }
  return a.length > 0 ? f(a[a.length - 1] as Cell) : 0;
}
function wmean(cells: Cell[], f: (c: Cell) => number): number {
  return cells.reduce((a, c) => a + c.w * f(c), 0) / Math.max(1e-9, wsum(cells));
}

async function main(): Promise<void> {
  const accel = await openAccel();
  let r;
  try {
    r = await runPipeline({ ...EARTH_PARAMS, gridResolutionDeg: RES }, accel.opts);
  } finally {
    accel.close();
  }
  const grid = r.context.grid;
  const WC = grid.widthCells;
  const land = r.context.terrain.landMask;
  const coastKm = r.context.landDistToCoastKm;
  const kobs = getKoppenObs();
  const clim = getClimObs();

  const cToB: Cell[] = [];
  const bToC: Cell[] = [];
  const cToC: Cell[] = [];

  // 観測ケッペンは**モデル格子と同じ配置**で、採点(scoring.koppenScore)は
  // `classRaster[i]` を直に引いている。ここで独自に緯度から行を再計算すると
  // 1 行ずれる(実際に 2026-08-16 に踏んだ)。**採点と同じ引き方をする。**
  const climF = Math.round(2 / RES);
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    const w = Math.cos((lat * Math.PI) / 180);
    const cr = Math.min(clim.heightCells - 1, Math.floor(row / climF));
    for (let col = 0; col < WC; col++) {
      const i = row * WC + col;
      if (!land[i]) continue;
      const lon = -180 + (col + 0.5) * RES;
      const obsId = kobs.classRaster[i] ?? 0;
      if (obsId === 0) continue;
      // **大分類は 0=A 1=B 2=C 3=D 4=E**(src/domain/koppen.ts)。
      // 1=A と取り違えて D↔C を測っていた(同日、実際に踏んだ)
      const obsMajor = majorClassOf(obsId);
      const modMajor = majorClassOf(r.koppen.classId[i] ?? 0);
      if (obsMajor < 0 || modMajor < 0) continue;

      const cc = Math.min(clim.widthCells - 1, Math.floor(col / climF));
      const ci = cr * clim.widthCells + cc;
      const pMon: number[] = [];
      let pModel = 0;
      let tSum = 0;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        const p = r.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;
        pMon.push(p);
        pModel += p;
        tSum += r.temperature.monthlyTemperatureC[m]?.[i] ?? 0;
      }
      let pObs = 0;
      let bad = false;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        const v = clim.monthlyPrecipitationMm[m]?.[ci];
        if (v === undefined || v <= -9000) {
          bad = true;
          break;
        }
        pObs += v;
      }
      if (bad) continue;
      const tC = tSum / MONTHS_PER_YEAR;
      const th = aridThresholdMm(tC, pMon, lat >= 0);
      const cell: Cell = {
        w,
        lat,
        lon,
        coastKm: coastKm[i] ?? 0,
        tC,
        pModel,
        pObs,
        threshold: th,
        shortfall: th - pModel,
        obsSym: KOPPEN_CLASSES[obsId] ?? '?',
      };
      if (obsMajor === MAJOR.C && modMajor === MAJOR.B) cToB.push(cell);
      else if (obsMajor === MAJOR.B && modMajor === MAJOR.C) bToC.push(cell);
      else if (obsMajor === MAJOR.C && modMajor === MAJOR.C) cToC.push(cell);
    }
  }

  const totalW = wsum(cToB) + wsum(bToC) + wsum(cToC);
  console.log(
    `分解能 ${RES}°。観測 C・モデル B = ${cToB.length} セル / ` +
      `観測 B・モデル C = ${bToC.length} / 当たっている C = ${cToC.length}\n`,
  );

  const show = (name: string, g: Cell[]): void => {
    if (g.length === 0) {
      console.log(`${name}: 該当なし\n`);
      return;
    }
    console.log(`【${name}】面積重み ${((100 * wsum(g)) / Math.max(1e-9, totalW)).toFixed(1)}% (3 群中)`);
    console.log(
      `  年降水 モデル ${wmean(g, (c) => c.pModel).toFixed(0)} / 観測 ${wmean(g, (c) => c.pObs).toFixed(0)} mm` +
        `  気温 ${wmean(g, (c) => c.tC).toFixed(1)}°C  乾燥閾値 ${wmean(g, (c) => c.threshold).toFixed(0)} mm`,
    );
    console.log(
      `  **不足量 P_th − P_model**: 中央 ${wquantile(g, (c) => c.shortfall, 0.5).toFixed(0)} mm/年` +
        `  (25% ${wquantile(g, (c) => c.shortfall, 0.25).toFixed(0)} / 75% ${wquantile(g, (c) => c.shortfall, 0.75).toFixed(0)})`,
    );
    console.log(
      `  観測との降水差 P_obs − P_model: 中央 ${wquantile(g, (c) => c.pObs - c.pModel, 0.5).toFixed(0)} mm/年`,
    );
    console.log(
      `  緯度 中央 ${wquantile(g, (c) => c.lat, 0.5).toFixed(0)}°  海岸距離 中央 ${wquantile(g, (c) => c.coastKm, 0.5).toFixed(0)} km`,
    );
    // 経度帯の内訳。**地理を決め打ちしないため、帯で機械的に出す**
    const bands: Array<[string, number, number]> = [
      ['米州西 -180〜-100', -180, -100],
      ['米州東 -100〜-30', -100, -30],
      ['欧阿   -30〜60', -30, 60],
      ['亜州西  60〜100', 60, 100],
      ['亜州東 100〜180', 100, 180],
    ];
    const parts = bands.map(([n, lo, hi]) => {
      const sub = g.filter((c) => c.lon >= lo && c.lon < hi);
      return `${n}: ${((100 * wsum(sub)) / Math.max(1e-9, wsum(g))).toFixed(0)}%`;
    });
    console.log(`  経度帯: ${parts.join('  ')}\n`);
  };

  show('観測 C → モデル B(温帯を乾燥と誤判定)', cToB);
  show('観測 B → モデル C(乾燥を温帯と誤判定)', bToC);

  if (cToC.length > 0) {
    console.log('【当たっている C】どれだけ余裕があるか');
    console.log(
      `  余裕 P_model − P_th: 中央 ${(-wquantile(cToC, (c) => c.shortfall, 0.5)).toFixed(0)} mm/年` +
        `  (25% ${(-wquantile(cToC, (c) => c.shortfall, 0.75)).toFixed(0)} / 75% ${(-wquantile(cToC, (c) => c.shortfall, 0.25)).toFixed(0)})\n`,
    );
  }

  // **必要な改善量の総量**。「限界か構造か」に数値で答えるための要約
  if (cToB.length > 0) {
    const med = wquantile(cToB, (c) => c.shortfall, 0.5);
    const medObs = wquantile(cToB, (c) => c.pObs - c.pModel, 0.5);
    console.log('===== 要約 =====');
    console.log(
      `観測 C をモデルが B と誤判定している場所で、**閾値まであと中央 ${med.toFixed(0)} mm/年**。\n` +
        `同じ場所の観測との降水差は中央 ${medObs.toFixed(0)} mm/年。\n` +
        `→ 不足が観測差より小さければ、**観測を完全に再現しなくても分類は直る**。\n` +
        `→ 不足が数十 mm なら射程内、数百 mm なら機構が足りない。`,
    );
  }
}

void main();
