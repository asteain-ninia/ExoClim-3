// 降水の乾湿コントラストがどの項で作られ、どこで潰れているかを実測する。
//
// 背景: 地球検証で温帯 C を乾燥 B と誤分類する偏り(4.6pt)があり、
// 独立な大陸配置の架空惑星でも同じ症状が出た(docs/デーレ適用_2026-08-01.md §8)。
// 気圧で全体を湿らせても乾湿の順位は変わらないため、問題は「水準」ではなく
// 「空間的コントラスト」。降水は積で組まれているので、各因子の動的範囲
// (陸上の p90/p10 比)を測れば、コントラストの担い手と潰し手が分かる。
//
// 読み方: 実測の降水は陸上で p90/p10 ≈ 10〜30 倍ある。各因子の比の積が
// これに届かなければ、モデルは構造的にコントラストを作れていない。
//
// 実行: npx tsx scripts/diag_precip_contrast.ts

import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { areaWeightOfRow } from '../src/domain/grid';
import { getClimObs } from './scoring';

const { result, precipDiag: d } = runPipelineWithPrecipDiag(EARTH_PARAMS);
const grid = result.context.grid;
const land = result.context.terrain.landMask;
const W = grid.widthCells;

/** 陸セル・全月の値を集めて分位を返す(面積重みは分位には使わない) */
function quantiles(pick: (m: number, i: number) => number): {
  p10: number;
  p50: number;
  p90: number;
  ratio: number;
} {
  const v: number[] = [];
  for (let m = 0; m < 12; m++) {
    for (let i = 0; i < grid.cellCount; i++) {
      if (!land[i]) continue;
      const x = pick(m, i);
      if (Number.isFinite(x)) v.push(x);
    }
  }
  v.sort((a, b) => a - b);
  const q = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.floor(p * v.length)))] ?? 0;
  const p10 = q(0.1);
  const p90 = q(0.9);
  return { p10, p50: q(0.5), p90, ratio: p10 > 1e-9 ? p90 / p10 : Infinity };
}

const factors: Array<[string, (m: number, i: number) => number]> = [
  ['供給(海起源)', (m, i) => d.supplyOcean[m]![i]!],
  ['供給(陸再循環)', (m, i) => d.supplyLand[m]![i]!],
  ['供給(前線)', (m, i) => d.supplyStorm[m]![i]!],
  ['供給 合計', (m, i) => d.supplyOcean[m]![i]! + d.supplyLand[m]![i]! + d.supplyStorm[m]![i]!],
  ['持ち上げ ITCZ', (m, i) => d.liftItcz[m]![i]!],
  ['持ち上げ 前線', (m, i) => d.liftFrontal[m]![i]!],
  ['持ち上げ 地形', (m, i) => d.liftOrographic[m]![i]!],
  ['持ち上げ 収束', (m, i) => d.liftConvergence[m]![i]!],
  ['下降域の抑制', (m, i) => d.subsidenceResidual[m]![i]!],
  ['風上遮蔽', (m, i) => d.upwindBlock[m]![i]!],
  ['その他持ち上げ', (m, i) => d.liftOther[m]![i]!],
  ['後処理前 降水', (m, i) => d.preAdjustMm[m]![i]!],
  ['最終 降水', (m, i) => result.precipitation.monthlyPrecipMm[m]![i]!],
];

console.log('陸セル×12 か月の分位(p10 / p50 / p90 と p90/p10 比)');
console.log('因子'.padEnd(20, '　') + '       p10       p50       p90     比');
for (const [name, f] of factors) {
  const q = quantiles(f);
  console.log(
    name.padEnd(16, '　') +
      `${q.p10.toFixed(4).padStart(10)}${q.p50.toFixed(4).padStart(10)}` +
      `${q.p90.toFixed(4).padStart(10)}${(Number.isFinite(q.ratio) ? q.ratio.toFixed(1) : '∞').padStart(8)}`,
  );
}

// 実測(検証フィクスチャ)との比較 — 年降水の陸上分位。
// 観測は 2°、モデルは 1° なので、モデル側を 2° へ粗視化して同じ土俵で比べる。
{
  const clim = getClimObs();
  const f = Math.round(2 / grid.resolutionDeg);
  const model: number[] = [];
  const observed: number[] = [];
  for (let r2 = 0; r2 < clim.heightCells; r2++) {
    for (let c2 = 0; c2 < clim.widthCells; c2++) {
      const gi = r2 * clim.widthCells + c2;
      let obsSum = 0;
      for (let m = 0; m < 12; m++) obsSum += clim.monthlyPrecipitationMm[m]?.[gi] ?? 0;
      if (!Number.isFinite(obsSum) || obsSum <= 0) continue;
      // 対応する 1° 陸セルの平均(陸が無ければ捨てる)
      let s = 0;
      let n = 0;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const i = (r2 * f + dr) * W + (c2 * f + dc);
          if (!land[i]) continue;
          s += result.precipitation.annualPrecipMm[i] ?? 0;
          n++;
        }
      }
      if (n === 0) continue;
      model.push(s / n);
      observed.push(obsSum);
    }
  }
  const q = (arr: number[], p: number) => {
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(p * a.length))] ?? 0;
  };
  const line = (label: string, arr: number[]) =>
    console.log(
      `${label}: p10 ${q(arr, 0.1).toFixed(0)}mm / p25 ${q(arr, 0.25).toFixed(0)}mm / ` +
        `p50 ${q(arr, 0.5).toFixed(0)}mm / p75 ${q(arr, 0.75).toFixed(0)}mm / ` +
        `p90 ${q(arr, 0.9).toFixed(0)}mm`,
    );
  console.log(`\n陸セル ${model.length} 個(2° 粗視化)の年降水分布`);
  line('モデル', model);
  line('実測　', observed);
  // 300mm 未満(ケッペン B になりやすい水準)の割合
  const under = (arr: number[], t: number) => (arr.filter((x) => x < t).length / arr.length) * 100;
  console.log(
    `\n年降水 300mm 未満の割合: モデル ${under(model, 300).toFixed(1)}% / ` +
      `実測 ${under(observed, 300).toFixed(1)}%`,
  );
  console.log(
    `年降水 100mm 未満の割合: モデル ${under(model, 100).toFixed(1)}% / ` +
      `実測 ${under(observed, 100).toFixed(1)}%`,
  );
}

// 面積重み付きの平均も添える(比較の目安)
let wsum = 0;
let psum = 0;
for (let row = 0; row < grid.heightCells; row++) {
  const aw = areaWeightOfRow(grid, row);
  for (let col = 0; col < W; col++) {
    const i = row * W + col;
    if (!land[i]) continue;
    let s = 0;
    for (let m = 0; m < 12; m++) s += result.precipitation.monthlyPrecipMm[m]![i]!;
    psum += aw * s;
    wsum += aw;
  }
}
console.log(`陸平均年降水(面積重み): ${(psum / wsum).toFixed(0)}mm`);
