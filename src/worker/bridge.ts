// パイプラインブリッジ: 計算層を UI から切り離す境界。
// - DirectBridge: 同一スレッドで実行(テスト・ヘッドレス用)
// - WorkerBridge: Web Worker で実行 + 要求 id による陳腐化ガード
//   (教訓 §4 F1: 最新要求以外の応答は捨てる)

import type { PlanetParams } from '@/domain/planetParams';
import { runPipelineTimed } from '@/sim/pipeline';
import type { PipelineResult } from '@/sim/types';

/** 物理結果(決定的)と計測(時刻依存)の分離を保ったままワーカー境界を渡す */
export interface PipelineRunOutput {
  result: PipelineResult;
  stepTimingsMs: Record<string, number>;
}

export interface PipelineBridge {
  run(params: PlanetParams): Promise<PipelineRunOutput>;
  dispose(): void;
}

export class DirectBridge implements PipelineBridge {
  run(params: PlanetParams): Promise<PipelineRunOutput> {
    return Promise.resolve(runPipelineTimed(params));
  }
  dispose(): void {}
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  payload?: PipelineRunOutput;
  message?: string;
}

export class WorkerBridge implements PipelineBridge {
  private worker: Worker;
  private nextId = 1;
  private latestId = 0;
  private pending = new Map<number, { resolve: (r: PipelineRunOutput) => void; reject: (e: Error) => void }>();
  private disposed = false;

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const { id, ok, payload, message } = ev.data;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (this.disposed) return;
      // 陳腐化ガード: 最新要求以外の応答は無視する
      if (id !== this.latestId) return;
      if (ok && payload) entry.resolve(payload);
      else entry.reject(new Error(message ?? 'ワーカー計算に失敗しました'));
    };
    this.worker.onerror = (ev) => {
      for (const [, entry] of this.pending) entry.reject(new Error(ev.message));
      this.pending.clear();
    };
  }

  run(params: PlanetParams): Promise<PipelineRunOutput> {
    const id = this.nextId++;
    this.latestId = id;
    return new Promise<PipelineRunOutput>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, params });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.worker.terminate();
    this.pending.clear();
  }
}
