// worker_threads 用のブートストラップ(素の .mjs — tsx を経由せず Node が直接読む)。
// 掃引(sweep_batch_worker.ts)と較正(optimize_batch_worker.ts)の両方がここを通る。
//
// なぜ要るか(2026-08-21 実測):
//   `npx tsx` で立てた主スレッドから `new Worker('～.ts')` すると、tsx のローダが
//   worker に継承されず「Unknown file extension ".ts"」で死ぬ。
//   `execArgv: ['--import', 'tsx']` を渡しても、worker のエントリ読込に
//   登録が間に合わず同じ失敗になる(--require tsx/cjs も同様)。
//   そこで worker のエントリはこの素の .mjs にし、tsx の API で登録を済ませて
//   から .ts 本体(workerData.entry、file:// URL)を動的 import する。
import { workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

register();
await import(workerData.entry);
