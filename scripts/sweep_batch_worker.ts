// 掃引バッチ実行器の worker_threads 側 — 1 スレッドが 1 水準ずつ
// フルパイプラインを CPU で回す。
//
// 実行機構(代理 accel・主スレッドへの GPU 要求・直列の仕事鎖)は
// scripts/gpu_batch_worker_base.ts に一般化した(2026-08-23、較正と共有)。
// ここに残るのは「1 水準を測る」という掃引固有の中身だけ。
//
// 測定の実体は既存の measureLevel(scripts/sweep_lib.ts)で、プロセス並列の
// ワーカー(scripts/sweep_worker.ts)と同じもの。違いは accel の中身だけ。
// 検証専用の安い設定(SWEEP_GRID_DEG 等)や SWEEP_OVERRIDE は環境変数で
// sweep_lib の読み込み時に掛かる — worker_threads は親の env を継承するので
// 全スレッドに同じ条件が効く。
//
// **`EBM_SOLVER.adaptive` は触らない**(scripts/sweep_worker.ts の注記と同じ。
// 較正から `adaptive = false` を写して v3 が 0.02〜0.06 ずれた前科がある)。

import { runBatchWorker } from './gpu_batch_worker_base';
import { measureLevel, type LevelReport } from './sweep_lib';
import type { SweepJob } from './sweep_batch_protocol';

runBatchWorker<SweepJob, LevelReport>((job, accel) =>
  measureLevel(job.key, job.value, job.targets, { accel }),
);
