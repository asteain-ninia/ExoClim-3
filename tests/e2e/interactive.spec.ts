// ブラウザ側の操作モデル(2026-08-03)の e2e:
//   ボタン起動 / 途中経過が本表示に出る / キャンセル / 進捗 /
//   パラメータと地図のずれの明示。
//
// smoke.spec.ts が「絵が出る」ことを見るのに対し、こちらは
// **操作したときの振る舞い**を見る。

import { expect, test, type Page } from '@playwright/test';

/** 「計算する」を押して、走り出すまで待つ */
async function startRun(page: Page): Promise<void> {
  await page.getByTestId('commit-button').click();
  await expect(page.getByTestId('computing-indicator')).toBeVisible({ timeout: 30_000 });
}

/** 計算が終わる(または中断される)まで待つ */
async function waitForIdle(page: Page): Promise<void> {
  await expect(page.getByTestId('computing-indicator')).toBeHidden({ timeout: 300_000 });
}

test('起動しただけでは計算が始まらない(ボタン起動)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('params-panel')).toBeVisible();
  // まだ計算していないことが文章で言われている
  await expect(page.getByTestId('never-computed-note')).toBeVisible();
  // 5 秒待っても計算は始まらない
  await page.waitForTimeout(5000);
  await expect(page.getByTestId('computing-indicator')).toHaveCount(0);
  await expect(page.locator('.error-badge')).toHaveCount(0);
});

test('WebGPU がワーカーで使えている(落ちていたら理由が表示に出る)', async ({ page }) => {
  await page.goto('/');
  // **必ず goto の後に**見ること — about:blank では安全なコンテキストでないため
  // navigator.gpu が生えず、「WebGPU 無し」と誤読する(2026-08-02 に踏んだ)
  const pageHasWebgpu = await page.evaluate(() => 'gpu' in navigator);

  await startRun(page);
  // **完了を待たない**。加速器の別は走り出しに知らされる(そうでないと
  // GPU なのか CPU に落ちたのかが数分わからず、待つ判断ができない)
  const accel = page.getByTestId('monitor-accel');
  await expect(accel).toBeVisible({ timeout: 60_000 });
  const text = (await accel.textContent()) ?? '';
  console.log(`[加速器] page has navigator.gpu = ${pageHasWebgpu} / 表示: ${text.trim()}`);
  // CPU に落ちていても動くこと自体は正しい。ただし**理由が見えている**こと
  expect(text).toMatch(/WebGPU|CPU 実装/);

  await page.getByTestId('header-cancel-button').click();
  await waitForIdle(page);
  await expect(page.locator('.error-badge')).toHaveCount(0);
});

test('計算中は途中経過が本表示に出て、段が進むごとに層が増える', async ({ page }) => {
  await page.goto('/');
  await startRun(page);

  // 途中経過であることが明示される
  await expect(page.getByTestId('in-progress-note')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('compute-monitor')).toBeVisible();
  await expect(page.getByTestId('monitor-percent')).toBeVisible();

  // 既定の層(気候区分)は EBM のあいだずっと未計算。**それが一目で分かること**を
  // 固定する。2026-08-03 に「切り替えが効かない」と報告された退行の防止:
  // 未計算の層は地形へ退避するので、印が無いと別々のタブが同じ絵に見え、
  // 月ボタンも(地形が月を持たないので)効かないように見える。
  const pendingNote = page.getByTestId('layer-pending');
  await expect(pendingNote).toBeVisible({ timeout: 30_000 });
  await expect(pendingNote).toContainText('気候区分はまだ計算されていません');
  // いま見られる層が挙がっている(「何も進んでいない」に見せない)
  await expect(page.getByTestId('ready-layers')).toContainText('地形');
  // 月ボタンが効かないことも明示されている
  await expect(page.getByTestId('month-inert-note')).toBeVisible();
  // 未計算のタブには印がついている(押す前に分かる)
  await expect(page.getByTestId('overlay-koppen')).toHaveClass(/tab--pending/);
  // 計算済みのタブには印がつかない
  await expect(page.getByTestId('overlay-terrain')).not.toHaveClass(/tab--pending/);

  // 循環の層は 1 秒足らずで揃うので、すぐ見られるようになる
  await page.getByTestId('overlay-currents').click();
  await expect(page.getByTestId('layer-pending')).toHaveCount(0, { timeout: 60_000 });
  // 使える層に移れば月ボタンも効く(不活性の断りは消える)
  await expect(page.getByTestId('month-inert-note')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/live-currents.png', fullPage: true });

  // 気温の層は EBM のモデル内 1 年ぶんが揃うと出る
  await page.getByTestId('overlay-temperature').click();
  await expect(page.getByTestId('layer-pending')).toHaveCount(0, { timeout: 180_000 });
  await page.screenshot({ path: 'test-results/live-temperature.png', fullPage: true });

  // 実際に色が塗られている(海一色ではない)
  const painted = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.map-base');
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return -1;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set<string>();
    for (let i = 0; i < d.length; i += 4 * 64) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
    return seen.size;
  });
  expect(painted).toBeGreaterThan(8);

  await page.getByTestId('header-cancel-button').click();
  await waitForIdle(page);
  await expect(page.locator('.error-badge')).toHaveCount(0);
});

test('進捗が前へ進み、中止できる', async ({ page }) => {
  await page.goto('/');
  await startRun(page);

  const detail = page.getByTestId('monitor-stage');
  await expect(detail).toBeVisible();
  const before = await detail.textContent();
  // **百分率では測らない** — 本計算は数分かかるので数秒では丸めて同じ値になる
  await expect
    .poll(async () => (await detail.textContent()) !== before, { timeout: 120_000 })
    .toBe(true);
  console.log(`[進捗] ${before?.trim()} → ${(await detail.textContent())?.trim()}`);

  // 中止は terminate ではなく協調的な中断。数秒で効く
  await page.getByTestId('cancel-button').click();
  await waitForIdle(page);
  await expect(page.getByTestId('compute-monitor')).toHaveCount(0);
  // 中止はエラーではない
  await expect(page.locator('.error-badge')).toHaveCount(0);
});

test('パラメータを動かすと「ずれている」と出て、計算は勝手に始まらない', async ({ page }) => {
  await page.goto('/');
  await startRun(page);
  // 途中で止めてよい(ずれの判定は計算の完了とは無関係)
  await page.getByTestId('header-cancel-button').click();
  await waitForIdle(page);
  await expect(page.getByTestId('dirty-note')).toHaveCount(0);

  // 温室効果のスライダーを動かす
  const slider = page.locator('input[type="range"]').first();
  await slider.evaluate((el: HTMLInputElement) => {
    el.value = String(Number(el.value) + (Number(el.max) - Number(el.min)) * 0.1);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // ずれが明示され、かつ**計算は始まらない**
  await expect(page.getByTestId('dirty-note')).toBeVisible();
  await page.waitForTimeout(3000);
  await expect(page.getByTestId('computing-indicator')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/live-dirty.png', fullPage: true });
});
