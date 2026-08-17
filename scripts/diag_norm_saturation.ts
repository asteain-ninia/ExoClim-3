// 診断: **norm 系の定数は形骸化していないか — 被ゲート量の分布との突き合わせ。**
//
// なぜ要るか(2026-08-17):
//   `eastReliefSupplyNorm = 0.51` に対し亜熱帯の夏の供給は 8〜10 で、
//   `min(1, supply/norm)` が**常時飽和 = ゲートが事実上無効**と分かった。
//   同じ型は 2026-08-15 にも(`moistureConvergenceNorm` 低すぎ)見つかっている。
//   保存型への移行などで**尺度が変わると norm は黙って形骸化する**。
//   ゲートを頼りに設計する前に、全 norm を分布と並べて棚卸しする。
//
// 実行: npx tsx scripts/diag_norm_saturation.ts

import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow } from '../src/domain/grid';
import { openAccel } from './accel_cli';

const K = MODEL_CONSTANTS as unknown as Record<string, number>;

function quantiles(vals: Float64Array, n: number): { q05: number; q50: number; q95: number } {
  const a = vals.slice(0, n).sort();
  const at = (p: number): number => a[Math.min(n - 1, Math.floor(p * n))] ?? 0;
  return { q05: at(0.05), q50: at(0.5), q95: at(0.95) };
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

  // 被ゲート量ごとに、陸セル×月の標本を集める
  const cap = grid.cellCount * MONTHS_PER_YEAR;
  const supply = new Float64Array(cap);
  const conv = new Float64Array(cap);
  const precip = new Float64Array(cap);
  let n = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    if (Math.abs(lat) > 60) continue;
    for (let col = 0; col < WC; col++) {
      const i = row * WC + col;
      if (!land[i]) continue;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        supply[n] =
          (d.supplyOcean?.[m]?.[i] ?? 0) + (d.supplyLand?.[m]?.[i] ?? 0) + (d.supplyStorm[m]?.[i] ?? 0);
        conv[n] = d.convergenceIndex[m]?.[i] ?? 0;
        precip[n] = r.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;
        n++;
      }
    }
  }

  const sat = (vals: Float64Array, norm: number): number => {
    let c = 0;
    for (let k = 0; k < n; k++) if ((vals[k] ?? 0) >= norm) c++;
    return (100 * c) / Math.max(1, n);
  };

  const sq = quantiles(supply, n);
  const cq = quantiles(conv, n);
  const pq = quantiles(precip, n);

  console.log(`陸セル×月の標本 ${n} 件(|lat| ≤ 60°)\n`);
  console.log('被ゲート量の分布      5%       50%      95%');
  console.log(`供給 supply        ${sq.q05.toFixed(2).padStart(7)} ${sq.q50.toFixed(2).padStart(8)} ${sq.q95.toFixed(2).padStart(8)}`);
  console.log(`収束指数 convIdx   ${cq.q05.toFixed(2).padStart(7)} ${cq.q50.toFixed(2).padStart(8)} ${cq.q95.toFixed(2).padStart(8)}`);
  console.log(`月降水 (mm)        ${pq.q05.toFixed(1).padStart(7)} ${pq.q50.toFixed(1).padStart(8)} ${pq.q95.toFixed(1).padStart(8)}`);
  console.log('');
  console.log('norm 定数                          値       飽和率(量 ≥ norm)   判定');
  const rows: Array<[string, number, Float64Array]> = [
    ['eastReliefSupplyNorm', K['eastReliefSupplyNorm'] ?? 0, supply],
    ['itczLiftSupplyNorm', K['itczLiftSupplyNorm'] ?? 0, supply],
    ['warmHumidSupplyNorm', K['warmHumidSupplyNorm'] ?? 0, supply],
    ['moistureConvergenceNorm', K['moistureConvergenceNorm'] ?? 0, conv],
    ['convergenceWetnessNorm', K['convergenceWetnessNorm'] ?? 0, supply],
    ['landCloudSupplyNormMm', K['landCloudSupplyNormMm'] ?? 0, precip],
  ];
  for (const [name, norm, vals] of rows) {
    const s = sat(vals, norm);
    const verdict = s > 90 ? '**ほぼ常時飽和 = 形骸化**' : s < 5 ? '**ほぼ常時ゼロ = 死んでいる**' : '生きている';
    console.log(`${name.padEnd(32)} ${norm.toFixed(3).padStart(8)} ${s.toFixed(1).padStart(10)} %   ${verdict}`);
  }
  console.log(
    '\n読み: 飽和率 >90% のゲートは「常に全開」でゲートの意味が無い。\n' +
      '  <5% は「常に閉」で機構ごと死んでいる。どちらも 5〜95% 分位の中に\n' +
      '  norm を置き直す(較正で動かすなら範囲もそこへ)。',
  );
}

void main();
