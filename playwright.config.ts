import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1480, height: 940 },
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
