// Node 用の加速器入口。**ブラウザ用バンドルはこのファイルを import しない**
// (`webgpu` パッケージを引き込むため)。
//
// 対応 spec: なし(実行基盤)。

import { acquireGpu } from './device_node';
import { makeAccelerator } from './accelerator';
import type { SimAccelerator } from '../accel';

/**
 * GPU 加速器を取得する。GPU が使えなければ null(呼び出し側は素で走らせる)。
 * **プロセス終了前に必ず destroy() を呼ぶ**(でないと exit 139)。
 */
export async function createGpuAccelerator(): Promise<SimAccelerator | null> {
  const gpu = await acquireGpu();
  if (!gpu) return null;
  return makeAccelerator(gpu);
}
