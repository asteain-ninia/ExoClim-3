// ワーカー境界のメッセージ契約。両端(worker.ts / bridge.ts)が参照する。
//
// 対応 spec: なし(実行基盤)。
//
// 設計:
//  - 要求には id を付け、応答にも載せる(教訓 §4 F1 の陳腐化ガード)。
//  - **キャンセルは terminate ではなくメッセージで行う**。terminate すると
//    WebGPU デバイスと加速器の常駐バッファが道連れになり、再取得に
//    数百 ms かかるうえ段キャッシュも消える。協調的な中断のほうが安い。
//  - 進捗は要求 id つきの片方向通知。**途中結果は progress に相乗り**させる
//    (別チャンネルにすると「進捗 60% だが場は 40% 時点のもの」という
//     ずれた組み合わせが表示に出る)。
//  - 途中結果は **transfer しない**。段の作業配列をそのまま渡しているので、
//    転送すると計算側で使えなくなる。構造化複製の写しで渡す。

import type { PlanetParams } from '@/domain/planetParams';
import type { PipelineResult } from '@/sim/types';
import type { RunProgress } from '@/sim/run_control';

export interface RunRequest {
  type: 'run';
  id: number;
  params: PlanetParams;
}

export interface CancelRequest {
  type: 'cancel';
  /** この id 以下の実行を止める(0 なら実行中のものすべて) */
  id: number;
}

export type WorkerRequest = RunRequest | CancelRequest;

export interface PipelineRunOutput {
  result: PipelineResult;
  stepTimingsMs: Record<string, number>;
  /** 加速器の説明(GPU 名 / CPU に落ちた理由) */
  accelInfo: string;
  /** 段キャッシュのヒット(この実行で再計算を省いた段) */
  cacheHits: string[];
  /** 段キャッシュのミス(この実行で計算した段) */
  cacheMisses: string[];
}

export type WorkerResponse =
  | { type: 'done'; id: number; payload: PipelineRunOutput }
  | { type: 'error'; id: number; message: string }
  | { type: 'cancelled'; id: number }
  | {
      type: 'progress';
      id: number;
      progress: RunProgress;
      /**
       * 加速器の説明。**実行の最初の通知にだけ**載せる。
       * 完了まで出さないと「GPU で走っているのか CPU に落ちたのか」が
       * 数分間わからない — 落ちていたら待つ意味が変わるので、走り出しに知らせる。
       */
      accelInfo?: string;
    };
