// WebGPU デバイスの取得と後始末。
//
// 対応 spec: なし(実行基盤)。設計判断の根拠は実機計測 2026-08-01:
//  - 往復 1 回の固定費は約 0.3ms。64,800 セル 1 ステップの計算は 0.07〜0.17ms
//    なので、**1 ステップごとに CPU へ戻す設計では GPU 化は逆に遅くなる**。
//  - mapAsync の往復を数百回繰り返すと確率的に segfault する(500 回で 3/3)。
//    同期・バッファプール・毎回新規生成のいずれも効かず、readback 回数を
//    減らすことだけが効いた。**GPU 常駐は最適化ではなく動作の必要条件**。
//  - `device.destroy()` を呼ばずに終えると必ず exit 139。**必ず finally で呼ぶ**。
//  - workgroup サイズは 256 が最良(64 は 1.5 倍遅い)。既定 device の上限は
//    256 なので、それ以上を使うには requiredLimits で明示的に引き上げる。
//  - f64 も f16 も無い。倍精度が要る積算は CPU 側に残す。
//  - atomics と順序不定の並列リダクションを避ければ同一入力でビット一致する
//    (独立カーネル 30/30 一致、atomic 総和は 20 回で 17 種類)。
//
// 計算層の純粋性について: src/sim/ は本来「純粋関数・副作用なし」だが、
// GPU はデバイスという外部資源を要する。そこで **GPU は明示的に渡す**形にし、
// 渡されなければ CPU 実装へ落ちる(GPU 無しでも同じ結果が得られる —
// ただし浮動小数の丸めは一致しない。GPU 側を正とする)。

export const GPU_WORKGROUP_SIZE = 256;

export interface GpuContext {
  device: GPUDevice;
  /** 使用したアダプタの説明(検証記録に残す用) */
  adapterInfo: string;
  destroy(): void;
}

let cached: GpuContext | null = null;
let unavailableReason: string | null = null;

/**
 * GPU を取得する。使えなければ null(呼び出し側は CPU 実装へ落ちる)。
 * 一度取得したデバイスは使い回す — デバイス生成は数百 ms かかるため。
 */
export async function acquireGpu(): Promise<GpuContext | null> {
  if (cached) return cached;
  if (unavailableReason) return null;
  try {
    const mod = (await import('webgpu')) as {
      create: (flags: string[]) => GPU;
      globals: Record<string, unknown>;
    };
    Object.assign(globalThis, mod.globals);
    const gpu = mod.create([]);
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      unavailableReason = 'アダプタを取得できない';
      return null;
    }
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxComputeWorkgroupSizeX: adapter.limits.maxComputeWorkgroupSizeX,
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    });
    const info = adapter.info as unknown as Record<string, string> | undefined;
    cached = {
      device,
      adapterInfo: info
        ? [info['vendor'], info['architecture'], info['device'], info['description']]
            .filter(Boolean)
            .join(' / ')
        : 'unknown',
      destroy(): void {
        device.destroy();
        cached = null;
      },
    };
    return cached;
  } catch (e) {
    unavailableReason = e instanceof Error ? e.message : String(e);
    return null;
  }
}

/** 取得済みなら破棄する。プロセス終了前に必ず呼ぶ(でないと exit 139) */
export function releaseGpu(): void {
  cached?.destroy();
}

/** GPU が使えない理由(使える場合は null) */
export function gpuUnavailableReason(): string | null {
  return unavailableReason;
}

// ---- バッファ補助 ----

export function createFilledBuffer(
  device: GPUDevice,
  data: Float32Array,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const buf = device.createBuffer({ size: data.byteLength, usage, mappedAtCreation: true });
  new Float32Array(buf.getMappedRange()).set(data);
  buf.unmap();
  return buf;
}

/**
 * バッファを読み戻す。**呼ぶ回数を最小にすること** — 1 回あたり約 0.3ms の
 * 固定費に加え、数百回繰り返すと確率的に segfault する。
 */
export async function readBackFloats(
  device: GPUDevice,
  src: GPUBuffer,
  floatCount: number,
): Promise<Float32Array> {
  const stage = device.createBuffer({
    size: floatCount * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(src, 0, stage, 0, floatCount * 4);
  device.queue.submit([enc.finish()]);
  await stage.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(stage.getMappedRange().slice(0));
  stage.unmap();
  stage.destroy();
  return out;
}
