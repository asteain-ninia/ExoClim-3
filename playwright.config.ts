import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1480, height: 940 },
  },
  webServer: {
    command: 'npm run preview',
    port: 4173,
    // 常に自前でサーバを起動する。true だと残骸サーバの「古いビルド」を
    // 検証してしまい、ブラウザ非互換(process 参照事故)を見逃す。
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
