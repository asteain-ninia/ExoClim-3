import { expect, test, type Page } from '@playwright/test';

// 2026-08-03: 自動実行をやめてボタン起動にしたので、**1 回の計算を共有**する
// 1 本のテストに束ねてある。以前はテストごとに再計算していたが、
// 1 回が数分かかるようになった今それをやると e2e 全体が 40 分を超える。
//
// 検査項目そのものは以前と同じ: 気候区分が描かれる / 手順オーバーレイが描かれる /
// ドラッグ周回と球体表示 / 月とオーバーレイの切替で絵が変わる。

/** キャンバスの指紋(位置重み付き — 巡回シフトでも値が変わる) */
function fingerprint(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.map-base');
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return -1;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 16 * 4) {
      const w = 1 + ((i / 4) % 997);
      sum = (sum + w * ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0))) % 1_000_000_007;
    }
    return sum;
  });
}

// **遅いテスト**(実測 約 10 分 / 地球 1°、GPU)。収束するまで回すので
// これ以上は縮まない — 費用の 97.9% が EBM だから(docs/ブラウザ側の快適化)。
// 途中経過だけを見る速いテストは interactive.spec.ts のほう。
test('計算 → 気候区分マップ → 各オーバーレイ → 表示操作', async ({ page }) => {
  test.setTimeout(1_800_000);
  await page.goto('/');
  await expect(page.getByTestId('params-panel')).toBeVisible();

  // ---- 計算を回して最後まで待つ ----
  await page.getByTestId('commit-button').click();
  await expect(page.getByTestId('computing-indicator')).toBeVisible({ timeout: 30_000 });
  const t0 = Date.now();
  await expect(page.getByTestId('computing-indicator')).toBeHidden({ timeout: 1_500_000 });
  console.log(`[本計算] 完了まで ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
  // ワーカーがエラーを返していないこと(process 参照事故などの回帰ガード)
  await expect(page.locator('.error-badge')).toHaveCount(0);
  // 走りきったので、どの層も「未計算」ではない
  await expect(page.getByTestId('layer-pending')).toHaveCount(0);

  // ---- 気候区分が描かれている ----
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
  const koppen = await fingerprint(page);

  // ---- 手順オーバーレイ(海流・気圧・観測) ----
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
  await page.getByTestId('overlay-koppenObs').click();
  await expect(page.getByTestId('legend')).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/app-koppen-obs.png', fullPage: false });

  // ---- オーバーレイと月の切替で絵が変わる ----
  await page.getByTestId('overlay-koppen').click();
  await page.waitForTimeout(200);
  await page.getByTestId('overlay-temperature').click();
  const tempAnnual = await fingerprint(page);
  expect(tempAnnual).not.toBe(koppen);
  // 1月 と 7月 で気温マップが変わる(季節サイクルの e2e 検証)
  await page.getByTestId('month-0').click();
  const tempJan = await fingerprint(page);
  await page.getByTestId('month-6').click();
  const tempJul = await fingerprint(page);
  expect(tempJan).not.toBe(tempJul);
  await page.screenshot({ path: 'test-results/app-temp-jul.png', fullPage: true });

  // ---- ドラッグ周回・360°超スパン・球体表示 ----
  const before = await fingerprint(page);
  const map = page.getByTestId('map-canvas');
  const box = await map.boundingBox();
  if (!box) throw new Error('map-canvas が見つからない');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 173, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const panned = await fingerprint(page);
  expect(panned).not.toBe(before);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(200);
  const zoomedOut = await fingerprint(page);
  expect(zoomedOut).not.toBe(panned);
  await page.screenshot({ path: 'test-results/app-wide-span.png', fullPage: false });

  await page.getByTestId('view-globe').click();
  await page.waitForTimeout(300);
  const globe = await fingerprint(page);
  expect(globe).not.toBe(zoomedOut);
  await page.screenshot({ path: 'test-results/app-globe.png', fullPage: false });
  await page.getByTestId('view-flat').click();
});
