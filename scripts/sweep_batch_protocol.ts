// 掃引バッチ実行器のスレッド間プロトコル(型定義のみ。実装は持たない)。
//
// worker(scripts/sweep_batch_worker.ts)と主スレッド(scripts/sweep_batch_lib.ts)の
// 両方が読む。値はすべて postMessage の構造化複製を通れる形に限る
// (Float32Array・数値・文字列・素のオブジェクト。関数や GPU 資源は不可)。

import type {
  EbmAccelResult,
  EbmConstants,
  EbmStaticFields,
  SoilAccelResult,
  TraceConstants,
  TraceMonthlyFields,
  TraceStaticFields,
} from '../src/sim/accel';
import type { LevelReport } from './sweep_lib';

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

/** worker → 主スレッド */
export type WorkerToMainMsg =
  | { type: 'accelReq'; reqId: number; kind: 'ebm'; payload: EbmReqPayload }
  | { type: 'accelReq'; reqId: number; kind: 'trace'; payload: TraceReqPayload }
  | { type: 'accelReq'; reqId: number; kind: 'soil'; payload: SoilReqPayload }
  | { type: 'report'; jobId: number; report: LevelReport }
  | { type: 'jobError'; jobId: number; error: string };

/** 主スレッド → worker */
export type MainToWorkerMsg =
  | { type: 'job'; jobId: number; key: string; value: number; targets: string[] }
  | {
      type: 'accelRes';
      reqId: number;
      ok: true;
      result: EbmAccelResult | Float32Array[] | SoilAccelResult;
    }
  | { type: 'accelRes'; reqId: number; ok: false; error: string };

/** Worker 生成時に渡す固定情報 */
export interface BatchWorkerData {
  /** worker 本体(.ts)の file:// URL(ブートストラップが動的 import する) */
  entry: string;
  /** 代理 EbmAccel が同期に返す maxSteps(主スレッドの実 accel と同値) */
  ebmMaxSteps: number;
}
