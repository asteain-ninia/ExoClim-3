// パイプラインブリッジ: 計算層を UI から切り離す境界。
// - DirectBridge: 同一スレッドで実行(テスト・ヘッドレス用)
// - WorkerBridge: Web Worker で実行 + 要求 id による陳腐化ガード
//   (教訓 §4 F1: 最新要求以外の応答は捨てる)

import type { PlanetParams } from '@/domain/planetParams';
import { runPipelineTimed } from '@/sim/pipeline';
import { isCancelled, type CancelToken, type RunProgress } from '@/sim/run_control';
import type { PipelineRunOutput, WorkerRequest, WorkerResponse } from './protocol';

export type { PipelineRunOutput } from './protocol';

/** 実行の結末。中断は失敗ではないので型で分ける */
export type RunOutcome =
  | { status: 'done'; output: PipelineRunOutput }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export interface RunHandle {
  /** 結末。中断してもこの Promise は reject しない(cancelled で解決する) */
  readonly outcome: Promise<RunOutcome>;
  /** 中断を要求する。実際に止まるのは計算側の次の刻み(約 1 秒以内) */
  cancel(): void;
}

export interface PipelineBridge {
  run(
    params: PlanetParams,
    onProgress?: (p: RunProgress, accelInfo?: string) => void,
  ): RunHandle;
  dispose(): void;
}

/**
 * 同一スレッド実行。テストとヘッドレス検証用。
 * 中断は効くが、**進捗の受信中に UI は固まる**(ワーカーが無いため)。
 */
export class DirectBridge implements PipelineBridge {
  run(
    params: PlanetParams,
    onProgress?: (p: RunProgress, accelInfo?: string) => void,
  ): RunHandle {
    const token = { cancelled: false };
    const outcome = (async (): Promise<RunOutcome> => {
      try {
        const out = await runPipelineTimed(params, {
          signal: token as CancelToken,
          ...(onProgress ? { onProgress: (p: RunProgress) => onProgress(p) } : {}),
        });
        return {
          status: 'done',
          output: {
            result: out.result,
            stepTimingsMs: out.stepTimingsMs,
            accelInfo: 'CPU 実装(同一スレッド)',
            cacheHits: [],
            cacheMisses: [],
          },
        };
      } catch (e) {
        if (isCancelled(e)) return { status: 'cancelled' };
        return { status: 'error', message: e instanceof Error ? e.message : String(e) };
      }
    })();
    return {
      outcome,
      cancel: () => {
        token.cancelled = true;
      },
    };
  }
  dispose(): void {}
}

interface Pending {
  settle: (o: RunOutcome) => void;
  onProgress: ((p: RunProgress, accelInfo?: string) => void) | undefined;
}

export class WorkerBridge implements PipelineBridge {
  private worker: Worker;
  private nextId = 1;
  private latestId = 0;
  private pending = new Map<number, Pending>();
  private disposed = false;

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>): void => {
      if (this.disposed) return;
      const msg = ev.data;
      const entry = this.pending.get(msg.id);
      if (!entry) return;

      if (msg.type === 'progress') {
        // 陳腐化ガード: 最新要求以外の途中経過は捨てる(古い場が最新の
        // 表示を上書きしないように)
        if (msg.id !== this.latestId) return;
        entry.onProgress?.(msg.progress, msg.accelInfo);
        return;
      }

      this.pending.delete(msg.id);
      if (msg.type === 'done') {
        // 陳腐化ガード: 最新要求以外の**結果**は捨てる。ただし呼び出し側の
        // Promise は必ず解決させる(でないと待ちが残る)
        entry.settle(
          msg.id === this.latestId
            ? { status: 'done', output: msg.payload }
            : { status: 'cancelled' },
        );
      } else if (msg.type === 'cancelled') {
        entry.settle({ status: 'cancelled' });
      } else {
        entry.settle({ status: 'error', message: msg.message });
      }
    };
    this.worker.onerror = (ev): void => {
      const message = ev.message || 'ワーカーが異常終了しました';
      for (const [, entry] of this.pending) entry.settle({ status: 'error', message });
      this.pending.clear();
    };
  }

  run(
    params: PlanetParams,
    onProgress?: (p: RunProgress, accelInfo?: string) => void,
  ): RunHandle {
    const id = this.nextId++;
    this.latestId = id;
    let settle!: (o: RunOutcome) => void;
    const outcome = new Promise<RunOutcome>((resolve) => {
      settle = resolve;
    });
    this.pending.set(id, { settle, onProgress });
    const req: WorkerRequest = { type: 'run', id, params };
    this.worker.postMessage(req);
    return {
      outcome,
      cancel: () => {
        if (this.disposed) return;
        const cancelMsg: WorkerRequest = { type: 'cancel', id };
        this.worker.postMessage(cancelMsg);
      },
    };
  }

  dispose(): void {
    this.disposed = true;
    this.worker.terminate();
    for (const [, entry] of this.pending) entry.settle({ status: 'cancelled' });
    this.pending.clear();
  }
}
