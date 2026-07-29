// パラメータ変更 → ワーカー実行 → 結果反映のオーケストレーション。
// single-in-flight + replay-latest(実行完了時に getState() を読み直して
// 最新入力で再実行する。教訓 §3 の実証済みパターン)。

import type { PipelineBridge } from '@/worker/bridge';
import { useParamsStore } from './params';
import { useResultsStore } from './results';

const DEBOUNCE_MS = 300;

export function connectPipeline(bridge: PipelineBridge): () => void {
  let running = false;
  let rerunRequested = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const runLoop = async () => {
    if (running) {
      rerunRequested = true;
      return;
    }
    running = true;
    useResultsStore.getState().setComputing(true);
    try {
      do {
        rerunRequested = false;
        // 直近の状態を読み直す(古いクロージャを掴まない)
        const params = useParamsStore.getState().params;
        try {
          const result = await bridge.run(params);
          if (disposed) return;
          useResultsStore.getState().setResult(result);
        } catch (e) {
          if (disposed) return;
          useResultsStore.getState().setError(e instanceof Error ? e.message : String(e));
        }
      } while (rerunRequested && !disposed);
    } finally {
      if (!disposed) useResultsStore.getState().setComputing(false);
      running = false;
    }
  };

  const schedule = () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runLoop();
    }, DEBOUNCE_MS);
  };

  const unsubscribe = useParamsStore.subscribe(() => schedule());
  // 初回実行
  void runLoop();

  return () => {
    disposed = true;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    unsubscribe();
    bridge.dispose();
  };
}
