// 事前登録実験: EBM の反復順序(行優先 Gauss-Seidel / 赤黒)と
// スイープ数を振り、採点がどれだけ動くかを測る。
//
// 事前登録: docs/実験記録_EBM赤黒順序_2026-08-01.md
// 判定基準は実行前に固定してある。ここでは数字を出すだけで、しきい値は触らない。
//
// 実行: npx tsx scripts/exp_ebm_order.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { evaluateResult } from './optimize_lib';
import { EBM_SOLVER } from '../src/sim/step05_temperature';
import { openAccel } from './accel_cli';
import { areaWeightOfRow } from '../src/domain/grid';
import type { PipelineResult } from '../src/sim/types';

const accel = await openAccel();

interface Case {
  label: string;
  order: 'gauss-seidel' | 'red-black';
  sweeps: number;
}
const CASES: Case[] = [
  { label: 'GS 8(現行)', order: 'gauss-seidel', sweeps: 8 },
  { label: 'GS 16', order: 'gauss-seidel', sweeps: 16 },
  { label: 'GS 32', order: 'gauss-seidel', sweeps: 32 },
  { label: '赤黒 8', order: 'red-black', sweeps: 8 },
  { label: '赤黒 16', order: 'red-black', sweeps: 16 },
];

const results: { c: Case; r: PipelineResult; s: ReturnType<typeof evaluateResult> }[] = [];
for (const c of CASES) {
  EBM_SOLVER.order = c.order;
  EBM_SOLVER.sweeps = c.sweeps;
  const t0 = Date.now();
  const r = await runPipeline(EARTH_PARAMS, accel.opts);
  const s = evaluateResult(r);
  results.push({ c, r, s });
  console.log(
    `${c.label.padEnd(14, '　')} 大分類 ${s.majorPct.toFixed(2)} / 詳細 ${s.detailPct.toFixed(2)} / ` +
      `ゲート ${s.gates} / 気温RMSE ${s.tempRmse.toFixed(3)} / 降水RMSE ${Math.round(s.precipRmse)} ` +
      `(${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );
}
accel.close();
EBM_SOLVER.order = 'gauss-seidel';
EBM_SOLVER.sweeps = 0;

// ---- 基準(GS 8)との場の差 ----
const base = results[0]!;
const grid = base.r.context.grid;
console.log('\n=== GS 8 との気温場の差 ===');
for (const { c, r } of results.slice(1)) {
  let maxAbs = 0;
  let sum = 0;
  let wsum = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const w = areaWeightOfRow(grid, row);
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      const d = Math.abs(
        (r.temperature.annualMeanC[i] ?? 0) - (base.r.temperature.annualMeanC[i] ?? 0),
      );
      if (d > maxAbs) maxAbs = d;
      sum += w * d;
      wsum += w;
    }
  }
  console.log(
    `${c.label.padEnd(14, '　')} 面積平均 |Δ気温| ${(sum / wsum).toFixed(4)}°C / 最大 ${maxAbs.toFixed(3)}°C`,
  );
}

// ---- 事前登録した判定 ----
const rb8 = results.find((x) => x.c.label === '赤黒 8')!;
const dMajor = rb8.s.majorPct - base.s.majorPct;
const dDetail = rb8.s.detailPct - base.s.detailPct;
const dTemp = rb8.s.tempRmse - base.s.tempRmse;
console.log('\n=== 事前登録した判定(赤黒 8 vs GS 8)===');
console.log(`  大分類の変化   ${dMajor >= 0 ? '+' : ''}${dMajor.toFixed(2)}pt(棄却は < -0.30)`);
console.log(`  詳細の変化     ${dDetail >= 0 ? '+' : ''}${dDetail.toFixed(2)}pt`);
console.log(`  ゲート         ${base.s.gates} → ${rb8.s.gates}(棄却は < 13)`);
console.log(`  気温RMSE の変化 ${dTemp >= 0 ? '+' : ''}${dTemp.toFixed(3)}°C(棄却は > +0.050)`);
const rejected = dMajor < -0.3 || rb8.s.gates < 13 || dTemp > 0.05;
console.log(`\n判定: ${rejected ? '❌ 棄却 — 赤黒順序は採用しない' : '✅ 採用可'}`);
