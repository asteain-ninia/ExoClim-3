import { expect, test } from '@playwright/test';

test('起動 → 計算完了 → 気候区分マップが描画される', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('params-panel')).toBeVisible();
  // 初回計算(2° で数秒)の完了を待つ
  await expect(page.getByTestId('computing-indicator')).toBeHidden({ timeout: 60_000 });
  // Canvas に海以外の色が描かれている(気候区分の凡例も表示)
  await expect(page.getByTestId('legend')).toBeVisible();
  const nonOcean = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.map-base');
    if (!canvas) return -1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return -1;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 16 * 4) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      if (!(r === 18 && g === 32 && b === 58)) count++;
    }
    return count;
  });
  expect(nonOcean).toBeGreaterThan(500);
  await page.screenshot({ path: 'test-results/app-koppen.png', fullPage: true });
});

test('手順オーバーレイ(海流・気圧)が描画される', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('computing-indicator')).toBeHidden({ timeout: 60_000 });
  await page.getByTestId('overlay-currents').click();
  await page.screenshot({ path: 'test-results/app-currents.png', fullPage: false });
  await page.getByTestId('overlay-pressure').click();
  await page.getByTestId('month-0').click();
  await page.locator('.toggle-inline', { hasText: '風' }).locator('input').check();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/app-pressure-jan.png', fullPage: false });
  await page.getByTestId('month-6').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/app-pressure-jul.png', fullPage: false });
});

test('オーバーレイと月の切替でマップが変化する', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('computing-indicator')).toBeHidden({ timeout: 60_000 });
  const fingerprint = () =>
    page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.map-base');
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return -1;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 16 * 4) {
        sum = (sum + (data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0)) % 1_000_000_007;
      }
      return sum;
    });
  const koppen = await fingerprint();
  await page.getByTestId('overlay-temperature').click();
  const tempAnnual = await fingerprint();
  expect(tempAnnual).not.toBe(koppen);
  // 1月 と 7月 で気温マップが変わる(季節サイクルの e2e 検証)
  await page.getByTestId('month-0').click();
  const tempJan = await fingerprint();
  await page.getByTestId('month-6').click();
  const tempJul = await fingerprint();
  expect(tempJan).not.toBe(tempJul);
  await page.screenshot({ path: 'test-results/app-temp-jul.png', fullPage: true });
});
