// worker_threads バッチ実行器の worker 側の共通部 — 1 スレッドが 1 仕事ずつ
// フルパイプラインを CPU で回す(steps1-4・輸送 SOR・step6 の CPU 部が
// 仕事のあいだで自然に並走する)。
//
// **掃引(sweep_batch_worker.ts)と較正(optimize_batch_worker.ts)が共有する**
// (2026-08-23 に sweep_batch_worker.ts から一般化)。
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
//   検証専用の安い設定(SWEEP_GRID_DEG / OPTIMIZE_GRID_DEG 等)は環境変数で
//   各 lib の読み込み時に掛かる — worker_threads は親の env を継承するので
//   全スレッドに同じ条件が効く。
//
// **`EBM_SOLVER.adaptive` はここでは触らない。** 掃引は既定(true)のまま、
// 較正は optimize_batch_worker.ts 側で false にする(掃引に較正の設定を
// 写して v3 が 0.02〜0.06 ずれた前科がある — scripts/sweep_worker.ts の注記)。

import { parentPort, workerData } from 'node:worker_threads';
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
} from './gpu_batch_protocol';

/**
 * 仕事の本体を渡してワーカーを起動する。**この関数は戻らない**
 * (メッセージ待ちのまま常駐する)。
 *
 * handler は「代理 accel を差し込んだ RunOptions」を受け取り、結果を返す。
 * 結果は構造化複製を通る形(数値・文字列・素のオブジェクト・Float32Array)に限る。
 */
export function runBatchWorker<J, R>(
  handler: (job: J, accel: SimAccelerator) => Promise<R>,
): void {
  const port = parentPort;
  if (!port) throw new Error('worker_threads 専用(gpu_batch_pool.ts から起動すること)');
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
      const msg: WorkerToMainMsg<R> = {
        type: 'accelReq',
        reqId,
        kind,
        payload,
      } as WorkerToMainMsg<R>;
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
        // control(progress / signal)は掃引・較正では常に空なので送らない
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

  // ---- 仕事の実行。プロセス版ワーカーと同じく**直列**に繋ぐ ----
  // (同じ MODEL_CONSTANTS を複数の仕事が同時に書き換えると、どの定数ベクトルの
  // 成績なのか分からなくなる。主スレッドも 1 スレッド 1 仕事ずつ渡してくる)
  let chain: Promise<void> = Promise.resolve();

  port.on('message', (m: MainToWorkerMsg<J>) => {
    if (m.type === 'accelRes') {
      const p = pending.get(m.reqId);
      if (!p) return; // 知らない応答は捨てる(起こらないはずだが黙って固まるよりよい)
      pending.delete(m.reqId);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error));
      return;
    }
    // m.type === 'job'
    chain = chain.then(async () => {
      try {
        const result = await handler(m.job, proxyAccel);
        const out: WorkerToMainMsg<R> = { type: 'result', jobId: m.jobId, result };
        port.postMessage(out);
      } catch (e) {
        const out: WorkerToMainMsg<R> = {
          type: 'jobError',
          jobId: m.jobId,
          error: String(e instanceof Error ? (e.stack ?? e.message) : e),
        };
        port.postMessage(out);
      }
    });
  });
}
