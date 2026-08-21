// 掃引バッチ実行器の worker_threads 側 — 1 スレッドが 1 水準ずつ
// フルパイプラインを CPU で回す(steps1-4・輸送 SOR・step6 の CPU 部が
// 水準間で自然に並走する)。
//
// 設計(docs/実験記録_掃引のGPUバッチ化案_2026-08-19.md の追記):
//   GPU は**主スレッドだけ**が持つ(webgpu ネイティブは worker では使わない —
//   device_node.ts の注意書きにある segfault 系の罠をスレッドに持ち込まない)。
//   このスレッドは RunOptions に「代理 accel」を差し込み、EbmAccel /
//   MoistureTraceAccel / SoilWaterAccel の run() を postMessage で主スレッドへ
//   送って応答を待つ。run() はもともと Promise を返す口なので、
//   **Atomics.wait は要らない** — 応答は 'message' イベントで届き、await で
//   待つあいだこのスレッドは CPU を食わない。パイプライン本体・step05/06 は
//   一切改造していない(accel の差し替えだけで成立している)。
//
//   測定の実体は既存の measureLevel(scripts/sweep_lib.ts)で、プロセス並列の
//   ワーカー(scripts/sweep_worker.ts)と同じもの。違いは accel の中身だけ。
//   検証専用の安い設定(SWEEP_GRID_DEG 等)や SWEEP_OVERRIDE は環境変数で
//   sweep_lib の読み込み時に掛かる — worker_threads は親の env を継承するので
//   全スレッドに同じ条件が効く。
//
// **`EBM_SOLVER.adaptive` は触らない**(scripts/sweep_worker.ts の注記と同じ。
// 較正から `adaptive = false` を写して v3 が 0.02〜0.06 ずれた前科がある)。

import { parentPort, workerData } from 'node:worker_threads';
import { measureLevel } from './sweep_lib';
import type {
  EbmAccel,
  EbmAccelResult,
  MoistureTraceAccel,
  SimAccelerator,
  SoilAccelResult,
  SoilWaterAccel,
} from '../src/sim/accel';
import type {
  BatchWorkerData,
  EbmReqPayload,
  MainToWorkerMsg,
  SoilReqPayload,
  TraceReqPayload,
  WorkerToMainMsg,
} from './sweep_batch_protocol';

const port = parentPort;
if (!port) throw new Error('worker_threads 専用(sweep_batch_lib.ts から起動すること)');
const wd = workerData as BatchWorkerData;

// ---- 代理 accel: run() を主スレッドへ送り、応答で resolve する ----
const pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
let nextReqId = 1;

function request<T>(
  kind: 'ebm' | 'trace' | 'soil',
  payload: EbmReqPayload | TraceReqPayload | SoilReqPayload,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const reqId = nextReqId++;
    pending.set(reqId, { resolve: resolve as (r: unknown) => void, reject });
    // 構造化複製で 1 回コピーされる。転送(transfer)はしない —
    // fields の配列は step05/06 が同じ実体をパスをまたいで使い回すため、
    // 転送で剥がすと呼び出し元が壊れる
    const msg: WorkerToMainMsg = { type: 'accelReq', reqId, kind, payload } as WorkerToMainMsg;
    port!.postMessage(msg);
  });
}

/**
 * 代理の SimAccelerator。セル数ごとの常駐資源は主スレッド側が持つので、
 * ここでは毎回同じ形の薄い口を返すだけでよい(destroy も主スレッドの仕事)。
 */
const proxyAccel: SimAccelerator = {
  ebm(_cellCount: number): EbmAccel {
    return {
      // step05 は maxSteps を**同期に**読む(年数の倍化を抑える判定)。
      // 主スレッドの実 accel と同じ値を workerData で受け取ってある
      maxSteps: wd.ebmMaxSteps,
      // control(progress / signal)は掃引では常に空なので送らない
      run: (fields, constants): Promise<EbmAccelResult> =>
        request<EbmAccelResult>('ebm', { fields, constants }),
      destroy(): void {},
    };
  },
  moistureTrace(_cellCount: number): MoistureTraceAccel {
    return {
      run: (fields, constants, monthly): Promise<Float32Array[]> =>
        request<Float32Array[]>('trace', { fields, constants, monthly }),
      destroy(): void {},
    };
  },
  soilWater(_cellCount: number): SoilWaterAccel {
    return {
      run: (input): Promise<SoilAccelResult> =>
        request<SoilAccelResult>('soil', {
          input: {
            // ArrayLike をスレッド境界を通せる形に正規化(小さい配列なので
            // このコピーは許容。Float32Array[] はそのまま構造化複製に乗る)
            landMask: Float32Array.from(input.landMask),
            precipByMonth: input.precipByMonth,
            tempByMonth: input.tempByMonth,
            capacityMm: input.capacityMm,
            petScaleMmPerMonth: input.petScaleMmPerMonth,
            maxYears: input.maxYears,
            toleranceMm: input.toleranceMm,
            initialStorage: input.initialStorage
              ? Float32Array.from(input.initialStorage)
              : undefined,
          },
        }),
      destroy(): void {},
    };
  },
  destroy(): void {},
};

// ---- 水準の測定。プロセス版ワーカーと同じく**直列**に繋ぐ ----
// (同じ MODEL_CONSTANTS を複数の測定が同時に書き換えると、どの水準の
// 成績なのか分からなくなる。主スレッドも 1 スレッド 1 水準ずつ渡してくる)
let chain: Promise<void> = Promise.resolve();

port.on('message', (m: MainToWorkerMsg) => {
  if (m.type === 'accelRes') {
    const p = pending.get(m.reqId);
    if (!p) return; // 知らない応答は捨てる(起こらないはずだが黙って固まるよりよい)
    pending.delete(m.reqId);
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(m.error));
    return;
  }
  if (m.type === 'job') {
    chain = chain.then(async () => {
      try {
        const report = await measureLevel(m.key, m.value, m.targets, { accel: proxyAccel });
        const out: WorkerToMainMsg = { type: 'report', jobId: m.jobId, report };
        port.postMessage(out);
      } catch (e) {
        const out: WorkerToMainMsg = {
          type: 'jobError',
          jobId: m.jobId,
          error: String(e instanceof Error ? (e.stack ?? e.message) : e),
        };
        port.postMessage(out);
      }
    });
  }
});
