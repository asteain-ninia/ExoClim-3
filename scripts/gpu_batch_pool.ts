// worker_threads の並列プール + EBM の GPU バッチ束ね(主スレッド側)。
//
// **掃引(scripts/sweep_batch_lib.ts)と較正(scripts/optimize_batch_lib.ts)が
// 共有する実行機構**(2026-08-23 に sweep_batch_lib.ts から一般化)。
// 掃引での挙動は一般化の前後で変えていない — 同値検証は
// scripts/diag_sweep_batch_equiv.ts。
//
// なぜ要るか(docs/実験記録_掃引のGPUバッチ化案_2026-08-19.md と追記):
//   プロセス並列の律速は GPU のコマンドキューで、頭数を増やしても 1.55 倍で
//   頭打ち(実測)。EBM(段別内訳 65%)はバッチ版
//   (src/sim/gpu/ebm_gpu_batch.ts)で「同時に走っている仕事」をワークグループ軸に
//   載せると実効 5〜6 倍が出る。輸送 35% は CPU の SOR なので、仕事をスレッドに
//   割ればそちらは素で並走する。
//
// 構造:
//   - **1 仕事 = 1 worker_thread**。各スレッドは自分の定数ベクトルで
//     フルパイプラインを CPU 実行する。
//   - **GPU は主スレッドだけ**が持つ(webgpu ネイティブを worker に持ち込まない)。
//     worker からの EbmAccel.run 要求は短い窓(全アクティブ仕事ぶんが揃うか、
//     先頭到着から windowMs)で束ね、runBatch で 1 ディスパッチ列に載せる。
//     水蒸気トレース(777k スレッドで飽和型)と土壌は束ねる利得が無いので
//     単発 GPU 実行のまま。
//   - 全 GPU 作業は**1 本の直列鎖**に載せる。常駐バッファを持つ加速器を
//     並行に走らせると入力・読み戻しが混線するため(答えの同一性が第一)。
//   - 束が揃わない要求は、窓が閉じた時点で居る分だけ束ね、1 件なら単発版へ流す
//     (バッチ版は単発版とビット一致 — scripts/diag_ebm_batch_equiv.ts — なので、
//     どちらを通っても答えは同じ)。
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
import type { EbmAccel, MoistureTraceAccel, SoilWaterAccel } from '../src/sim/accel';
import type {
  AccelResult,
  BatchWorkerData,
  EbmReqPayload,
  MainToWorkerMsg,
  SoilReqPayload,
  TraceReqPayload,
  WorkerToMainMsg,
} from './gpu_batch_protocol';

/**
 * EBM 要求を束ねる窓(ms)。先頭の要求が到着してからこの時間だけ待ち、
 * その間に揃った分を 1 バッチにする。全アクティブ仕事ぶんが揃えば即閉じる。
 *
 * 300ms の根拠: 1 仕事の EBM 1 パスは 2° でも数秒〜数十秒であり、
 * 窓で失う時間は 1 パスあたり高々 0.3 秒 = 数 % に収まる。一方、仕事間の
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
function collectTransfers(
  x: unknown,
  out: ArrayBuffer[] = [],
  seen = new Set<ArrayBuffer>(),
): ArrayBuffer[] {
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

export interface GpuBatchPoolOptions {
  /** worker 本体(.ts)の絶対パス。gpu_batch_worker_base.ts を使う実装であること */
  workerEntry: string;
  /** 立てるスレッド数(= 同時に走る仕事の上限 = EBM バッチの最大 L) */
  threads: number;
  /** EBM を束ねる窓(ms)。既定 EBM_BATCH_WINDOW_MS */
  windowMs?: number | undefined;
  /** 進捗・束ねの注記を stderr に流すか(既定 true) */
  progress?: boolean | undefined;
}

export interface GpuBatchPool<J, R> {
  /**
   * 仕事の一群を投げ、全部の結果が揃うまで待つ。戻り値は jobs と同じ並び。
   * **同時に 1 群だけ**(較正の 1 バッチ / 掃引の 1 掃引に対応)。
   * onDone は 1 件終わるたびに**完了順**で呼ばれる(記録の順序を決めるのは
   * 呼び出し側の仕事 — 較正の評価番号は従来どおり完了順で振る)。
   */
  run(jobs: J[], onDone?: ((idx: number, result: R) => void) | undefined): Promise<R[]>;
  /** スレッドと GPU 常駐資源を畳む。**デバイスは破棄しない**(冒頭の注記) */
  close(): Promise<void>;
}

/**
 * プールを立てる。**スレッドは close() まで生き続ける** — 較正は同じプールへ
 * 何十回もバッチを投げるので、毎回立て直すと tsx の起動費(1 スレッド 1〜2 秒)を
 * 払い続けることになる。
 */
export async function createGpuBatchPool<J, R>(
  options: GpuBatchPoolOptions,
): Promise<GpuBatchPool<J, R>> {
  const ctx = await acquireGpu();
  if (!ctx) {
    throw new Error(
      `GPU を取得できない(${gpuUnavailableReason() ?? '理由不明'})。` +
        'バッチ実行器は主スレッドの GPU が前提。CPU で回すなら従来のプロセス並列を使うこと',
    );
  }
  const windowMs = options.windowMs ?? EBM_BATCH_WINDOW_MS;
  const nThreads = Math.max(1, Math.round(options.threads));
  const progress = options.progress ?? true;

  // ---- GPU 資源(セル数ごとに常駐。破棄は close() で行う)----
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
  const respondOk = (worker: Worker, reqId: number, result: AccelResult): void => {
    const msg: MainToWorkerMsg<J> = { type: 'accelRes', reqId, ok: true, result };
    // GPU 読み戻しの結果は毎回新規の配列(各実装が slice で切り出す)なので、
    // 転送して渡す = 主スレッド側のコピーはゼロ。往復のコピーは要求側の
    // 構造化複製 1 回だけになる
    worker.postMessage(msg, collectTransfers(result));
  };
  const respondErr = (worker: Worker, reqId: number, e: unknown): void => {
    const msg: MainToWorkerMsg<J> = {
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
      // (格子と時間ステップ構造。適応の倍化で年数がずれた仕事は別の組になる)
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
            `[EBMバッチ] ${g.length} 件(${f0.years} 年・${n} セル)を` +
              `${g.length === 1 ? '単発で' : '束ねて'}実行\n`,
          );
        }
        try {
          let results: AccelResult[];
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
    // 走っている仕事の数だけ揃ったら即閉じる。揃わなくても窓で必ず閉じる
    // (仕事間で結合反復の回数がずれても停まらない)
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

  // ---- worker の生成 ----
  // 本プロジェクトは "type": "module" なので __dirname は無い — import.meta.url から取る
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bootPath = path.join(here, 'gpu_thread_boot.mjs');
  const entry = pathToFileURL(options.workerEntry).href;
  const workerData: BatchWorkerData = { entry, ebmMaxSteps: EBM_BATCH_MAX_STEPS };

  /** 現在走っている run() の文脈(同時に 1 つだけ) */
  interface RunCtx {
    jobs: J[];
    results: Array<R | null>;
    nextIdx: number;
    done: number;
    settled: boolean;
    onDone: ((idx: number, result: R) => void) | undefined;
    resolve: () => void;
    reject: (e: Error) => void;
  }
  let cur: RunCtx | null = null;
  /** 仕事を持っていないスレッド。run() の外では全員がここに居る */
  const idle: Worker[] = [];
  /** プールが壊れた理由(worker の異常終了など)。以後の run() は即座に失敗させる */
  let broken: Error | null = null;
  let closing = false;

  const assign = (w: Worker): void => {
    const c = cur;
    if (!c || c.settled || c.nextIdx >= c.jobs.length) {
      idle.push(w);
      return;
    }
    const idx = c.nextIdx++;
    activeJobs++;
    const msg: MainToWorkerMsg<J> = { type: 'job', jobId: idx, job: c.jobs[idx]! };
    w.postMessage(msg);
  };

  const failRun = (e: Error): void => {
    broken = e;
    const c = cur;
    if (c && !c.settled) {
      c.settled = true;
      c.reject(e);
    }
  };

  const workers: Worker[] = [];
  for (let i = 0; i < nThreads; i++) {
    const w = new Worker(bootPath, { workerData });
    workers.push(w);
    idle.push(w);
    w.on('message', (m: WorkerToMainMsg<R>) => {
      if (m.type === 'accelReq') {
        if (m.kind === 'ebm') onEbmReq(w, m.reqId, m.payload);
        else if (m.kind === 'trace') onTraceReq(w, m.reqId, m.payload);
        else onSoilReq(w, m.reqId, m.payload);
        return;
      }
      if (m.type === 'jobError') {
        activeJobs--;
        failRun(new Error(`ジョブ ${m.jobId} が失敗:\n${m.error}`));
        return;
      }
      // m.type === 'result'
      const c = cur;
      activeJobs--;
      // アクティブ数が減った結果、待ち行列が「全員ぶん」に達したかを見直す
      if (ebmQueue.length > 0 && ebmQueue.length >= activeJobs) flushEbm();
      if (!c || c.settled) {
        idle.push(w);
        return;
      }
      c.results[m.jobId] = m.result;
      c.done++;
      c.onDone?.(m.jobId, m.result);
      if (c.done === c.jobs.length) {
        c.settled = true;
        idle.push(w);
        c.resolve();
        return;
      }
      assign(w);
    });
    w.on('error', (e) => failRun(e instanceof Error ? e : new Error(String(e))));
    w.on('exit', (code) => {
      // close() 中の terminate は code 1 で抜けるので、そこは失敗にしない
      if (code !== 0 && !closing) failRun(new Error(`worker が異常終了(code ${code})`));
    });
  }

  return {
    async run(jobs, onDone) {
      if (broken) throw broken;
      if (cur && !cur.settled) throw new Error('バッチプールは同時に 1 群しか回せない');
      if (jobs.length === 0) return [];
      const results: Array<R | null> = jobs.map(() => null);
      try {
        await new Promise<void>((resolve, reject) => {
          cur = { jobs, results, nextIdx: 0, done: 0, settled: false, onDone, resolve, reject };
          // 空いているスレッドへ配る(足りなければ完了のたびに次が入る)
          const free = idle.splice(0, idle.length);
          for (const w of free) assign(w);
        });
      } finally {
        cur = null;
      }
      return results as R[];
    },
    async close() {
      closing = true;
      if (ebmTimer) clearTimeout(ebmTimer);
      // GPU の仕掛かりを流し切ってから資源を畳む(実行中のバッファを壊さない)
      await gpuChain.catch(() => undefined);
      for (const w of workers) void w.terminate();
      for (const b of batches.values()) b.destroy();
      for (const a of singleEbms.values()) a.destroy();
      for (const a of traces.values()) a.destroy();
      for (const a of soils.values()) a.destroy();
      // **デバイスは破棄しない**(冒頭の注記。呼び出し側が releaseGpu() する)
    },
  };
}
