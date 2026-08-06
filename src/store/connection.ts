// パラメータ変更 → ワーカー実行 → 結果反映のオーケストレーション。
//
// 操作モデル(2026-08-03 の利用者判断):
//  - **パラメータを触っても計算は始まらない**。「計算」ボタンを押したときだけ。
//    1 回が数分かかるので、触るたびに GPU が回るのは割に合わない。
//  - そのかわり、実行中は途中結果が段ごとに届いて地図が育っていく。
//  - パラメータが地図より新しい状態(= ずれている)は UI で明示する。
//    自動実行しない以上、これを黙っていると古い地図を最新だと誤読する。
//
// single-in-flight + replay-latest(実行完了時に getState() を読み直して
// 最新入力で再実行する。教訓 §3 の実証済みパターン)。ワーカー側も
// 同じ規律で 1 本ずつ走らせる(src/worker/worker.ts)。

import type { PipelineBridge, RunHandle } from '@/worker/bridge';
import { useParamsStore } from './params';
import { useResultsStore } from './results';
import { useUiStore } from './ui';

export interface PipelineConnection {
  /** 計算を始める。実行中なら終わり次第もう一度走らせる */
  run(): void;
  /** 実行中のものを中断する */
  cancel(): void;
  disconnect(): void;
}

export function connectPipeline(bridge: PipelineBridge): PipelineConnection {
  let running = false;
  let rerunRequested = false;
  let disposed = false;
  let handle: RunHandle | null = null;

  const runLoop = async (): Promise<void> => {
    if (running) {
      rerunRequested = true;
      return;
    }
    running = true;
    try {
      do {
        rerunRequested = false;
        // 直近の状態を読み直す(古いクロージャを掴まない)
        const params = useParamsStore.getState().params;
        useResultsStore.getState().beginRun();
        // 「この地図はこのパラメータのもの」を記録する。以後パラメータが
        // 動いたら UI が「ずれている」と言えるようになる
        useUiStore.getState().markComputed(params);
        const h = bridge.run(params, (p, accelInfo) => {
          if (!disposed) useResultsStore.getState().setProgress(p, accelInfo);
        });
        handle = h;
        const outcome = await h.outcome;
        handle = null;
        const store = useResultsStore.getState();
        if (disposed) {
          // 破棄で終わった場合も**中断として記録する**。黙って抜けると
          // 「計算中」の表示だけが残る
          store.setCancelled();
          return;
        }
        if (outcome.status === 'done') store.setResult(outcome.output);
        else if (outcome.status === 'cancelled') store.setCancelled();
        else store.setError(outcome.message);
      } while (rerunRequested && !disposed);
    } finally {
      running = false;
      // **disposed でも必ず片付ける**。ストアはモジュール直下にあり、
      // 接続より長生きする(開発サーバの HMR で再マウントされても残る)。
      // ここを `if (!disposed)` で守っていたせいで、実行中に再マウントが
      // 起きると isComputing が true のまま固まり、ワーカーは終了済みなのに
      // 「計算中 16/26 年目」の表示だけが永久に残った(2026-08-03 実害)
      useResultsStore.getState().endRun();
    }
  };

  return {
    run(): void {
      if (handle) {
        // 実行中に押し直されたら、今のを捨てて最新パラメータで回し直す
        rerunRequested = true;
        handle.cancel();
      } else {
        void runLoop();
      }
    },
    cancel(): void {
      rerunRequested = false;
      handle?.cancel();
    },
    disconnect(): void {
      disposed = true;
      bridge.dispose();
      // 走っていなかった場合(runLoop の finally を通らない経路)でも
      // 表示を実態に合わせる。破棄した以上、計算は動いていない
      const store = useResultsStore.getState();
      if (store.isComputing) {
        store.setCancelled();
        store.endRun();
      }
    },
  };
}
