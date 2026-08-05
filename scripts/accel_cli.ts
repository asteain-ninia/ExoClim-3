// スクリプトから GPU 加速器を開く共通口。
//
// 既定で GPU を使い、環境変数 EXOCLIM_GPU=0 で無効化できる(CPU との突合用)。
// GPU が取れない環境では静かに CPU へ落ちる。
//
// 数値は GPU を正とする(2026-08-01 のユーザー判断、src/sim/accel.ts の注記)。

import { createGpuAccelerator } from '../src/sim/gpu/accelerator_node';
import type { RunOptions, SimAccelerator } from '../src/sim/accel';

export interface OpenedAccel {
  opts: RunOptions;
  /** 使えているか(記録に残す用) */
  enabled: boolean;
  close(): void;
}

/** GPU 加速器を開く。**プロセス終了前に必ず close() を呼ぶ**(でないと exit 139) */
export async function openAccel(quiet = false): Promise<OpenedAccel> {
  if (process.env['EXOCLIM_GPU'] === '0') {
    if (!quiet) console.log('加速器: 無効(EXOCLIM_GPU=0)— CPU 実装で走る');
    return { opts: {}, enabled: false, close: () => {} };
  }
  let accel: SimAccelerator | null = null;
  try {
    accel = await createGpuAccelerator();
  } catch (e) {
    if (!quiet) console.log(`加速器: 取得に失敗(${e instanceof Error ? e.message : String(e)})`);
  }
  if (!accel) {
    if (!quiet) console.log('加速器: GPU を取得できず CPU 実装で走る');
    return { opts: {}, enabled: false, close: () => {} };
  }
  if (!quiet) console.log('加速器: WebGPU 有効');
  const a = accel;
  return { opts: { accel: a }, enabled: true, close: () => a.destroy() };
}
