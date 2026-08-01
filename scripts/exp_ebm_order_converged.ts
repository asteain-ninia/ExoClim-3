// 収束させた線形解では、反復順序(行優先 Gauss-Seidel / 赤黒)が
// 答えに残らないことを確かめる。
//
// 論拠: 線形系 Ax = b の解は一意。GS も赤黒 GS も同じ解へ収束する反復法なので、
// **十分に反復すれば順序は答えに影響しない**。8 スイープで差が出たのは
// 単に未収束だったから(docs/実験記録_EBM赤黒順序_2026-08-01.md)。
//
// これが確認できれば、「収束させる」ことが同時に
//   (a) 隠しパラメータ(GS_SWEEPS = 8)の除去
//   (b) EBM の GPU 化(赤黒は同色内が完全並列)
// の両方を開く。
//
// 実行: npx tsx scripts/exp_ebm_order_converged.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { evaluateResult } from './optimize_lib';
import { EBM_SOLVER } from '../src/sim/step05_temperature';
import { openAccel } from './accel_cli';
import { areaWeightOfRow } from '../src/domain/grid';

const accel = await openAccel();
const SWEEPS = Number(process.argv[2] ?? 256);

const runs: { label: string; t: Float32Array }[] = [];
for (const order of ['gauss-seidel', 'red-black'] as const) {
  EBM_SOLVER.order = order;
  EBM_SOLVER.sweeps = SWEEPS;
  const t0 = Date.now();
  const r = await runPipeline(EARTH_PARAMS, accel.opts);
  const s = evaluateResult(r);
  runs.push({ label: order, t: Float32Array.from(r.temperature.annualMeanC) });
  console.log(
    `${order.padEnd(13)} ${SWEEPS} スイープ: 大分類 ${s.majorPct.toFixed(2)} / 詳細 ${s.detailPct.toFixed(2)} / ` +
      `気温RMSE ${s.tempRmse.toFixed(4)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
  );
  if (runs.length === 2) {
    const grid = r.context.grid;
    let sum = 0;
    let wsum = 0;
    let maxAbs = 0;
    for (let row = 0; row < grid.heightCells; row++) {
      const w = areaWeightOfRow(grid, row);
      for (let col = 0; col < grid.widthCells; col++) {
        const i = row * grid.widthCells + col;
        const d = Math.abs((runs[1]!.t[i] ?? 0) - (runs[0]!.t[i] ?? 0));
        if (d > maxAbs) maxAbs = d;
        sum += w * d;
        wsum += w;
      }
    }
    console.log(
      `\n順序による差: 面積平均 ${(sum / wsum).toExponential(3)}°C / 最大 ${maxAbs.toExponential(3)}°C`,
    );
    console.log(
      maxAbs < 0.01
        ? '→ 収束後は順序が答えに残らない。赤黒(= GPU 並列)を使ってよい'
        : '→ まだ順序が残っている。スイープ数を増やして再確認する',
    );
  }
}
accel.close();
EBM_SOLVER.order = 'gauss-seidel';
EBM_SOLVER.sweeps = 0;
