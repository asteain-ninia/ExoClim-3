// モデルと観測で「月」の定義がずれている影響を測る。
//
// モデル: 月 0 の開始 = 北半球冬至(12/21 頃)。惑星ごとに定義できる形。
// 観測フィクスチャ: 暦月(月 0 = 1 月)。
// → 約 11 日(0.36 か月)の位相差がある。採点はこれを無視して月 m 同士を比べている。
//
// ここでは観測の月別系列を 0.36 か月ぶん**モデルの位相へ**線形補間で移し、
//   (a) ケッペン分類がどれだけ変わるか
//   (b) 月別気温がどれだけ変わるか
// を測る。小さければ無視してよい。大きければ採点側を直す必要がある。
//
// 実行: npx tsx scripts/check_month_phase.ts

import fs from 'node:fs';
import path from 'node:path';
import { classifyKoppenCell } from '../src/sim/step07_koppen';
import { KOPPEN_CLASSES, majorClassOf } from '../src/domain/koppen';

interface ClimJson {
  widthCells: number;
  heightCells: number;
  monthlyTemperatureDeciC: number[][];
  monthlyPrecipitationMm: number[][];
}

const clim = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/earth_climate_2deg.json'), 'utf8'),
) as ClimJson;

const CW = clim.widthCells;
const CH = clim.heightCells;
const RES = 360 / CW;

// 冬至(12/21)から 1 月の中心(1/16)までは約 26 日 = 0.855 か月。
// モデルの月 m の中心は冬至 + (m + 0.5) か月、暦月 m の中心は 1/16 + m か月。
// したがってモデル月 m の中心は暦月の目盛で m + 0.5 - 0.855 = m - 0.355。
const SHIFT_MONTHS = 0.5 - 0.855;

/** 暦月系列を、モデルの月中心の時刻へ線形補間で移す(周期 12) */
function resample(series: number[]): number[] {
  const out: number[] = [];
  for (let m = 0; m < 12; m++) {
    const x = m + SHIFT_MONTHS;
    const lo = Math.floor(x);
    const f = x - lo;
    const a = series[((lo % 12) + 12) % 12] ?? 0;
    const b = series[(((lo + 1) % 12) + 12) % 12] ?? 0;
    out.push(a * (1 - f) + b * f);
  }
  return out;
}

let compared = 0;
let sameDetail = 0;
let sameMajor = 0;
let sameSecond = 0;
let secondCompared = 0;
let sumAbsT = 0;
let maxAbsT = 0;
let sumAbsP = 0;
let maxAbsP = 0;
let nT = 0;
const changes = new Map<string, number>();

for (let row = 0; row < CH; row++) {
  const lat = 90 - (row + 0.5) * RES;
  for (let col = 0; col < CW; col++) {
    const i = row * CW + col;
    const t: number[] = [];
    const p: number[] = [];
    let missing = false;
    for (let m = 0; m < 12; m++) {
      const tv = clim.monthlyTemperatureDeciC[m]?.[i] ?? -9999;
      const pv = clim.monthlyPrecipitationMm[m]?.[i] ?? -9999;
      if (tv <= -9000 || pv <= -9000) {
        missing = true;
        break;
      }
      t.push(tv / 10);
      p.push(Math.max(0, pv));
    }
    if (missing) continue;
    const t2 = resample(t);
    const p2 = resample(p);
    for (let m = 0; m < 12; m++) {
      const dT = Math.abs((t2[m] ?? 0) - (t[m] ?? 0));
      const dP = Math.abs((p2[m] ?? 0) - (p[m] ?? 0));
      sumAbsT += dT;
      if (dT > maxAbsT) maxAbsT = dT;
      sumAbsP += dP;
      if (dP > maxAbsP) maxAbsP = dP;
      nT++;
    }
    const a = classifyKoppenCell(t, p, lat >= 0);
    const b = classifyKoppenCell(t2, p2, lat >= 0);
    compared++;
    if (a === b) sameDetail++;
    if (majorClassOf(a) === majorClassOf(b)) sameMajor++;
    const sa = KOPPEN_CLASSES[a] ?? '';
    const sb = KOPPEN_CLASSES[b] ?? '';
    if ((sa[0] === 'C' || sa[0] === 'D') && sa[0] === sb[0]) {
      secondCompared++;
      if (sa[1] === sb[1]) sameSecond++;
    }
    if (a !== b) changes.set(`${sa} → ${sb}`, (changes.get(`${sa} → ${sb}`) ?? 0) + 1);
  }
}

console.log(
  `位相差 ${(-SHIFT_MONTHS).toFixed(3)} か月(約 ${(-SHIFT_MONTHS * 30.44).toFixed(0)} 日)`,
);
console.log(`\n観測を位相補正したときの変化(陸海あわせて ${compared.toLocaleString()} セル):`);
console.log(`  月別気温  平均 |Δ| ${(sumAbsT / nT).toFixed(3)}°C / 最大 ${maxAbsT.toFixed(2)}°C`);
console.log(`  月別降水  平均 |Δ| ${(sumAbsP / nT).toFixed(2)}mm / 最大 ${maxAbsP.toFixed(1)}mm`);
console.log(`  ケッペン  大分類が変わらない ${((sameMajor / compared) * 100).toFixed(2)}%`);
console.log(`            詳細が変わらない   ${((sameDetail / compared) * 100).toFixed(2)}%`);
console.log(
  `            第 2 文字が変わらない ${((sameSecond / secondCompared) * 100).toFixed(2)}%`,
);
if (changes.size > 0) {
  console.log('\n変わった組合せ 上位 10:');
  for (const [k, v] of [...changes].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${k.padEnd(14)} ${v}`);
  }
}
console.log(
  '\n判定: 気温の平均 |Δ| が 0.3°C 未満かつ詳細分類の変化が 1% 未満なら、' +
    '位相差は採点の誤差要因として無視できる。',
);
