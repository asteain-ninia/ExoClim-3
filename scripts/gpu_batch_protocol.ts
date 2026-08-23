// worker_threads バッチ実行器のスレッド間プロトコル(型定義のみ。実装は持たない)。
//
// **掃引と較正の両方が使う共通の口**(2026-08-23 に sweep_batch_protocol.ts から
// 一般化)。job / result の中身だけを型引数にし、GPU 要求の往復はここに固定する。
// worker(scripts/gpu_batch_worker_base.ts)と主スレッド
// (scripts/gpu_batch_pool.ts)の両方が読む。値はすべて postMessage の
// 構造化複製を通れる形に限る(Float32Array・数値・文字列・素のオブジェクト。
// 関数や GPU 資源は不可)。

import type {
  EbmAccelResult,
  EbmConstants,
  EbmStaticFields,
  SoilAccelResult,
  TraceConstants,
  TraceMonthlyFields,
  TraceStaticFields,
} from '../src/sim/accel';

/**
 * 土壌加速器 run() の入力(src/sim/accel.ts の SoilWaterAccel.run 引数と同形)。
 * 元の型は `ArrayLike<number>` を許すが、スレッド境界を通すために
 * worker 側で Float32Array に正規化してから送る。
 */
export interface SoilRunInput {
  landMask: Float32Array;
  precipByMonth: Float32Array[];
  tempByMonth: Float32Array[];
  capacityMm: number;
  petScaleMmPerMonth: number;
  maxYears: number;
  toleranceMm: number;
  initialStorage?: Float32Array | undefined;
}

export interface EbmReqPayload {
  fields: EbmStaticFields;
  constants: EbmConstants;
}

export interface TraceReqPayload {
  fields: TraceStaticFields;
  constants: TraceConstants;
  monthly: TraceMonthlyFields;
}

export interface SoilReqPayload {
  input: SoilRunInput;
}

/** 主スレッドが返す加速器の結果(種別ごとの合併) */
export type AccelResult = EbmAccelResult | Float32Array[] | SoilAccelResult;

/** worker → 主スレッド。R = 1 ジョブの成果物の型 */
export type WorkerToMainMsg<R> =
  | { type: 'accelReq'; reqId: number; kind: 'ebm'; payload: EbmReqPayload }
  | { type: 'accelReq'; reqId: number; kind: 'trace'; payload: TraceReqPayload }
  | { type: 'accelReq'; reqId: number; kind: 'soil'; payload: SoilReqPayload }
  | { type: 'result'; jobId: number; result: R }
  | { type: 'jobError'; jobId: number; error: string };

/** 主スレッド → worker。J = 1 ジョブの指示の型 */
export type MainToWorkerMsg<J> =
  | { type: 'job'; jobId: number; job: J }
  | { type: 'accelRes'; reqId: number; ok: true; result: AccelResult }
  | { type: 'accelRes'; reqId: number; ok: false; error: string };

/** Worker 生成時に渡す固定情報 */
export interface BatchWorkerData {
  /** worker 本体(.ts)の file:// URL(ブートストラップが動的 import する) */
  entry: string;
  /** 代理 EbmAccel が同期に返す maxSteps(主スレッドの実 accel と同値) */
  ebmMaxSteps: number;
}
