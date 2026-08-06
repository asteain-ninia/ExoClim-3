import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1480, height: 940 },
    // 既定の chromium-headless-shell には GPU が無く、WebGPU のアダプタが
    // 取れない(実測 2026-08-02: "No available adapters." で CPU 実装へ落ちた)。
    // フル Chromium を明示して GPU 経路を通す
    channel: 'chromium',
    launchOptions: {
      // WebGPU はヘッドレス Chromium では既定で無効。計算の主経路(GPU)を
      // e2e で通すために明示的に開ける。開かないと**静かに CPU 実装へ落ち**、
      // 「遅いが通る」テストになって GPU 経路の退行を検出できない。
      // SwiftShader を許すのは GPU の無い CI でも経路を通すため
      // (速度は出ないが、シェーダのコンパイルと結果の形は検証できる)。
      args: [
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan',
        '--enable-unsafe-swiftshader',
      ],
    },
  },
  webServer: {
    // preview はビルドしない(dist の残骸を配るだけ)ため、必ず build を先行させる。
    // reuseExistingServer: false は「残骸サーバ」対策、build 先行は「残骸ビルド」対策。
    command: 'npm run build && npm run preview',
    port: 4173,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
