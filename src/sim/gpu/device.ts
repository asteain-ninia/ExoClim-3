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

// 静的 import で読む。動的 import にすると 3 回目の readback で
// アクセス違反(0xC0000005)が起きた(2026-08-01 実測、原因は未特定だが
// 静的 import では 100 回以上安定する)
import { create as createWebgpu, globals as webgpuGlobals } from 'webgpu';

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
 * GPU インスタンスとアダプタへの参照を保持する。
 *
 * これが無いと、acquireGpu を抜けた時点で adapter がガベージコレクトされ、
 * その後の GPU 操作がアクセス違反(0xC0000005)で落ちる(2026-08-01 実測)。
 * 同じコードでも adapter をモジュール直下の const に置くと安定するため、
 * ネイティブ側がアダプタへの参照を保持していると考えられる。
 * 症状は「数回の readback のあと突然プロセスが死ぬ」で、
 * 一見すると mapAsync の不具合に見える — 切り分けに長時間を要した。
 */
const keepAlive: { gpu: unknown; adapter: unknown }[] = [];

/** 型定義が Float32Array<ArrayBuffer> を要求するため、転送時に絞り込む */
export function asBufferSource(a: Float32Array): GPUAllowSharedBufferSource {
  return a as unknown as GPUAllowSharedBufferSource;
}

/**
 * GPU を取得する。使えなければ null(呼び出し側は CPU 実装へ落ちる)。
 * 一度取得したデバイスは使い回す — デバイス生成は数百 ms かかるため。
 */
export async function acquireGpu(): Promise<GpuContext | null> {
  if (cached) return cached;
  if (unavailableReason) return null;
  try {
    Object.assign(globalThis, webgpuGlobals);
    const gpu = createWebgpu([]);
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      unavailableReason = 'アダプタを取得できない';
      return null;
    }
    const device = await adapter.requestDevice({
      // 既定の device は adapter より制限が厳しい。実測で踏んだもの:
      //  - workgroup サイズ既定 256(adapter は 1024)。256 が最良なので実害は
      //    無いが、明示的に上げておく
      //  - **ストレージバッファ既定 8 本**(adapter は 16)。風上追跡は 9 本
      //    要るため、上げないとパイプライン生成が失敗する。しかもエラーは
      //    既定では黙って捨てられ「結果が全部ゼロ」としてしか現れない
      requiredLimits: {
        maxComputeWorkgroupSizeX: adapter.limits.maxComputeWorkgroupSizeX,
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
        maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
      },
    });
    // 検証エラーは既定では黙って捨てられ、「結果が全部ゼロ」という形でしか
    // 現れない(2026-08-01 に実際に踏んだ)。必ず表に出す
    if (process.env['EXOCLIM_GPU_EVENTS'] === '1') {
      device.addEventListener?.('uncapturederror', (ev: Event) => {
        const err = (ev as unknown as { error?: { message?: string } }).error;
        console.error('[WebGPU エラー]', err?.message ?? String(ev));
      });
      void device.lost.then((info: { reason?: string; message?: string }) => {
        console.error(`[WebGPU デバイス消失] ${info.reason ?? '?'}: ${info.message ?? ''}`);
      });
    }
    keepAlive.push({ gpu, adapter });
    cached = {
      device,
      adapterInfo: 'WebGPU device',
      destroy(): void {
        device.destroy();
        cached = null;
        keepAlive.length = 0;
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

/**
 * 初期値つきのバッファを作る。
 * mappedAtCreation ではなく writeBuffer で埋める — 前者を使うと
 * 後続の mapAsync が 3 回目でアクセス違反を起こした(2026-08-01 実測)。
 */
export function createFilledBuffer(
  device: GPUDevice,
  data: Float32Array,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const buf = device.createBuffer({
    size: data.byteLength,
    usage: usage | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buf, 0, asBufferSource(data));
  return buf;
}

/**
 * 読み戻し用の常駐ステージングバッファ。
 *
 * 毎回 createBuffer / destroy すると 100 回未満で segfault する
 * (2026-08-01 実測、3.1MB のバッファで再現)。同じバッファを使い回す。
 * 較正は 1 プロセスで数千回パイプラインを回すため、ここが持たないと
 * GPU 化そのものが成立しない。
 */
export class ReadbackStage {
  private buffer: GPUBuffer;
  private capacityFloats: number;
  /** 受け取り先も使い回す。毎回 3MB を確保すると GC 負荷で不安定になる */
  private scratch: Float32Array;

  constructor(
    private device: GPUDevice,
    floatCount: number,
  ) {
    this.capacityFloats = floatCount;
    this.buffer = device.createBuffer({
      size: floatCount * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    this.scratch = new Float32Array(floatCount);
  }

  /**
   * 計算と同じコマンドエンコーダへコピーを積む。
   * **計算とコピーは必ず 1 回の submit にまとめること** — 別々に submit すると
   * 3 回目の読み戻しでアクセス違反(0xC0000005)が起きた(2026-08-01 実測)。
   */
  enqueueCopy(enc: GPUCommandEncoder, src: GPUBuffer, floatCount: number): void {
    if (floatCount > this.capacityFloats) {
      throw new Error(
        `ステージングバッファが小さい(要求 ${floatCount} / 確保 ${this.capacityFloats})`,
      );
    }
    enc.copyBufferToBuffer(src, 0, this.buffer, 0, floatCount * 4);
  }

  /**
   * submit 済みのコピー結果を読み出す。**呼ぶ回数は最小に**
   * (1 回あたり約 0.3ms の固定費)。
   * 返る配列は次回の呼び出しで上書きされる — 保持するなら複製すること。
   */
  async map(floatCount: number): Promise<Float32Array> {
    await this.buffer.mapAsync(GPUMapMode.READ);
    const view = new Float32Array(this.buffer.getMappedRange(), 0, floatCount);
    const out = this.scratch.subarray(0, floatCount);
    out.set(view);
    this.buffer.unmap();
    return out;
  }

  /** コピーと読み出しをまとめて行う(計算と分けて submit する場合のみ) */
  async read(src: GPUBuffer, floatCount: number): Promise<Float32Array> {
    const enc = this.device.createCommandEncoder();
    this.enqueueCopy(enc, src, floatCount);
    this.device.queue.submit([enc.finish()]);
    return this.map(floatCount);
  }

  destroy(): void {
    this.buffer.destroy();
  }
}
