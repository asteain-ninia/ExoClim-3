// 掃引バッチ実行器の主スレッド側: 水準の worker_threads 並列 + EBM の GPU バッチ束ね。
//
// **実行機構そのものは scripts/gpu_batch_pool.ts へ一般化した**(2026-08-23、
// 較正 scripts/optimize_batch_lib.ts と共有するため)。ここに残るのは
// 「水準の並びをプールへ流し、LevelReport の並びで返す」という掃引固有の口だけで、
// スレッド・束ね窓・GPU 直列鎖・単発フォールバックの挙動は一般化の前後で
// 変えていない(同値検証は scripts/diag_sweep_batch_equiv.ts)。
//
// **このモジュールは GPU デバイスを破棄しない。** 呼び出し側がプロセス終了前に
// releaseGpu()(src/sim/gpu/device_node.ts)を必ず呼ぶこと(でないと exit 139)。

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGpuBatchPool, EBM_BATCH_WINDOW_MS } from './gpu_batch_pool';
import type { LevelReport } from './sweep_lib';
import type { SweepJob } from './sweep_batch_protocol';

export { EBM_BATCH_WINDOW_MS };

export interface RunSweepBatchOptions {
  /** スレッド数(既定は水準数と 8 の小さいほう) */
  threads?: number | undefined;
  /** EBM を束ねる窓(ms)。既定 EBM_BATCH_WINDOW_MS */
  windowMs?: number | undefined;
  /** 水準が 1 つ終わるたびに呼ぶ(idx は values の添字)。印字は呼び出し側の仕事 */
  onReport?: ((idx: number, report: LevelReport) => void) | undefined;
  /** 進捗の注記を stderr に流すか(既定 true) */
  progress?: boolean | undefined;
}

/**
 * バッチ実行器で掃引を回す。戻り値は values と同じ並びの測定結果。
 *
 * 定数の上書き(掃引対象の値)は worker スレッド側の MODEL_CONSTANTS にしか
 * 起きない — 主スレッドは定数を触らない(触っても worker には伝わらないし、
 * GPU 側は定数を fields/constants 経由でしか見ない)。
 */
export async function runSweepBatch(
  key: string,
  values: number[],
  targets: string[],
  options: RunSweepBatchOptions = {},
): Promise<LevelReport[]> {
  const nThreads = Math.max(
    1,
    Math.min(options.threads ?? Math.min(values.length, 8), values.length),
  );
  const progress = options.progress ?? true;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pool = await createGpuBatchPool<SweepJob, LevelReport>({
    workerEntry: path.join(here, 'sweep_batch_worker.ts'),
    threads: nThreads,
    windowMs: options.windowMs,
    progress,
  });
  let done = 0;
  try {
    return await pool.run(
      values.map((value) => ({ key, value, targets })),
      (idx, report) => {
        done++;
        if (progress) {
          process.stderr.write(
            `[掃引バッチ] ${key}=${values[idx]} 完了 ${report.sec.toFixed(0)}s ` +
              `(${done}/${values.length})\n`,
          );
        }
        options.onReport?.(idx, report);
      },
    );
  } finally {
    await pool.close();
  }
}
