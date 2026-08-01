// SimAccelerator の WebGPU 実装。**Node 専用**(webgpu パッケージに依存)。
//
// 対応 spec: なし(実行基盤)。src/sim/accel.ts の受け口をここで埋める。
// ブラウザ用バンドルはこのファイルを import しない — 計算層は型しか知らず、
// 加速器は呼び出し側(scripts/)が明示的に渡す。

import { acquireGpu, releaseGpu, type GpuContext } from './device';
import { createMoistureTraceGpu } from './moisture_trace_gpu';
import { createSoilWaterGpu } from './soil_water_gpu';
import type { MoistureTraceAccel, SimAccelerator, SoilWaterAccel } from '../accel';

/**
 * GPU 加速器を取得する。GPU が使えなければ null(呼び出し側は素で走らせる)。
 *
 * 資源はセル数ごとに常駐する。**解像度を変えても作り直さない**のは、
 * 較正が同じ解像度で数千回パイプラインを回すため。
 */
export async function createGpuAccelerator(): Promise<SimAccelerator | null> {
  const gpu = await acquireGpu();
  if (!gpu) return null;
  return makeAccelerator(gpu);
}

export function makeAccelerator(gpu: GpuContext): SimAccelerator {
  const traces = new Map<number, MoistureTraceAccel>();
  const soils = new Map<number, SoilWaterAccel>();
  return {
    moistureTrace(cellCount: number): MoistureTraceAccel {
      let a = traces.get(cellCount);
      if (!a) {
        a = createMoistureTraceGpu(gpu, cellCount);
        traces.set(cellCount, a);
      }
      return a;
    },
    soilWater(cellCount: number): SoilWaterAccel {
      let a = soils.get(cellCount);
      if (!a) {
        a = createSoilWaterGpu(gpu, cellCount);
        soils.set(cellCount, a);
      }
      return a;
    },
    destroy(): void {
      for (const a of traces.values()) a.destroy();
      for (const a of soils.values()) a.destroy();
      traces.clear();
      soils.clear();
      releaseGpu();
    },
  };
}
