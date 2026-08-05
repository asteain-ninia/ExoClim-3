// WebGPU デバイスの取得と後始末 — **Node 専用**(`webgpu` パッケージに依存)。
//
// 対応 spec: なし(実行基盤)。ブラウザ側は device_browser.ts。
// バッファ補助と限界値の設定は両環境共通で device.ts にある。
//
// このファイルに書いてある注意はすべて **Node ネイティブバインディング固有**の
// 実測(2026-08-01)であり、ブラウザには当てはまらない(ブラウザ側は
// プロセスがメモリ安全なので GC・segfault の話は出てこない)。
//  - `device.destroy()` を呼ばずに終えると必ず exit 139。**必ず finally で呼ぶ**。
//  - mapAsync の往復を数百回繰り返すと確率的に segfault する(500 回で 3/3)。
//    readback 回数を減らすことだけが効いた。

// 静的 import で読む。動的 import にすると 3 回目の readback で
// アクセス違反(0xC0000005)が起きた(2026-08-01 実測、原因は未特定だが
// 静的 import では 100 回以上安定する)
import { create as createWebgpu, globals as webgpuGlobals } from 'webgpu';
import { requestDeviceWithLimits, type GpuContext } from './device';

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
    const device = await requestDeviceWithLimits(adapter);
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
      adapterInfo: 'WebGPU device (Node)',
      destroy(): void {
        device.destroy();
        cached = null;
        // **keepAlive は空にしない**。ここで参照を落とすと gpu/adapter が GC 対象に
        // なり、プロセス終了時にアクセス違反で落ちる(2026-08-01 実測: destroy 後も
        // 処理を続けるスクリプトが終了時に segfault した)。保持量は数十バイトで、
        // 解放しても得るものは無い
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
