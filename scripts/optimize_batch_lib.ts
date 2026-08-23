// 較正の並列評価を worker_threads + EBM の GPU バッチに載せる口(主スレッド側)。
//
// なぜ要るか(2026-08-21 の掃引での実測を較正へ持ち込む):
//   較正の律速は GPU のコマンドキューで、子プロセスを増やしても頭打ちになる。
//   EBM を「同時に走っている評価」の軸で束ねる(src/sim/gpu/ebm_gpu_batch.ts)と
//   実効 5〜6 倍が出る。**較正の 1 バッチ(同時 N 点)がそのまま EBM の L=N**
//   になるので、座標降下の形をまったく変えずにそこだけ載せ替えられる。
//
// 何を変えていないか(ここが肝):
//   - 探索の手順(座標降下・スクリーニング・停滞判定・state 保存・来歴指紋・
//     ログ形式)は scripts/optimize.ts のまま。変えたのは「N 点を評価する
//     実行機構」だけ。
//   - 1 評価の中身は scripts/optimize_batch_worker.ts が
//     scripts/optimize_worker.ts と 1 対 1 で同じ手順を踏む。
//   - 記録は従来どおり**完了順**(旧経路は先に返した子から logEval していた)。
//
// 実行機構の本体は scripts/gpu_batch_pool.ts(掃引 scripts/sweep_batch_lib.ts と共有)。
//
// 運用上の注意(2026-08-23 の実測から):
//   - **--parallel は偶数が得**。1 バッチの点数は `2 × ceil(N/2)` なので、
//     N が偶数なら点数 = N = スレッド数でぴったり束ねられ(EBM は毎回 L=N)、
//     N が奇数だと 1 点あぶれて**その 1 点の EBM だけ単発になる**。
//     実測(N=3、12 評価)で束ねは L=3 が 10 回・L=2 が 2 回・L=1 が 14 回。
//   - **メモリは 1 プロセスに集まる**。子プロセス N 本ならヒープも N 個だったが、
//     worker_threads はスレッドごとにモジュールを持ちつつ**同じプロセスの
//     ヒープ上限**を分け合う。1° で N を大きく取るときは
//     `NODE_OPTIONS=--max-old-space-size=8192` 等を見ておくこと。
//
// **このモジュールは GPU デバイスを破棄しない。** 呼び出し側がプロセス終了前に
// releaseGpu()(src/sim/gpu/device_node.ts)を必ず呼ぶこと(でないと exit 139)。

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGpuBatchPool, type GpuBatchPool } from './gpu_batch_pool';
import type { OptimizeJob, OptimizeOutcome } from './optimize_batch_protocol';

export type OptimizeEvalPool = GpuBatchPool<OptimizeJob, OptimizeOutcome>;

export interface OptimizeEvalPoolOptions {
  /** EBM を束ねる窓(ms)。既定は gpu_batch_pool の EBM_BATCH_WINDOW_MS */
  windowMs?: number | undefined;
  /** 束ねの実績を stderr に流すか(既定 true。較正は長時間走るので実績を残す) */
  progress?: boolean | undefined;
}

/**
 * 較正の評価プールを立てる。スレッドは close() まで生き続ける
 * (較正は同じプールへ何百バッチも投げるので、毎回立て直すと tsx の起動費を
 * 払い続けることになる)。
 */
export async function createOptimizeEvalPool(
  threads: number,
  options: OptimizeEvalPoolOptions = {},
): Promise<OptimizeEvalPool> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return createGpuBatchPool<OptimizeJob, OptimizeOutcome>({
    workerEntry: path.join(here, 'optimize_batch_worker.ts'),
    threads,
    windowMs: options.windowMs,
    progress: options.progress ?? true,
  });
}
