// 掃引バッチ実行器の主スレッド側: 水準の worker_threads 並列 + EBM の GPU バッチ束ね。
//
// なぜ要るか(docs/実験記録_掃引のGPUバッチ化案_2026-08-19.md と追記):
//   既存の掃引はプロセス並列(既定 4)だが、律速は GPU のコマンドキューで、
//   頭数を増やしても 1.55 倍で頭打ち(実測)。EBM(段別内訳 65%)は
//   バッチ版(src/sim/gpu/ebm_gpu_batch.ts)で水準をワークグループ軸に載せると
//   実効 5〜6 倍が出る。輸送 35% は CPU の SOR なので、水準をスレッドに割れば
//   そちらは素で並走する。
//
// 構造:
//   - **水準 = worker_threads**(scripts/sweep_batch_worker.ts)。各スレッドは
//     自分の水準の定数でフルパイプラインを CPU 実行する。
//   - **GPU は主スレッドだけ**が持つ。worker からの EbmAccel.run 要求は短い窓
//     (全アクティブ水準ぶんが揃うか、先頭到着から EBM_BATCH_WINDOW_MS)で束ね、
//     runBatch で 1 ディスパッチ列に載せる。水蒸気トレース(777k スレッドで
//     飽和型)と土壌は束ねる利得が無いので単発 GPU 実行のまま。
//   - 全 GPU 作業は**1 本の直列鎖**に載せる。常駐バッファを持つ加速器を
//     並行に走らせると入力・読み戻しが混線するため(答えの同一性が第一)。
//   - 結合反復の回数ずれ等で束が揃わない要求は、窓が閉じた時点で居る分だけ
//     束ね、1 件なら単発版へ流す(バッチ版は単発版とビット一致 —
//     scripts/diag_ebm_batch_equiv.ts — なので、どちらを通っても答えは同じ)。
//
// **このモジュールは GPU デバイスを破棄しない。** 呼び出し側がプロセス終了前に
// releaseGpu()(src/sim/gpu/device_node.ts)を必ず呼ぶこと(でないと exit 139)。
// 同値検証が「既存経路」と「バッチ経路」を同一プロセスで続けて回すため、
// デバイスの所有はプロセス(呼び出し側)に置く。

import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireGpu, gpuUnavailableReason } from '../src/sim/gpu/device_node';
import { createEbmGpu } from '../src/sim/gpu/ebm_gpu';
import { createMoistureTraceGpu } from '../src/sim/gpu/moisture_trace_gpu';
import { createSoilWaterGpu } from '../src/sim/gpu/soil_water_gpu';
import {
  createEbmGpuBatchAccel,
  EBM_BATCH_MAX_STEPS,
  type EbmGpuBatchAccel,
} from '../src/sim/gpu/ebm_gpu_batch';
import type {
  EbmAccel,
  EbmAccelResult,
  MoistureTraceAccel,
  SoilAccelResult,
  SoilWaterAccel,
} from '../src/sim/accel';
import type { LevelReport } from './sweep_lib';
import type {
  BatchWorkerData,
  EbmReqPayload,
  MainToWorkerMsg,
  SoilReqPayload,
  TraceReqPayload,
  WorkerToMainMsg,
} from './sweep_batch_protocol';

/**
 * EBM 要求を束ねる窓(ms)。先頭の要求が到着してからこの時間だけ待ち、
 * その間に揃った分を 1 バッチにする。全アクティブ水準ぶんが揃えば即閉じる。
 *
 * 300ms の根拠: 1 水準の EBM 1 パスは 2° でも数秒〜数十秒であり、
 * 窓で失う時間は 1 パスあたり高々 0.3 秒 = 数 % に収まる。一方、水準間の
 * CPU 進行のばらつき(steps1-4 の実行時間差)は同型の計算なので通常この窓に
 * 収まる。窓を伸ばしても束ねられる相手は増えない(揃わない = 別パス構造)。
 */
export const EBM_BATCH_WINDOW_MS = 300;

interface PendingEbm {
  worker: Worker;
  reqId: number;
  payload: EbmReqPayload;
}

/** 結果の中の Float32Array のバッファを集める(worker への転送用 = ゼロコピー) */
function collectTransfers(x: unknown, out: ArrayBuffer[] = [], seen = new Set<ArrayBuffer>()): ArrayBuffer[] {
  if (x instanceof Float32Array) {
    const b = x.buffer as ArrayBuffer;
    if (!seen.has(b)) {
      seen.add(b);
      out.push(b);
    }
    return out;
  }
  // Float32Array 以外の TypedArray はここで止める(Object.values に流すと
  // **全要素を 1 つずつ走査**してしまう。現状の結果に他形は無いが防御)
  if (ArrayBuffer.isView(x)) return out;
  if (Array.isArray(x)) {
    for (const v of x) collectTransfers(v, out, seen);
    return out;
  }
  if (x && typeof x === 'object') {
    for (const v of Object.values(x)) collectTransfers(v, out, seen);
    return out;
  }
  return out;
}

export interface RunSweepBatchOptions {
  /** スレッド数(既定は水準数と 8 の小さいほう) */
  threads?: number | undefined;
  /** EBM を束ねる窓(ms)。既定 EBM_BATCH_WINDOW_MS */
  windowMs?: number | undefined;
  /** 水準が 1 つ終わるたびに呼ぶ(idx は values の添字)。印字は呼び出し側の仕事 */
  onReport?: ((idx: number, report: LevelReport) => void) | undefined;
  /** 進捗の注記を stderr に流すか(既定 true) */
  progress?: boolean | undefined;
}

/**
 * バッチ実行器で掃引を回す。戻り値は values と同じ並びの測定結果。
 *
 * 定数の上書き(掃引対象の値)は worker スレッド側の MODEL_CONSTANTS にしか
 * 起きない — 主スレッドは定数を触らない(触っても worker には伝わらないし、
 * GPU 側は定数を fields/constants 経由でしか見ない)。
 */
export async function runSweepBatch(
  key: string,
  values: number[],
  targets: string[],
  options: RunSweepBatchOptions = {},
): Promise<LevelReport[]> {
  const ctx = await acquireGpu();
  if (!ctx) {
    throw new Error(
      `GPU を取得できない(${gpuUnavailableReason() ?? '理由不明'})。` +
        'バッチ実行器は主スレッドの GPU が前提。CPU で回すなら既存の sweep_lever.ts を使うこと',
    );
  }
  const windowMs = options.windowMs ?? EBM_BATCH_WINDOW_MS;
  const nThreads = Math.max(1, Math.min(options.threads ?? Math.min(values.length, 8), values.length));
  const progress = options.progress ?? true;

  // ---- GPU 資源(セル数ごとに常駐。破棄はこの関数の finally で行う)----
  const singleEbms = new Map<number, EbmAccel>();
  const traces = new Map<number, MoistureTraceAccel>();
  const soils = new Map<number, SoilWaterAccel>();
  const batches = new Map<string, EbmGpuBatchAccel>();
  const singleEbm = (n: number): EbmAccel => {
    let a = singleEbms.get(n);
    if (!a) {
      a = createEbmGpu(ctx, n);
      singleEbms.set(n, a);
    }
    return a;
  };

  // GPU 作業の直列鎖。**全種類の GPU 実行がここを通る**(混線防止)
  let gpuChain: Promise<unknown> = Promise.resolve();
  const enqueueGpu = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = gpuChain.then(fn);
    gpuChain = p.catch(() => undefined);
    return p;
  };

  // ---- worker への応答 ----
  const respondOk = (
    worker: Worker,
    reqId: number,
    result: EbmAccelResult | Float32Array[] | SoilAccelResult,
  ): void => {
    const msg: MainToWorkerMsg = { type: 'accelRes', reqId, ok: true, result };
    // GPU 読み戻しの結果は毎回新規の配列(各実装が slice で切り出す)なので、
    // 転送して渡す = 主スレッド側のコピーはゼロ。往復のコピーは要求側の
    // 構造化複製 1 回だけになる
    worker.postMessage(msg, collectTransfers(result));
  };
  const respondErr = (worker: Worker, reqId: number, e: unknown): void => {
    const msg: MainToWorkerMsg = {
      type: 'accelRes',
      reqId,
      ok: false,
      error: String(e instanceof Error ? (e.stack ?? e.message) : e),
    };
    worker.postMessage(msg);
  };

  // ---- EBM 要求の束ね ----
  let ebmQueue: PendingEbm[] = [];
  let ebmTimer: NodeJS.Timeout | null = null;
  let activeJobs = 0;

  const flushEbm = (): void => {
    if (ebmTimer) {
      clearTimeout(ebmTimer);
      ebmTimer = null;
    }
    if (ebmQueue.length === 0) return;
    const reqs = ebmQueue;
    ebmQueue = [];
    void enqueueGpu(async () => {
      // 互換キーで分ける。組はバッチ版 runBatch の前提ガードと同じ
      // (格子と時間ステップ構造。適応の倍化で年数がずれた水準は別の組になる)
      const groups = new Map<string, PendingEbm[]>();
      for (const r of reqs) {
        const f = r.payload.fields;
        const ck = [
          f.widthCells,
          f.heightCells,
          f.stepsPerYear,
          f.years,
          f.fullCapacityYears,
          f.dtSeconds,
          f.spinupCapacityFraction,
        ].join('|');
        const g = groups.get(ck);
        if (g) g.push(r);
        else groups.set(ck, [r]);
      }
      for (const g of groups.values()) {
        const f0 = g[0]!.payload.fields;
        const n = f0.widthCells * f0.heightCells;
        // 束ねの実績を残す(「本当に束ねたか」を後から機械的に確かめられるように。
        // ビット一致だけでは単発フォールバックに落ちていても気づけない)
        if (progress) {
          process.stderr.write(
            `[EBMバッチ] ${g.length} 水準(${f0.years} 年・${n} セル)を` +
              `${g.length === 1 ? '単発で' : '束ねて'}実行\n`,
          );
        }
        try {
          let results: EbmAccelResult[];
          if (g.length === 1) {
            // 揃わなかった要求は単発版へ(答えはバッチ版とビット一致)
            results = [await singleEbm(n).run(g[0]!.payload.fields, g[0]!.payload.constants)];
          } else {
            const bk = `${n}:${g.length}`;
            let b = batches.get(bk);
            if (!b) {
              b = createEbmGpuBatchAccel(ctx, n, g.length);
              batches.set(bk, b);
            }
            results = await b.runBatch(
              g.map((r) => r.payload.fields),
              g.map((r) => r.payload.constants),
            );
          }
          for (let i = 0; i < g.length; i++) respondOk(g[i]!.worker, g[i]!.reqId, results[i]!);
        } catch (e) {
          for (const r of g) respondErr(r.worker, r.reqId, e);
        }
      }
    });
  };

  const onEbmReq = (worker: Worker, reqId: number, payload: EbmReqPayload): void => {
    ebmQueue.push({ worker, reqId, payload });
    // 走っている水準の数だけ揃ったら即閉じる。揃わなくても窓で必ず閉じる
    // (水準間で結合反復の回数がずれても停まらない)
    if (ebmQueue.length >= activeJobs) flushEbm();
    else if (!ebmTimer) ebmTimer = setTimeout(flushEbm, windowMs);
  };

  const onTraceReq = (worker: Worker, reqId: number, p: TraceReqPayload): void => {
    void enqueueGpu(async () => {
      const n = p.fields.widthCells * p.fields.heightCells;
      let a = traces.get(n);
      if (!a) {
        a = createMoistureTraceGpu(ctx, n);
        traces.set(n, a);
      }
      try {
        respondOk(worker, reqId, await a.run(p.fields, p.constants, p.monthly));
      } catch (e) {
        respondErr(worker, reqId, e);
      }
    });
  };

  const onSoilReq = (worker: Worker, reqId: number, p: SoilReqPayload): void => {
    void enqueueGpu(async () => {
      const n = p.input.landMask.length;
      let a = soils.get(n);
      if (!a) {
        a = createSoilWaterGpu(ctx, n);
        soils.set(n, a);
      }
      try {
        respondOk(worker, reqId, await a.run(p.input));
      } catch (e) {
        respondErr(worker, reqId, e);
      }
    });
  };

  // ---- worker の生成と水準の割り当て ----
  // 本プロジェクトは "type": "module" なので __dirname は無い — import.meta.url から取る
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bootPath = path.join(here, 'sweep_thread_boot.mjs');
  const entry = pathToFileURL(path.join(here, 'sweep_batch_worker.ts')).href;
  const workerData: BatchWorkerData = { entry, ebmMaxSteps: EBM_BATCH_MAX_STEPS };
  const workers: Worker[] = [];
  const reports: Array<LevelReport | null> = values.map(() => null);

  try {
    await new Promise<void>((resolve, reject) => {
      let nextIdx = 0;
      let done = 0;
      let settled = false;
      const fail = (e: Error): void => {
        if (settled) return;
        settled = true;
        reject(e);
      };
      const assign = (w: Worker): void => {
        if (settled || nextIdx >= values.length) return;
        const idx = nextIdx++;
        activeJobs++;
        const msg: MainToWorkerMsg = {
          type: 'job',
          jobId: idx,
          key,
          value: values[idx]!,
          targets,
        };
        w.postMessage(msg);
      };
      const onDone = (idx: number, report: LevelReport, w: Worker): void => {
        reports[idx] = report;
        activeJobs--;
        done++;
        if (progress) {
          process.stderr.write(
            `[掃引バッチ] ${key}=${values[idx]} 完了 ${report.sec.toFixed(0)}s ` +
              `(${done}/${values.length})\n`,
          );
        }
        options.onReport?.(idx, report);
        // アクティブ数が減った結果、待ち行列が「全員ぶん」に達したかを見直す
        if (ebmQueue.length > 0 && ebmQueue.length >= activeJobs) flushEbm();
        if (done === values.length) {
          settled = true;
          resolve();
          return;
        }
        assign(w);
      };
      for (let i = 0; i < nThreads; i++) {
        const w = new Worker(bootPath, { workerData });
        workers.push(w);
        w.on('message', (m: WorkerToMainMsg) => {
          if (m.type === 'accelReq') {
            if (m.kind === 'ebm') onEbmReq(w, m.reqId, m.payload);
            else if (m.kind === 'trace') onTraceReq(w, m.reqId, m.payload);
            else onSoilReq(w, m.reqId, m.payload);
          } else if (m.type === 'report') {
            onDone(m.jobId, m.report, w);
          } else if (m.type === 'jobError') {
            fail(new Error(`水準 ${values[m.jobId]} の測定に失敗:\n${m.error}`));
          }
        });
        w.on('error', (e) => fail(e instanceof Error ? e : new Error(String(e))));
        w.on('exit', (code) => {
          if (!settled && code !== 0) fail(new Error(`worker が異常終了(code ${code})`));
        });
        assign(w);
      }
    });
  } finally {
    if (ebmTimer) clearTimeout(ebmTimer);
    // GPU の仕掛かりを流し切ってから資源を畳む(実行中のバッファを壊さない)
    await gpuChain.catch(() => undefined);
    for (const w of workers) void w.terminate();
    for (const b of batches.values()) b.destroy();
    for (const a of singleEbms.values()) a.destroy();
    for (const a of traces.values()) a.destroy();
    for (const a of soils.values()) a.destroy();
    // **デバイスは破棄しない**(冒頭の注記。呼び出し側が releaseGpu() する)
  }
  return reports as LevelReport[];
}
