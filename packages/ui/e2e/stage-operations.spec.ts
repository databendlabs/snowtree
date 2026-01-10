import { test, expect } from './fixtures';
import { openFirstWorktree } from './app-helpers';

test.describe('Stage Operations (Diff Overlay)', () => {
  test.beforeEach(async ({ page }) => {
    await openFirstWorktree(page);
  });

  async function getActiveHunkOverlayFor(firstEditHunk: any, page: any) {
    const anchor = firstEditHunk.locator('[data-hunk-anchor="true"][data-hunk-key]').first();
    const hunkKey = await anchor.getAttribute('data-hunk-key');
    expect(hunkKey).toBeTruthy();
    const overlay = page.getByTestId('diff-hunk-actions-overlay');
    await expect(overlay).toBeVisible();
    return overlay.locator(`[data-hunk-key="${hunkKey}"]`).first();
  }

  test('stages a hunk via per-hunk controls (Zed-style)', async ({ page }) => {
    const file = page.getByTestId('right-panel-file-tracked-src/components/Example.tsx');
    await expect(file).toBeVisible({ timeout: 15000 });
    await file.click();

    await expect(page.getByTestId('diff-overlay')).toBeVisible();
    await expect(page.getByTestId('diff-viewer-zed')).toBeVisible();

    const firstEditHunk = page
      .locator(`[data-testid="diff-file"][data-diff-file-path="src/components/Example.tsx"] .diff-hunk`)
      .filter({ has: page.locator('.diff-code-insert, .diff-code-delete') })
      .first();
    await firstEditHunk.hover();
    const overlayInner = await getActiveHunkOverlayFor(firstEditHunk, page);
    const stage = overlayInner.getByTestId('diff-hunk-stage');
    await expect(stage).toBeVisible();
    await stage.click();

    const lastCall = await page.evaluate(() => (window as any).__e2e_lastStageHunk);
    expect(lastCall?.options?.filePath).toBe('src/components/Example.tsx');

    await page.getByTestId('diff-overlay-back').click();
    await expect(page.getByTestId('diff-overlay')).toHaveCount(0);
  });

  test('restores a hunk via per-hunk controls (Zed-style)', async ({ page }) => {
    const file = page.getByTestId('right-panel-file-tracked-src/components/Example.tsx');
    await expect(file).toBeVisible({ timeout: 15000 });
    await file.click();

    await expect(page.getByTestId('diff-overlay')).toBeVisible();
    await expect(page.getByTestId('diff-viewer-zed')).toBeVisible();

    const firstEditHunk = page
      .locator(`[data-testid="diff-file"][data-diff-file-path="src/components/Example.tsx"] .diff-hunk`)
      .filter({ has: page.locator('.diff-code-insert, .diff-code-delete') })
      .first();
    await firstEditHunk.hover();
    const overlayInner = await getActiveHunkOverlayFor(firstEditHunk, page);
    const restore = overlayInner.getByTestId('diff-hunk-restore');
    await expect(restore).toBeVisible();
    await restore.click();

    const lastCall = await page.evaluate(() => (window as any).__e2e_lastRestoreHunk);
    expect(lastCall?.options?.filePath).toBe('src/components/Example.tsx');

    await page.getByTestId('diff-overlay-back').click();
    await expect(page.getByTestId('diff-overlay')).toHaveCount(0);
  });
});
