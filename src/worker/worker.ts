// Web Worker 本体: パイプラインを実行して結果を返す。
//
// 対応 spec: なし(実行基盤)。契約は protocol.ts。
//
// この Worker が持つ常駐資源は 2 つで、**どちらも寿命が Worker と同じ**:
//  - WebGPU 加速器(デバイス + セル数ごとの常駐バッファ)
//  - 段キャッシュ(前回の各段の出力)
// だからキャンセルは terminate ではなくメッセージで行う(protocol.ts の注記)。
//
// **実行は必ず 1 本ずつ**(single-in-flight + replay-latest、教訓 §3)。
// 並行に走らせてはいけない理由は費用ではなく正しさ:
//  - 加速器はセル数ごとの**常駐バッファ**を使い回すので、2 本が同時に
//    走ると互いのバッファを踏む(結果が壊れる)。
//  - 段キャッシュも 1 つなので、2 本ぶんのヒット/ミスが混ざる。
// 新しい要求が来たら前を中断し、**前が完全に抜けきってから**次を始める。

import { runPipelineTimed } from '@/sim/pipeline';
import { isCancelled, type CancelToken, type RunProgress } from '@/sim/run_control';
import { computeKoppen } from '@/sim/step07_koppen';
import type { SimContext, TemperatureResult, PrecipitationResult } from '@/sim/types';
import { getWorkerAccel } from './gpu';
import { PipelineCache } from './pipelineCache';
import type { PipelineRunOutput, RunRequest, WorkerRequest, WorkerResponse } from './protocol';

const cache = new PipelineCache();

/**
 * 途中経過の気候区分を組む係。
 *
 * 気候区分は気温と降水の両方が要るので、パイプラインの最後(step7)でしか
 * 出てこない。しかし利用者が一番見たいのがこの層なので、**気温と降水が
 * 揃った時点で暫定版を組んで**表示へ流す。以後は降水が更新されるたびに
 * 組み直す(computeKoppen は 1° で 50ms 程度なので、結合反復ごとに呼んで
 * も費用は誤差)。
 *
 * **計算層ではなくここに置く理由**: これは表示のための合成であって物理の
 * 一部ではない。パイプラインに入れると「本来まだ存在しない段の出力」が
 * 計算層の途中に現れることになる。
 */
class ProvisionalKoppen {
  private context: SimContext | null = null;
  private temperature: TemperatureResult | null = null;
  private precipitation: PrecipitationResult | null = null;

  /** 差分を取り込み、暫定の気候区分が組めるなら返す */
  absorb(progress: RunProgress): ReturnType<typeof computeKoppen> | null {
    const p = progress.partial;
    if (!p) return null;
    if (p.context) {
      // 新しい実行の文脈が来たら前の場は捨てる(格子が変わっている場合がある)
      this.context = p.context;
      this.temperature = null;
      this.precipitation = null;
    }
    if (p.temperature) this.temperature = p.temperature;
    if (p.precipitation) this.precipitation = p.precipitation;
    // 気候区分そのものが来たならそれが正 — 暫定版は要らない
    if (p.koppen) return null;
    if (!this.context || !this.temperature || !this.precipitation) return null;
    return computeKoppen(this.context, this.temperature, this.precipitation);
  }
}

/** 中断要求。実行ごとに作り直す(前回の中断が次回に漏れないように) */
class Cancellation implements CancelToken {
  cancelled = false;
}

/** 実行中のもの(中断の宛先) */
let inFlight: { id: number; cancel: Cancellation } | null = null;
/** 待ち行列は**最新の 1 件だけ**。古い要求は捨てて cancelled を返す */
let pending: RunRequest | null = null;
let draining: Promise<void> | null = null;

/**
 * tsconfig の lib は DOM 側なので `self` は Window として型付けされ、
 * 転送リスト付きの postMessage が通らない。Worker の実体に合わせて絞り込む
 * (lib を webworker に切り替えると UI 側の型が壊れるため、ここだけ局所的に)
 */
const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

function post(msg: WorkerResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) ctx.postMessage(msg, transfer);
  else ctx.postMessage(msg);
}

ctx.onmessage = (ev: MessageEvent<WorkerRequest>): void => {
  const msg = ev.data;
  if (msg.type === 'cancel') {
    // 待機中のものも捨てる(「止めた」のに後から走り出さないように)
    if (pending && (msg.id === 0 || pending.id <= msg.id)) {
      post({ type: 'cancelled', id: pending.id });
      pending = null;
    }
    if (inFlight && (msg.id === 0 || inFlight.id <= msg.id)) inFlight.cancel.cancelled = true;
    return;
  }
  // 追い越された要求は結果を返さないので、待たせている側へ知らせてから捨てる
  if (pending) post({ type: 'cancelled', id: pending.id });
  pending = msg;
  if (inFlight) inFlight.cancel.cancelled = true;
  if (!draining) draining = drain();
};

async function drain(): Promise<void> {
  try {
    while (pending) {
      const req = pending;
      pending = null;
      await execute(req);
    }
  } finally {
    draining = null;
  }
}

async function execute(req: RunRequest): Promise<void> {
  const id = req.id;
  const cancel = new Cancellation();
  inFlight = { id, cancel };
  const provisional = new ProvisionalKoppen();
  try {
    const { accel, info } = await getWorkerAccel();
    if (cancel.cancelled) {
      post({ type: 'cancelled', id });
      return;
    }

    // 加速器の別は**走り出しに**知らせる(完了まで黙っていると、
    // GPU なのか CPU に落ちたのかが数分わからない)
    let accelAnnounced = false;
    const { result, stepTimingsMs } = await runPipelineTimed(req.params, {
      accel: accel ?? undefined,
      signal: cancel,
      cache,
      onProgress: (progress: RunProgress) => {
        // 途中結果は **transfer しない**(protocol.ts の注記)。
        // 段の作業配列をそのまま渡しているので、転送すると計算側が壊れる
        const koppen = provisional.absorb(progress);
        const enriched: RunProgress = koppen
          ? { ...progress, partial: { ...progress.partial, koppen } }
          : progress;
        post({
          type: 'progress',
          id,
          progress: enriched,
          ...(accelAnnounced ? {} : { accelInfo: info }),
        });
        accelAnnounced = true;
      },
    });

    const stats = cache.takeStats();
    const payload: PipelineRunOutput = {
      result,
      stepTimingsMs,
      accelInfo: info,
      cacheHits: stats.hits,
      cacheMisses: stats.misses,
    };
    post({ type: 'done', id, payload });
  } catch (e) {
    // 中断は失敗ではない。エラーバッジを出さないよう型を分ける
    if (isCancelled(e)) {
      cache.takeStats();
      post({ type: 'cancelled', id });
    } else {
      cache.takeStats();
      post({ type: 'error', id, message: e instanceof Error ? e.message : String(e) });
    }
  } finally {
    if (inFlight?.id === id) inFlight = null;
  }
}
