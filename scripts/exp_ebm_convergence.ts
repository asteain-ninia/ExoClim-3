// EBM の内側の線形解が、スイープ数を増やすと収束するのかを確かめる。
//
// 動機(2026-08-01、赤黒順序の実験で偶然発見):
//   GS 8 → 16 → 32 で気温場が面積平均 1.25 → 1.78°C 動き、大分類が
//   74.32 → 73.39 → 72.54 と**単調に悪化**した。つまり
//   「8 スイープで打ち切る」という実装詳細が答えを決めており、
//   較正はその未収束状態に合わせて行われている疑いがある。
//
//   GS_SWEEPS = 8 は constants.ts にも spec にも無い。CLAUDE.md が禁じる
//   **隠しパラメータ**そのものかどうかを、ここで確かめる。
//
// 測ること:
//   (a) スイープ数を増やすと場は収束するのか(収束先はあるのか)
//   (b) 収束先と 8 スイープの答えはどれだけ違うのか
//
// 実行: npx tsx scripts/exp_ebm_convergence.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { evaluateResult } from './optimize_lib';
import { EBM_SOLVER } from '../src/sim/step05_temperature';
import { openAccel } from './accel_cli';
import { areaWeightOfRow } from '../src/domain/grid';

const accel = await openAccel();
const SWEEPS = [8, 16, 32, 64, 128, 256];

const fields: { n: number; t: Float32Array }[] = [];
for (const n of SWEEPS) {
  EBM_SOLVER.order = 'gauss-seidel';
  EBM_SOLVER.sweeps = n;
  const t0 = Date.now();
  const r = await runPipeline(EARTH_PARAMS, accel.opts);
  const s = evaluateResult(r);
  fields.push({ n, t: Float32Array.from(r.temperature.annualMeanC) });
  console.log(
    `スイープ ${String(n).padStart(3)}: 大分類 ${s.majorPct.toFixed(2)} / 詳細 ${s.detailPct.toFixed(2)} / ` +
      `ゲート ${s.gates} / 気温RMSE ${s.tempRmse.toFixed(3)} / 陸平均降水 ${Math.round(s.landMeanMm)}mm ` +
      `(${((Date.now() - t0) / 1000).toFixed(0)}s)`,
  );
  if (fields.length >= 2) {
    const grid = r.context.grid;
    const prev = fields[fields.length - 2]!;
    let sum = 0;
    let wsum = 0;
    let maxAbs = 0;
    for (let row = 0; row < grid.heightCells; row++) {
      const w = areaWeightOfRow(grid, row);
      for (let col = 0; col < grid.widthCells; col++) {
        const i = row * grid.widthCells + col;
        const d = Math.abs((fields[fields.length - 1]!.t[i] ?? 0) - (prev.t[i] ?? 0));
        if (d > maxAbs) maxAbs = d;
        sum += w * d;
        wsum += w;
      }
    }
    console.log(
      `            前段(${prev.n})との差: 面積平均 ${(sum / wsum).toFixed(4)}°C / 最大 ${maxAbs.toFixed(3)}°C`,
    );
  }
}
accel.close();
EBM_SOLVER.sweeps = 0;
console.log(
  '\n差が段階的に小さくなっていれば収束している。' +
    '止まらないなら反復そのものが収束していない(別の欠陥)。',
);
