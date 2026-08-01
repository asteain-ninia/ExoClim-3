// 残差基準(EBM_SOLVE_TOLERANCE_C)で反復を止めたとき、
// 実際に何スイープ要るのか・採点がどうなるのかを測る。
//
// 事前登録: docs/実験記録_EBM赤黒順序_2026-08-01.md
// ここで得たスイープ数が、EBM の GPU 化の設計(ディスパッチ回数)を決める。
//
// 実行: npx tsx scripts/exp_ebm_tolerance.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { evaluateResult } from './optimize_lib';
import {
  EBM_SOLVER,
  EBM_SOLVER_STATS,
  EBM_SOLVE_TOLERANCE_C,
  EBM_MAX_SWEEPS,
} from '../src/sim/step05_temperature';
import { openAccel } from './accel_cli';

const accel = await openAccel();
console.log(`許容差 ${EBM_SOLVE_TOLERANCE_C}°C / 上限 ${EBM_MAX_SWEEPS} スイープ\n`);

for (const order of ['gauss-seidel', 'red-black'] as const) {
  EBM_SOLVER.order = order;
  EBM_SOLVER.sweeps = 0; // 残差基準
  EBM_SOLVER_STATS.totalSweeps = 0;
  EBM_SOLVER_STATS.steps = 0;
  EBM_SOLVER_STATS.maxSweeps = 0;
  EBM_SOLVER_STATS.capHits = 0;
  const t0 = Date.now();
  const r = await runPipeline(EARTH_PARAMS, accel.opts);
  const s = evaluateResult(r);
  const st = EBM_SOLVER_STATS;
  console.log(
    `${order.padEnd(13)}: 大分類 ${s.majorPct.toFixed(2)} / 詳細 ${s.detailPct.toFixed(2)} / ` +
      `ゲート ${s.gates} / 気温RMSE ${s.tempRmse.toFixed(3)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
  );
  console.log(
    `               スイープ 平均 ${(st.totalSweeps / Math.max(1, st.steps)).toFixed(1)} / ` +
      `最大 ${st.maxSweeps} / 上限到達 ${st.capHits} 回(全 ${st.steps} 時間ステップ)`,
  );
}
accel.close();
EBM_SOLVER.order = 'gauss-seidel';
EBM_SOLVER.sweeps = 8;
