import { test, expect } from './fixtures';
import { openFirstWorktree } from './app-helpers';

test.describe('Stage Operations (Diff Overlay)', () => {
  test.beforeEach(async ({ page }) => {
    await openFirstWorktree(page);
  });

  async function hoverFirstChangedLineInFile(page: any, filePath: string) {
    const fileRoot = page.locator(`[data-testid="diff-file"][data-diff-file-path="${filePath}"]`);
    await expect(fileRoot).toBeVisible();
    const firstChangedLine = fileRoot
      .locator('diffs-container [data-line-type="change-addition"], diffs-container [data-line-type="change-deletion"]')
      .first();
    await expect(firstChangedLine).toBeVisible();
    await firstChangedLine.hover();
    return fileRoot;
  }

  test('stages a hunk via per-hunk controls (Zed-style)', async ({ page }) => {
    const file = page.getByTestId('right-panel-file-tracked-src/components/Example.tsx');
    await expect(file).toBeVisible({ timeout: 15000 });
    await file.click();

    await expect(page.getByTestId('diff-overlay')).toBeVisible();

    const fileRoot = await hoverFirstChangedLineInFile(page, 'src/components/Example.tsx');
    const stage = fileRoot.locator('[data-testid="diff-hunk-stage"]').first();
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

    const fileRoot = await hoverFirstChangedLineInFile(page, 'src/components/Example.tsx');
    const restore = fileRoot.locator('[data-testid="diff-hunk-restore"]').first();
    await expect(restore).toBeVisible();
    await restore.click();

    const lastCall = await page.evaluate(() => (window as any).__e2e_lastRestoreHunk);
    expect(lastCall?.options?.filePath).toBe('src/components/Example.tsx');

    await page.getByTestId('diff-overlay-back').click();
    await expect(page.getByTestId('diff-overlay')).toHaveCount(0);
  });
});
