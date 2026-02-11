import { test, expect } from './fixtures';
import { openFirstWorktree } from './app-helpers';

test.describe('Diff Panel and Stage Operations', () => {
  test.beforeEach(async ({ page }) => {
    await openFirstWorktree(page);
  });

  test('should open diff overlay when clicking file', async ({ page }) => {
    const file = page.getByTestId('right-panel-file-tracked-src/components/Example.tsx');
    await expect(file).toBeVisible({ timeout: 15000 });
    await file.click();

    await expect(page.getByTestId('diff-overlay')).toBeVisible();
    await expect(page.getByTestId('diff-scroll-container')).toBeVisible();
    await expect(page.locator('diffs-container').first()).toBeVisible();
  });

  test('should close diff overlay with Back button', async ({ page }) => {
    const file = page.getByTestId('right-panel-file-tracked-src/components/Example.tsx');
    await expect(file).toBeVisible({ timeout: 15000 });
    await file.click();

    await expect(page.getByTestId('diff-overlay')).toBeVisible();
    await page.getByTestId('diff-overlay-back').click();
    await expect(page.getByTestId('diff-overlay')).toHaveCount(0);
  });

  test('orders diff files by stage state (staged first)', async ({ page }) => {
    const file = page.getByTestId('right-panel-file-tracked-src/components/Staged.tsx');
    await expect(file).toBeVisible({ timeout: 15000 });
    await file.click();

    await expect(page.getByTestId('diff-overlay')).toBeVisible();
    await expect(page.getByTestId('diff-scroll-container')).toBeVisible();

    const paths = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('[data-testid="diff-file"]')) as HTMLElement[];
      return nodes.map((n) => n.getAttribute('data-diff-file-path'));
    });
    expect(paths.slice(0, 3)).toEqual([
      'src/components/Staged.tsx',
      'src/components/Example.tsx',
      'src/utils/helper.ts',
    ]);
  });

  test('supports expanding context by loading full file content', async ({ page }) => {
    const file = page.getByTestId('right-panel-file-tracked-src/components/Staged.tsx');
    await expect(file).toBeVisible({ timeout: 15000 });
    await file.click();

    await expect(page.getByTestId('diff-overlay')).toBeVisible();

    const stagedFileRoot = page.locator('[data-testid="diff-file"][data-diff-file-path="src/components/Staged.tsx"]');
    await expect(stagedFileRoot).toBeVisible();

    const diffs = stagedFileRoot.locator('diffs-container');
    await expect(diffs).toBeVisible();

    // With full context loaded, line-info separators should include expand controls.
    const expandButton = diffs.locator('[data-expand-button]').first();
    await expect(expandButton).toBeVisible();

    const marker = diffs.locator('[data-unmodified-lines]').first();
    await expect(marker).toBeVisible();

    await expandButton.click();
    await expect(diffs.locator('[data-unmodified-lines]')).toHaveCount(0);
  });
});
