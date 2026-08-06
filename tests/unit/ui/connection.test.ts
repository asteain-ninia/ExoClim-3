// 実行のオーケストレーション(store/connection.ts)の性質。
//
// ここで守りたいのは 1 点:
// **どんな終わり方をしても「計算中」の表示が残らないこと**。
//
// 2026-08-03 の実害: 実行中に接続が破棄される(開発サーバの HMR による
// 再マウント、コンポーネントのアンマウント)と isComputing が true のまま
// 固まった。ストアはモジュール直下にあり接続より長生きするので、
// ワーカーが終了済みでも「計算中 16/26 年目」の表示だけが永久に残る。
// 利用者からは「重いのか壊れたのか分からない」状態になる。

import { beforeEach, describe, expect, it } from 'vitest';
import { connectPipeline } from '@/store/connection';
import { useResultsStore } from '@/store/results';
import { useUiStore } from '@/store/ui';
import type { PipelineBridge, RunHandle, RunOutcome } from '@/worker/bridge';

/** 手動で結末を決められる偽ブリッジ(実際の計算はしない) */
function makeBridge(): {
  bridge: PipelineBridge;
  settle: (o: RunOutcome) => void;
  disposed: () => boolean;
  cancelled: () => number;
} {
  let settleFn: ((o: RunOutcome) => void) | null = null;
  let isDisposed = false;
  let cancelCount = 0;
  const bridge: PipelineBridge = {
    run(): RunHandle {
      const outcome = new Promise<RunOutcome>((resolve) => {
        settleFn = resolve;
      });
      return {
        outcome,
        cancel: () => {
          cancelCount++;
        },
      };
    },
    dispose(): void {
      isDisposed = true;
      // 実装(WorkerBridge)と同じく、破棄したら待ちを中断で解く
      settleFn?.({ status: 'cancelled' });
    },
  };
  return {
    bridge,
    settle: (o) => settleFn?.(o),
    disposed: () => isDisposed,
    cancelled: () => cancelCount,
  };
}

/** マイクロタスクを流し切る */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('実行の後始末', () => {
  beforeEach(() => {
    useResultsStore.setState({
      isComputing: false,
      progress: null,
      draft: null,
      wasCancelled: false,
      lastError: null,
    });
    useUiStore.setState({ computedParams: null });
  });

  it('実行中に接続を破棄しても「計算中」が残らない(2026-08-03 の退行防止)', async () => {
    const { bridge, disposed } = makeBridge();
    const conn = connectPipeline(bridge);
    conn.run();
    await flush();
    expect(useResultsStore.getState().isComputing).toBe(true);

    // 開発サーバの HMR や アンマウントで起きるのがこれ
    conn.disconnect();
    await flush();

    expect(disposed()).toBe(true);
    // **ここが本体**: 破棄したのに計算中のままにしない
    expect(useResultsStore.getState().isComputing).toBe(false);
    // 中断として記録されている(黙って消えない)
    expect(useResultsStore.getState().wasCancelled).toBe(true);
  });

  it('正常終了で計算中が解ける', async () => {
    const { bridge, settle } = makeBridge();
    const conn = connectPipeline(bridge);
    conn.run();
    await flush();
    settle({
      status: 'done',
      output: {
        result: { diagnostics: { status: 'ok' } } as never,
        stepTimingsMs: { a: 1 },
        accelInfo: 'test',
        cacheHits: [],
        cacheMisses: [],
      },
    });
    await flush();
    expect(useResultsStore.getState().isComputing).toBe(false);
    expect(useResultsStore.getState().wasCancelled).toBe(false);
    conn.disconnect();
  });

  it('失敗で計算中が解け、理由が残る', async () => {
    const { bridge, settle } = makeBridge();
    const conn = connectPipeline(bridge);
    conn.run();
    await flush();
    settle({ status: 'error', message: 'GPU が消えた' });
    await flush();
    expect(useResultsStore.getState().isComputing).toBe(false);
    expect(useResultsStore.getState().lastError).toBe('GPU が消えた');
    conn.disconnect();
  });

  it('中断で計算中が解ける', async () => {
    const { bridge, settle, cancelled } = makeBridge();
    const conn = connectPipeline(bridge);
    conn.run();
    await flush();
    conn.cancel();
    expect(cancelled()).toBe(1);
    settle({ status: 'cancelled' });
    await flush();
    expect(useResultsStore.getState().isComputing).toBe(false);
    expect(useResultsStore.getState().wasCancelled).toBe(true);
    conn.disconnect();
  });

  it('パラメータを触っただけでは走らない(ボタン起動)', async () => {
    const { bridge } = makeBridge();
    const conn = connectPipeline(bridge);
    await flush();
    expect(useResultsStore.getState().isComputing).toBe(false);
    conn.disconnect();
  });
});
