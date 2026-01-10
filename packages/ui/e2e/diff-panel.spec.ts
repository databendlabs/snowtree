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
    await expect(page.getByTestId('diff-viewer-zed')).toBeVisible();
  });

  test('should close diff overlay with Back button', async ({ page }) => {
    const file = page.getByTestId('right-panel-file-tracked-src/components/Example.tsx');
    await expect(file).toBeVisible({ timeout: 15000 });
    await file.click();

    await expect(page.getByTestId('diff-overlay')).toBeVisible();
    await page.getByTestId('diff-overlay-back').click();
    await expect(page.getByTestId('diff-overlay')).toHaveCount(0);
  });

  test('keeps gutter and file header fixed when horizontally scrolling', async ({ page }) => {
    const file = page.getByTestId('right-panel-file-tracked-src/components/Example.tsx');
    await expect(file).toBeVisible({ timeout: 15000 });
    await file.click();

    const overlay = page.getByTestId('diff-overlay');
    await expect(overlay).toBeVisible();

    const scroller = page.getByTestId('diff-scroll-container');
    await expect(scroller).toBeVisible();
    const xbar = page.getByTestId('diff-x-scrollbar');
    await expect(xbar).toBeVisible();

    const fileRoot = page.locator('[data-testid="diff-file"][data-diff-file-path="src/components/Example.tsx"]');
    const header = fileRoot.getByTestId('diff-file-header');

    const changedLine = fileRoot
      .locator('tr.diff-line')
      .filter({ has: page.locator('.diff-code-insert, .diff-code-delete') })
      .first();

    const gutter1 = changedLine.locator('td.diff-gutter').nth(0);
    const gutter2 = changedLine.locator('td.diff-gutter').nth(1);
    const code = changedLine.locator('td.diff-code').first();

    const diagnostics0 = await fileRoot.evaluate((root) => {
      const headerEl = root.querySelector('[data-testid="diff-file-header"]') as HTMLElement | null;
      const table = root.querySelector('table.diff') as HTMLElement | null;
      const scroller = root.closest('[data-testid="diff-scroll-container"]') as HTMLElement | null;
      const xbar = document.querySelector('[data-testid="diff-x-scrollbar"]') as HTMLElement | null;
      const hscroll = root.querySelector('[data-testid="diff-hscroll-container"]') as HTMLElement | null;
      const changedRow = Array.from(root.querySelectorAll('tr.diff-line')).find((row) =>
        Boolean(row.querySelector('.diff-code-insert, .diff-code-delete'))
      ) as HTMLElement | undefined;
      const gutterCells = changedRow ? (Array.from(changedRow.querySelectorAll('td.diff-gutter')) as HTMLElement[]) : [];
      return {
        tableClass: table?.className ?? null,
        headerPos: headerEl ? getComputedStyle(headerEl).position : null,
        gutterPos: gutterCells.map((c) => getComputedStyle(c).position),
        scrollerOverflowX: scroller ? getComputedStyle(scroller).overflowX : null,
        scrollerOverflowY: scroller ? getComputedStyle(scroller).overflowY : null,
        xbarOverflowX: xbar ? getComputedStyle(xbar).overflowX : null,
        hscrollOverflowX: hscroll ? getComputedStyle(hscroll).overflowX : null,
        scrollerTransform: scroller ? getComputedStyle(scroller).transform : null,
        rootTransform: getComputedStyle(root as HTMLElement).transform,
        bodyTransform: getComputedStyle(document.body).transform,
      };
    });
    expect(diagnostics0.tableClass).toContain('diff-unified');
    expect(diagnostics0.headerPos).toBe('sticky');
    expect(diagnostics0.gutterPos[0]).toBe('sticky');
    expect(diagnostics0.gutterPos[1]).toBe('sticky');
    expect(diagnostics0.scrollerOverflowX).toBe('hidden');
    expect(diagnostics0.scrollerOverflowY).toMatch(/auto|scroll/);
    expect(diagnostics0.xbarOverflowX).toMatch(/auto|scroll/);
    expect(diagnostics0.hscrollOverflowX).toMatch(/auto|scroll/);
    expect(diagnostics0.scrollerTransform).toBe('none');
    expect(diagnostics0.rootTransform).toBe('none');
    expect(diagnostics0.bodyTransform).toBe('none');

    const headerBox0 = await header.boundingBox();
    const gutter1Box0 = await gutter1.boundingBox();
    const gutter2Box0 = await gutter2.boundingBox();
    const codeBox0 = await code.boundingBox();
    expect(headerBox0).not.toBeNull();
    expect(gutter1Box0).not.toBeNull();
    expect(gutter2Box0).not.toBeNull();
    expect(codeBox0).not.toBeNull();

    // Regression guard: the first gutter cell on changed rows must stay sticky (we previously
    // accidentally overrode it with `position: relative`, which made the left marker rail scroll).
    const positions0 = await changedLine.evaluate((line) => {
      const tds = Array.from(line.querySelectorAll('td.diff-gutter')) as HTMLElement[];
      const a = tds[0] as HTMLElement | undefined;
      const b = tds[1] as HTMLElement | undefined;
      return {
        a: a ? getComputedStyle(a).position : null,
        b: b ? getComputedStyle(b).position : null,
        beforeWidth: a ? getComputedStyle(a, '::before').width : null,
      };
    });
    expect(positions0.a).toBe('sticky');
    expect(positions0.b).toBe('sticky');
    expect(positions0.beforeWidth).toBe('4px');

    await xbar.evaluate((el) => {
      (el as HTMLElement).scrollLeft = 300;
    });
    await page.waitForTimeout(50);

    const headerBox1 = await header.boundingBox();
    const gutter1Box1 = await gutter1.boundingBox();
    const gutter2Box1 = await gutter2.boundingBox();
    const codeBox1 = await code.boundingBox();
    expect(headerBox1).not.toBeNull();
    expect(gutter1Box1).not.toBeNull();
    expect(gutter2Box1).not.toBeNull();
    expect(codeBox1).not.toBeNull();

    expect(Math.abs((headerBox1!.x) - (headerBox0!.x))).toBeLessThan(1);
    expect(Math.abs((gutter1Box1!.x) - (gutter1Box0!.x))).toBeLessThan(1);
    expect(Math.abs((gutter2Box1!.x) - (gutter2Box0!.x))).toBeLessThan(1);
    expect(gutter2Box1!.x).toBeGreaterThanOrEqual(gutter1Box1!.x + gutter1Box1!.width - 1);
    expect(Math.abs((codeBox1!.x) - (codeBox0!.x))).toBeGreaterThan(20);
  });

  test('shows staged badge without covering line numbers', async ({ page }) => {
    const file = page.getByTestId('right-panel-file-tracked-src/components/Example.tsx');
    await expect(file).toBeVisible({ timeout: 15000 });
    await file.click();

    await expect(page.getByTestId('diff-overlay')).toBeVisible();
    const scroller = page.getByTestId('diff-scroll-container');
    await expect(scroller).toBeVisible();
    const xbar = page.getByTestId('diff-x-scrollbar');
    await expect(xbar).toBeVisible();

    const stagedFileRoot = page.locator('[data-testid="diff-file"][data-diff-file-path="src/components/Staged.tsx"]');
    await stagedFileRoot.scrollIntoViewIfNeeded();

    const badge = stagedFileRoot.locator('.st-hunk-staged-badge').first();
    await expect(badge).toBeVisible();

    const firstLine = stagedFileRoot
      .locator('tr.diff-line')
      .filter({ has: page.locator('.diff-code-insert, .diff-code-delete') })
      .first();
    const gutter1 = firstLine.locator('td.diff-gutter').nth(0);

    const overlap = await page.evaluate(() => {
      const root = document.querySelector('[data-diff-file-path="src/components/Staged.tsx"]');
      if (!root) return null;
      const badgeEl = root.querySelector('.st-hunk-staged-badge') as HTMLElement | null;
      const changedLine = Array.from(root.querySelectorAll('tr.diff-line')).find((row) =>
        Boolean(row.querySelector('.diff-code-insert, .diff-code-delete'))
      ) as HTMLElement | undefined;
      const gutter = changedLine?.querySelectorAll('td.diff-gutter')?.[0] as HTMLElement | undefined;
      if (!badgeEl || !gutter) return null;

      const badgeRect = badgeEl.getBoundingClientRect();

      // Compute the bounding rect of the line number text only (ignore SVG badge).
      const walker = document.createTreeWalker(gutter, NodeFilter.SHOW_TEXT);
      const textNodes: Text[] = [];
      while (walker.nextNode()) {
        const n = walker.currentNode as Text;
        if ((n.textContent || '').trim().length > 0) textNodes.push(n);
      }
      if (textNodes.length === 0) return null;

      const range = document.createRange();
      range.setStart(textNodes[0]!, 0);
      const last = textNodes[textNodes.length - 1]!;
      range.setEnd(last, last.textContent?.length ?? 0);
      const textRect = range.getBoundingClientRect();

      return { badgeRight: badgeRect.right, textLeft: textRect.left };
    });

    // Badge lives on the left edge; the right-aligned line numbers live on the right.
    // If these overlap, the badge is covering the numbers.
    expect(overlap).not.toBeNull();
    expect(overlap!.badgeRight).toBeLessThanOrEqual(overlap!.textLeft + 1);

    // Badge should sit near the vertical middle of the changed-range rail.
    const middle = await stagedFileRoot.evaluate(() => {
      const root = document.querySelector('[data-diff-file-path="src/components/Staged.tsx"]');
      if (!root) return null;
      const badgeEl = root.querySelector('.st-hunk-staged-badge') as HTMLElement | null;
      if (!badgeEl) return null;
      const changedRows = Array.from(root.querySelectorAll('tr.diff-line')).filter((row) =>
        Boolean(row.querySelector('.diff-code-insert, .diff-code-delete'))
      ) as HTMLElement[];
      if (changedRows.length === 0) return null;
      const first = changedRows[0]!.getBoundingClientRect();
      const last = changedRows[changedRows.length - 1]!.getBoundingClientRect();
      const badge = badgeEl.getBoundingClientRect();
      return {
        badgeCy: (badge.top + badge.bottom) / 2,
        railTop: first.top,
        railBottom: last.bottom,
      };
    });
    expect(middle).not.toBeNull();
    expect(middle!.badgeCy).toBeGreaterThan(middle!.railTop);
    expect(middle!.badgeCy).toBeLessThan(middle!.railBottom);
    const railMid = (middle!.railTop + middle!.railBottom) / 2;
    // Within ~40% of the rail height from center (tolerant to small hunks and fonts).
    expect(Math.abs(middle!.badgeCy - railMid)).toBeLessThan((middle!.railBottom - middle!.railTop) * 0.4 + 8);

    // Horizontal scroll should not move the gutters/badge.
    const badgeBox0 = await badge.boundingBox();
    const gutterBox0 = await gutter1.boundingBox();
    expect(badgeBox0).not.toBeNull();
    expect(gutterBox0).not.toBeNull();

    await xbar.evaluate((el) => { (el as HTMLElement).scrollLeft = 260; });
    await page.waitForTimeout(50);

    const badgeBox1 = await badge.boundingBox();
    const gutterBox1 = await gutter1.boundingBox();
    expect(badgeBox1).not.toBeNull();
    expect(gutterBox1).not.toBeNull();
    expect(Math.abs((badgeBox1!.x) - (badgeBox0!.x))).toBeLessThan(1);
    expect(Math.abs((gutterBox1!.x) - (gutterBox0!.x))).toBeLessThan(1);
  });

  test('keeps all files horizontally aligned (including short files)', async ({ page }) => {
    const file = page.getByTestId('right-panel-file-tracked-src/components/Example.tsx');
    await expect(file).toBeVisible({ timeout: 15000 });
    await file.click();

    await expect(page.getByTestId('diff-overlay')).toBeVisible();
    const xbar = page.getByTestId('diff-x-scrollbar');
    await expect(xbar).toBeVisible();

    const helperRoot = page.locator('[data-testid="diff-file"][data-diff-file-path="src/utils/helper.ts"]');
    await helperRoot.scrollIntoViewIfNeeded();

    const helperCode = helperRoot.locator('td.diff-code').first();
    await expect(helperCode).toBeVisible();

    const box0 = await helperCode.boundingBox();
    expect(box0).not.toBeNull();

    await xbar.evaluate((el) => {
      (el as HTMLElement).scrollLeft = 300;
    });
    await page.waitForTimeout(50);

    const box1 = await helperCode.boundingBox();
    expect(box1).not.toBeNull();
    expect(Math.abs((box1!.x) - (box0!.x))).toBeGreaterThan(20);
  });
});
