// 較正の評価ワーカー(worker_threads 版)— 1 スレッドが 1 評価ずつ
// フルパイプラインを回し、リーン採点した Scores を主スレッドへ返す。
// 主スレッドは scripts/optimize_batch_lib.ts(親は scripts/optimize.ts)。
//
// **中身は scripts/optimize_worker.ts(子プロセス版)と 1 対 1 で同じ。**
// 違うのは「行を stdin/stdout でやり取りする」か「postMessage でやり取りする」か、
// と GPU をこのスレッドが持たない(代理 accel で主スレッドへ投げる)ことだけ。
// 評価そのものの手順を変えたら、旧経路との同値
// (scripts/diag_optimize_batch_equiv.ts)が壊れる。
//
// 実行機構(代理 accel・直列の仕事鎖)は scripts/gpu_batch_worker_base.ts。

import { runBatchWorker } from './gpu_batch_worker_base';
import { runPipeline } from '../src/sim/pipeline';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { disqualifyIfUnsound, evaluateResult, UNSOLVED_FITNESS } from './optimize_lib';
import { EBM_SOLVER, EBM_SOLVER_STATS } from '../src/sim/step05_temperature';
import { optimizeRunParams } from './optimize_cheap';
import type { OptimizeJob, OptimizeOutcome } from './optimize_batch_protocol';

// 較正では反復回数・緩和年数を**自動で増やさない**(optimize_worker.ts と同じ)。
// 増やすと、収束しにくい領域が「高くつく」だけで探索対象に残ってしまう。
// 本来そこは棄却されるべきなので、予算を固定して未収束は失格にする。
EBM_SOLVER.adaptive = false;

// ウォームスタートは **2026-08-06 に実測で棄却**した(54% 遅くなった)。
// 配管は残してあるが較正では渡さない。理由は
// docs/実験記録_ウォームスタート_2026-08-06.md を参照。

runBatchWorker<OptimizeJob, OptimizeOutcome>(async (job, accel) => {
  Object.assign(MODEL_CONSTANTS, job.vector);
  const t0 = Date.now();
  // 統計は**評価ごとに**ゼロへ戻す。maxSweeps は最大値の累積なので、
  // 戻さないと「この評価が使った反復」ではなく「起動以来の最大」になる
  EBM_SOLVER_STATS.capHits = 0;
  EBM_SOLVER_STATS.maxSweeps = 0;
  EBM_SOLVER_STATS.fullCapacityYears = 0;
  const result = await runPipeline(optimizeRunParams(), { accel });
  const scores = evaluateResult(result, job.holdoutFold);
  // 予算内で解けなかった定数ベクトルは**失格**にする(減点ではない)。
  // capHits は evaluateNumericalSoundness が見ない量なのでここに残す。
  // それ以外の 5 系統は disqualifyIfUnsound が見る(2026-08-14)。
  if (EBM_SOLVER_STATS.capHits > 0) scores.fitness = UNSOLVED_FITNESS;
  disqualifyIfUnsound(scores);
  return {
    scores,
    sec: Math.round((Date.now() - t0) / 100) / 10,
    ebmYears: EBM_SOLVER_STATS.fullCapacityYears,
    ebmIters: EBM_SOLVER_STATS.maxSweeps,
  };
});
