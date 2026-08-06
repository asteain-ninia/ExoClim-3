// Worker からの GPU 加速器の取得。**ブラウザ専用**。
//
// 対応 spec: なし(実行基盤)。
//
// WebGPU は Worker からも使える(DedicatedWorkerGlobalScope の
// navigator.gpu)。むしろ Worker から使うのが正しい: デバイスの取得も
// 計算も、UI スレッドを止めずに済む。
//
// **加速器は Worker の寿命のあいだ常駐させる**。作り直しが高いだけでなく、
// 加速器の常駐バッファ(セル数ごと)がデバイスに紐づいているため
// (src/sim/accel.ts の SimAccelerator の注記)。

import { acquireGpuInBrowser, browserGpuUnavailableReason } from '@/sim/gpu/device_browser';
import { makeAccelerator } from '@/sim/gpu/accelerator';
import type { SimAccelerator } from '@/sim/accel';

export interface WorkerAccel {
  accel: SimAccelerator | null;
  /** 表示・記録用。GPU が使えないときは理由が入る */
  info: string;
}

let cached: WorkerAccel | null = null;

/**
 * 加速器を取得する(初回のみ生成、以後は使い回し)。
 * GPU が使えなければ accel = null を返し、呼び出し側は CPU 実装で走る
 * — **同じ結果が得られるが丸めは一致しない**(GPU を正とする)。
 */
export async function getWorkerAccel(): Promise<WorkerAccel> {
  if (cached) return cached;
  const gpu = await acquireGpuInBrowser();
  if (!gpu) {
    cached = {
      accel: null,
      info: `CPU 実装(${browserGpuUnavailableReason() ?? 'WebGPU なし'})`,
    };
    return cached;
  }
  cached = { accel: makeAccelerator(gpu), info: gpu.adapterInfo };
  return cached;
}
