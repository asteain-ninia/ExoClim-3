// WebGPU デバイスの取得 — **ブラウザ専用**(`navigator.gpu` を使う)。
//
// 対応 spec: なし(実行基盤)。Node 側は device_node.ts。
// バッファ補助と限界値の設定は両環境共通で device.ts にある。
//
// Node 側と違う点(あちらの注意書きをそのまま持ち込まないこと):
//  - GC で adapter が消えて segfault する話は**ネイティブバインディング固有**で、
//    ブラウザには無い。keepAlive 相当は要らない。
//  - 代わりにブラウザ固有の失敗がある: **デバイス消失**(GPU ドライバの
//    リセット / タブの破棄 / 別プロセスの負荷)。消失したデバイスは以後
//    すべての操作が黙って失敗するため、検知したら CPU 実装へ落とす。
//  - `navigator.gpu` は安全なコンテキスト(https / localhost)でしか生えない。
//
// 検証エラーを捕まえる設定は Node と違って**常に有効**にする。ブラウザには
// 環境変数が無く、かつ黙って捨てられると「結果が全部ゼロ」としてしか
// 現れないため(2026-08-01 に Node で実際に踏んだのと同じ失敗の形)。

import { requestDeviceWithLimits, type GpuContext } from './device';

let cached: GpuContext | null = null;
let unavailableReason: string | null = null;
/** デバイス消失を検知したら立てる。以後は CPU 実装へ落ちる */
let deviceLost = false;

/** Worker からも読めるように WorkerNavigator 側も見る */
function getGpu(): GPU | null {
  const nav: unknown = typeof navigator === 'undefined' ? null : navigator;
  if (!nav) return null;
  const gpu = (nav as { gpu?: GPU }).gpu;
  return gpu ?? null;
}

/**
 * ブラウザの GPU を取得する。使えなければ null(呼び出し側は CPU 実装へ落ちる)。
 * 一度取得したデバイスは使い回す — デバイス生成は数百 ms かかり、かつ
 * 加速器の常駐バッファがデバイスに紐づいているため。
 */
export async function acquireGpuInBrowser(): Promise<GpuContext | null> {
  if (cached && !deviceLost) return cached;
  if (unavailableReason) return null;
  try {
    const gpu = getGpu();
    if (!gpu) {
      unavailableReason = 'このブラウザ(または安全でないコンテキスト)では WebGPU が使えない';
      return null;
    }
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      unavailableReason = 'WebGPU アダプタを取得できない';
      return null;
    }
    const device = await requestDeviceWithLimits(adapter);
    deviceLost = false;
    device.addEventListener?.('uncapturederror', (ev: Event) => {
      const err = (ev as unknown as { error?: { message?: string } }).error;
      console.error('[WebGPU エラー]', err?.message ?? String(ev));
    });
    void device.lost.then((info: { reason?: string; message?: string }) => {
      // reason === 'destroyed' は自分で destroy() を呼んだとき。それ以外は事故
      if (info.reason !== 'destroyed') {
        deviceLost = true;
        unavailableReason = `WebGPU デバイスが消失した(${info.reason ?? '不明'}: ${info.message ?? ''})`;
        console.error(`[WebGPU デバイス消失] ${unavailableReason}`);
      }
    });
    cached = {
      device,
      adapterInfo: describeAdapter(adapter),
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

/** GPU が使えない理由(使える場合は null)。デバイス消失後もここに出る */
export function browserGpuUnavailableReason(): string | null {
  return unavailableReason;
}

/** 実行中にデバイスが消えたか。true なら結果を信用してはいけない */
export function isBrowserGpuLost(): boolean {
  return deviceLost;
}

function describeAdapter(adapter: GPUAdapter): string {
  // adapter.info は比較的新しい API。無ければ素っ気ない表示にする
  const info = (adapter as { info?: { vendor?: string; architecture?: string; device?: string } })
    .info;
  if (!info) return 'WebGPU (ブラウザ)';
  const parts = [info.vendor, info.architecture, info.device].filter((s) => s && s.length > 0);
  return parts.length > 0 ? `WebGPU (${parts.join(' / ')})` : 'WebGPU (ブラウザ)';
}
