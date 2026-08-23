// 較正バッチ実行器の「仕事」と「成果」の型(較正に固有の部分だけ)。
//
// スレッド間の共通プロトコル(GPU 要求の往復・BatchWorkerData)は
// scripts/gpu_batch_protocol.ts にある。値はすべて postMessage の
// 構造化複製を通れる形に限る(Scores は数値・真偽・文字列配列だけなので通る)。

import type { Scores } from './optimize_lib';

/** worker が受け取る 1 評価の指示 */
export interface OptimizeJob {
  /** ログの tag。worker は使わない(記録は主スレッドの仕事)が、追跡のため運ぶ */
  tag: string;
  vector: Record<string, number>;
  holdoutFold?: number | undefined;
}

/**
 * 1 評価の成果。**子プロセス版ワーカー(scripts/optimize_worker.ts)が
 * stdout へ書く JSON と同じ中身**にしてある(logEval が受ける引数が同じになる)。
 */
export interface OptimizeOutcome {
  scores: Scores;
  /** 評価に要した秒(0.1 秒丸め。旧経路と同じ丸め方) */
  sec: number;
  /** 収束予算の実績(費用の内訳を後から読むため) */
  ebmYears: number;
  ebmIters: number;
}
