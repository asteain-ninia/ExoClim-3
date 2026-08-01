// 土壌水分バケツの周期定常解が初期値に依らないか(縮退していないか)を詰める。
//
// 既知の欠陥(2026-08-01):
//   初期貯水を空/満杯に変えるだけで貯水が最大 600mm(容量の 100%)、
//   実蒸発散が 5.3% 変わる。solveSoilWater のコメント
//   「初期値に依らない決定的な解」は成立していない。
//
// 構造の見立て:
//   available = S + P、wet = clamp(available/容量, 0, 1)、ET = min(available, PET×wet)
//   available ≥ 容量 の月は wet が 1 に飽和して ET が S に依らなくなり、
//   S ← available − ET = S + (P − PET) となって**写像の傾きがちょうど 1**。
//   その月は縮小せず、初期値の差がそのまま残る。
//
// ここで測ること:
//   (a) 各陸セルが「傾き 1 の帯」に何か月入っているか
//   (b) 年間を通じた実効的な縮小率(12 か月ぶんの傾きの積)
//   (c) 初期値(空 / 半分 / 満杯)を変えたときの解の開き
//   (d) 空回し年数を増やせば閉じるのか(遅いだけなのか、本当に縮退なのか)
//
// 実行: npx tsx scripts/diag_soil_degeneracy.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS as K } from '../src/sim/constants';
import { solveSoilWater, potentialEtMmPerMonth } from '../src/sim/step06_precipitation';
import { openAccel } from './accel_cli';
import { areaWeightOfRow } from '../src/domain/grid';

const accel = await openAccel();
const r = await runPipeline(EARTH_PARAMS, accel.opts);
accel.close();

const grid = r.context.grid;
const N = grid.cellCount;
const land = r.context.terrain.landMask;
const isLand = (i: number): boolean => land[i] === 1;
const cap = K.soilWaterCapacityMm;
const precip = r.precipitation.monthlyPrecipMm;
const temp = r.temperature.monthlyTemperatureC;

console.log(`容量 ${cap}mm / 可能蒸発散スケール ${K.soilPetScaleMmPerMonth}mm/月\n`);

// ---- (c) 初期値を変えて解く ----
const solveWith = (frac: number) =>
  solveSoilWater(N, isLand, precip, temp, cap, K.soilSpinupYears, frac);
const empty = solveWith(0);
const half = solveWith(0.5);
const full = solveWith(1);

const stats = (a: Float32Array[], b: Float32Array[], label: string): void => {
  let maxAbs = 0;
  let sum = 0;
  let wsum = 0;
  let sumRef = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const w = areaWeightOfRow(grid, row);
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      if (!isLand(i)) continue;
      for (let m = 0; m < 12; m++) {
        const d = Math.abs((a[m]?.[i] ?? 0) - (b[m]?.[i] ?? 0));
        if (d > maxAbs) maxAbs = d;
        sum += w * d;
        sumRef += w * Math.abs(b[m]?.[i] ?? 0);
        wsum += w;
      }
    }
  }
  console.log(
    `${label.padEnd(28, '　')} 面積平均 |Δ| ${(sum / wsum).toFixed(3)} / 最大 ${maxAbs.toFixed(1)} ` +
      `/ 相対 ${((sum / Math.max(1e-9, sumRef)) * 100).toFixed(2)}%`,
  );
};

console.log('初期値による解の開き(空 対 満杯):');
stats(empty.storageMm, full.storageMm, '  貯水 mm');
stats(empty.actualEtMm, full.actualEtMm, '  実蒸発散 mm/月');
console.log('初期値による解の開き(空 対 半分):');
stats(empty.storageMm, half.storageMm, '  貯水 mm');
stats(empty.actualEtMm, half.actualEtMm, '  実蒸発散 mm/月');
console.log(
  `空回し年数: 空 ${empty.spinupYears} / 半分 ${half.spinupYears} / 満杯 ${full.spinupYears}` +
    `(上限 ${K.soilSpinupYears})`,
);
console.log(
  `最終ドリフト(陸平均): 空 ${empty.meanAnnualStorageDriftMm.toExponential(2)} / ` +
    `満杯 ${full.meanAnnualStorageDriftMm.toExponential(2)}mm/年`,
);

// ---- (a)(b) 傾き 1 の帯にいる月数と年間縮小率 ----
// 空初期の解を基準に、各月の写像の傾き d(S_next)/d(S_prev) を数える。
//   available = S + P
//   available < 容量           → wet = available/容量、ET = PET×available/容量
//                                 S_next = available(1 − PET/容量) → 傾き 1 − PET/容量
//   available ≥ 容量 かつ余剰なし → ET = PET(S に依らない) → 傾き 1
//   available − ET > 容量        → S_next = 容量(飽和) → 傾き 0
let neutralMonths = 0;
let totalMonths = 0;
const perCellSlope = new Float64Array(N).fill(1);
const neutralCount = new Int32Array(N);
for (let m = 0; m < 12; m++) {
  const p = precip[m]!;
  const t = temp[m]!;
  const sPrev = empty.storageMm[(m + 11) % 12]!;
  for (let i = 0; i < N; i++) {
    if (!isLand(i)) continue;
    const available = (sPrev[i] ?? 0) + (p[i] ?? 0);
    const pet = potentialEtMmPerMonth(t[i] ?? 0);
    let slope: number;
    if (available >= cap) {
      const et = Math.min(available, pet);
      slope = available - et > cap ? 0 : 1;
    } else {
      slope = Math.max(0, 1 - pet / cap);
    }
    perCellSlope[i] = (perCellSlope[i] ?? 1) * slope;
    if (slope > 0.999) {
      neutralCount[i] = (neutralCount[i] ?? 0) + 1;
      neutralMonths++;
    }
    totalMonths++;
  }
}
console.log(
  `\n傾きが 1 の月(縮小しない): ${((neutralMonths / totalMonths) * 100).toFixed(1)}% の陸セル月`,
);

// 年間縮小率の分布(1 に近いほど初期値が残る)
const slopes: number[] = [];
let neutralCells = 0;
let landCells = 0;
for (let i = 0; i < N; i++) {
  if (!isLand(i)) continue;
  landCells++;
  slopes.push(perCellSlope[i] ?? 0);
  if ((perCellSlope[i] ?? 0) > 0.999) neutralCells++;
}
slopes.sort((a, b) => a - b);
const q = (f: number): number =>
  slopes[Math.min(slopes.length - 1, Math.floor(f * slopes.length))] ?? 0;
console.log(
  `年間縮小率(12 か月の傾きの積)の分布: ` +
    `p10 ${q(0.1).toExponential(2)} / 中央 ${q(0.5).toExponential(2)} / ` +
    `p90 ${q(0.9).toFixed(4)} / p99 ${q(0.99).toFixed(4)} / 最大 ${q(1).toFixed(6)}`,
);
console.log(
  `年間縮小率が 0.999 を超える(実質縮小しない)セル: ${neutralCells} / ${landCells}` +
    `(${((neutralCells / landCells) * 100).toFixed(2)}%)`,
);
// 縮小率 0.99 のセルが許容差 0.05mm/年 に達するまでの年数
for (const s of [0.9, 0.99, 0.999]) {
  const years = Math.log(0.05 / 600) / Math.log(s);
  console.log(`  縮小率 ${s}: 初期差 600mm が 0.05mm になるまで ${Math.ceil(years)} 年`);
}
console.log(
  '\n結論の読み方:\n' +
    '  縮小率が 1 ちょうどのセルが多いなら**真の縮退**(解の連続族)。\n' +
    '  1 未満だが 1 に近いだけなら**収束が遅いだけ**で、空回し年数を増やせば閉じる。',
);
