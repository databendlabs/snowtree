import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ZedDiffViewer } from './ZedDiffViewer';
import { API } from '../../../utils/api';

vi.mock('../../../utils/api', () => ({
  API: {
    sessions: {
      stageHunk: vi.fn(),
      changeFileStage: vi.fn(),
      restoreHunk: vi.fn(),
    },
  },
}));

const SAMPLE_DIFF_TWO_HUNKS = `diff --git a/test.txt b/test.txt
index 1234567..abcdefg 100644
--- a/test.txt
+++ b/test.txt
@@ -1,3 +1,4 @@
 context
-old
+new
 end
@@ -10,2 +11,3 @@
 a
+b
 c`;

const SAMPLE_DIFF_TWO_FILES = `diff --git a/b.txt b/b.txt
index 1234567..abcdefg 100644
--- a/b.txt
+++ b/b.txt
@@ -1,1 +1,1 @@
-x
+y
diff --git a/a.txt b/a.txt
index 1234567..abcdefg 100644
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,1 @@
-x
+y`;

describe('ZedDiffViewer', () => {
  function mockRect(el: Element, rect: Partial<DOMRect> & Pick<DOMRect, 'top' | 'height'>) {
    const full: DOMRect = {
      x: 0,
      y: rect.top ?? 0,
      top: rect.top,
      left: 0,
      right: 0,
      bottom: (rect.top ?? 0) + rect.height,
      width: rect.width ?? 0,
      height: rect.height,
      toJSON: () => ({}),
    } as any;
    Object.defineProperty(el, 'getBoundingClientRect', { value: () => full });
  }

  async function hoverFirstHunk(container: HTMLElement) {
    const codeCell = container.querySelector('td.diff-code') as HTMLElement | null;
    expect(codeCell).toBeTruthy();
    fireEvent.mouseMove(codeCell!);
    await waitFor(() => {
      const controls = screen.getAllByTestId('diff-hunk-controls')[0] as HTMLElement;
      expect(controls.classList.contains('st-hunk-hovered')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByTestId('diff-hunk-actions-overlay')).toBeInTheDocument();
      expect(screen.getByTestId('diff-hunk-stage')).toBeInTheDocument();
    });
  }

  it('renders viewer', () => {
    render(<ZedDiffViewer diff={SAMPLE_DIFF_TWO_HUNKS} />);
    expect(screen.getByTestId('diff-viewer-zed')).toBeInTheDocument();
  });

  it('expands modified files to full file when fileSources is provided', () => {
    const diff = `diff --git a/a.txt b/a.txt
index 1234567..abcdefg 100644
--- a/a.txt
+++ b/a.txt
@@ -2,1 +2,1 @@
-old
+new`;

    const { container } = render(<ZedDiffViewer diff={diff} fileSources={{ 'a.txt': 'one\nold\nthree' }} expandFileContext />);
    // one (context) + old (delete) + new (insert) + three (context)
    expect(container.querySelectorAll('tr.diff-line')).toHaveLength(4);
  });

  it('does not duplicate content when expanding a new file diff', () => {
    const diff = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..abcdefg
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+first
+second`;

    const { container } = render(<ZedDiffViewer diff={diff} fileSources={{ 'new.txt': 'first\nsecond' }} expandFileContext />);
    expect(container.querySelectorAll('tr.diff-line')).toHaveLength(2);
  });

  it('stages a hunk when scope is unstaged', async () => {
    (API.sessions.stageHunk as any).mockResolvedValue({ success: true, data: { success: true } });
    const { container } = render(
      <ZedDiffViewer
        diff={SAMPLE_DIFF_TWO_HUNKS}
        sessionId="s1"
        currentScope="unstaged"
        unstagedDiff={SAMPLE_DIFF_TWO_HUNKS}
      />
    );

    await hoverFirstHunk(container);
    const stage = screen.getAllByTestId('diff-hunk-stage')[0] as HTMLButtonElement;
    const user = userEvent.setup();
    await user.click(stage);

    await waitFor(() => {
      expect(API.sessions.stageHunk).toHaveBeenCalledWith('s1', expect.objectContaining({ isStaging: true }));
    });
  });

  it('unstages a hunk when scope is staged', async () => {
    (API.sessions.stageHunk as any).mockResolvedValue({ success: true, data: { success: true } });
    const { container } = render(
      <ZedDiffViewer
        diff={SAMPLE_DIFF_TWO_HUNKS}
        sessionId="s1"
        currentScope="staged"
        stagedDiff={SAMPLE_DIFF_TWO_HUNKS}
      />
    );

    await hoverFirstHunk(container);
    const stage = screen.getAllByTestId('diff-hunk-stage')[0] as HTMLButtonElement;
    const user = userEvent.setup();
    await user.click(stage);

    await waitFor(() => {
      expect(API.sessions.stageHunk).toHaveBeenCalledWith('s1', expect.objectContaining({ isStaging: false }));
    });
  });

  it('restores a hunk using the current scope', async () => {
    (API.sessions.restoreHunk as any).mockResolvedValue({ success: true, data: { success: true } });
    const { container } = render(
      <ZedDiffViewer
        diff={SAMPLE_DIFF_TWO_HUNKS}
        sessionId="s1"
        currentScope="unstaged"
        unstagedDiff={SAMPLE_DIFF_TWO_HUNKS}
      />
    );

    await hoverFirstHunk(container);
    const restore = screen.getAllByTestId('diff-hunk-restore')[0] as HTMLButtonElement;
    const user = userEvent.setup();
    await user.click(restore);

    await waitFor(() => {
      expect(API.sessions.restoreHunk).toHaveBeenCalledWith('s1', expect.objectContaining({ scope: 'unstaged' }));
    });
  });

  it('stages an untracked file (file-level stage)', async () => {
    (API.sessions.changeFileStage as any).mockResolvedValue({ success: true });
    const diff = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..abcdefg
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,1 @@
+hello`;

    const { container } = render(<ZedDiffViewer diff={diff} sessionId="s1" currentScope="untracked" />);

    await hoverFirstHunk(container);
    const stage = screen.getAllByTestId('diff-hunk-stage')[0] as HTMLButtonElement;
    const user = userEvent.setup();
    await user.click(stage);
    await waitFor(() => {
      expect(API.sessions.changeFileStage).toHaveBeenCalledWith('s1', { filePath: 'new.txt', stage: true });
    });
  });

  it('matches staged/unstaged hunks by signature + location (duplicate signatures)', async () => {
    (API.sessions.stageHunk as any).mockResolvedValue({ success: true, data: { success: true } });
    const diff = `diff --git a/a.txt b/a.txt
index 1234567..abcdefg 100644
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,2 @@
 x
+same
@@ -10,1 +11,2 @@
 y
+same`;

    const { container } = render(<ZedDiffViewer diff={diff} sessionId="s1" currentScope="unstaged" unstagedDiff={diff} />);
    const user = userEvent.setup();
    await hoverFirstHunk(container);
    const stageButtons = screen.getAllByTestId('diff-hunk-stage') as HTMLButtonElement[];
    await user.click(stageButtons[0]!);

    await waitFor(() => {
      expect(API.sessions.stageHunk).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({
          filePath: 'a.txt',
          isStaging: true,
          hunkHeader: expect.stringContaining('@@ -1,1 +1,2 @@'),
        })
      );
    });
  });

  it('marks hovered hunk to keep controls stable', async () => {
    const { container } = render(
      <ZedDiffViewer diff={SAMPLE_DIFF_TWO_HUNKS} sessionId="s1" currentScope="unstaged" unstagedDiff={SAMPLE_DIFF_TWO_HUNKS} />
    );
    const codeCell = container.querySelector('td.diff-code') as HTMLElement | null;
    expect(codeCell).toBeTruthy();
    fireEvent.mouseMove(codeCell!);

    await waitFor(() => {
      const controls = screen.getAllByTestId('diff-hunk-controls')[0] as HTMLElement;
      expect(controls.classList.contains('st-hunk-hovered')).toBe(true);
    });
  });

  it('scrolls to a file header when scrollToFilePath changes', () => {
    const scrollSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    const { rerender } = render(<ZedDiffViewer diff={SAMPLE_DIFF_TWO_HUNKS} />);

    rerender(<ZedDiffViewer diff={SAMPLE_DIFF_TWO_HUNKS} scrollToFilePath="test.txt" />);
    expect(scrollSpy).toHaveBeenCalled();
    scrollSpy.mockRestore();
  });

  it('renders per-line widget anchors for hunk controls', () => {
    const { container } = render(
      <ZedDiffViewer
        diff={SAMPLE_DIFF_TWO_HUNKS}
        sessionId="s1"
        currentScope="unstaged"
        unstagedDiff={SAMPLE_DIFF_TWO_HUNKS}
      />
    );
    const widgets = container.querySelectorAll('tr.diff-widget');
    expect(widgets.length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('diff-hunk-controls').length).toBeGreaterThan(0);
  });

  it('renders one control group per hunk', () => {
    render(
      <ZedDiffViewer
        diff={SAMPLE_DIFF_TWO_HUNKS}
        sessionId="s1"
        currentScope="unstaged"
        unstagedDiff={SAMPLE_DIFF_TWO_HUNKS}
      />
    );
    expect(screen.getAllByTestId('diff-hunk-controls')).toHaveLength(2);
  });

  it('orders files based on fileOrder when provided', () => {
    render(<ZedDiffViewer diff={SAMPLE_DIFF_TWO_FILES} fileOrder={['a.txt', 'b.txt']} />);
    const filePaths = screen.getAllByTestId('diff-file-path').map((el) => el.textContent);
    expect(filePaths[0]).toBe('a.txt');
    expect(filePaths[1]).toBe('b.txt');
  });

  it('renders a distinct gutter style for staged hunks (hollow bar with border)', () => {
    const { container } = render(
      <ZedDiffViewer
        diff={SAMPLE_DIFF_TWO_HUNKS}
        sessionId="s1"
        currentScope="staged"
        stagedDiff={SAMPLE_DIFF_TWO_HUNKS}
      />
    );
    const css = container.querySelector('style')?.textContent || '';
    expect(css).toContain('st-hunk-status--staged');
    expect(css).toContain('td.diff-gutter:first-of-type::before');
    // Zed-style: staged hunks show hollow bar (30% opacity background + left/right border)
    expect(css).toContain('border-left: 1px solid');
    expect(css).toContain('border-right: 1px solid');
    expect(css).toContain('box-sizing: border-box');
  });

  it('keeps unified gutters sticky for horizontal scroll', () => {
    const { container } = render(<ZedDiffViewer diff={SAMPLE_DIFF_TWO_HUNKS} />);
    const css = container.querySelector('style')?.textContent || '';
    expect(css).toContain('.st-diff-table.diff-unified tr.diff-line > td.diff-gutter:nth-child(1)');
    expect(css).toContain('position: sticky');
    expect(css).toContain('left: 0');
    expect(css).toContain('left: var(--st-diff-gutter-width)');
    // Regression guard: don't override sticky on changed rows (we rely on ::before for the marker strip).
    expect(css).toContain('td.diff-gutter:first-of-type::before');
    expect(css).not.toContain('td.diff-gutter:first-of-type {');
  });

  it('shows a persistent staged badge for staged hunks via CSS ::after', () => {
    const { container } = render(
      <ZedDiffViewer
        diff={SAMPLE_DIFF_TWO_HUNKS}
        sessionId="s1"
        currentScope="staged"
        stagedDiff={SAMPLE_DIFF_TWO_HUNKS}
      />
    );
    const css = container.querySelector('style')?.textContent || '';
    // Badge is rendered via CSS ::after on first changed row of staged hunks
    expect(css).toContain('tbody.diff-hunk.st-hunk-status--staged tr.diff-line.st-hunk-row-first td.diff-gutter:first-of-type::after');
    expect(css).toContain("content: '✓'");
  });

  it('renders per-file horizontal scrollers with a global horizontal scrollbar', () => {
    render(<ZedDiffViewer diff={SAMPLE_DIFF_TWO_FILES} />);
    const root = screen.getByTestId('diff-scroll-container') as HTMLDivElement;
    expect(root).toBeInTheDocument();
    expect(root.className).toContain('overflow-y-auto');
    expect(root.className).toContain('overflow-x-hidden');
    expect(screen.getAllByTestId('diff-hscroll-container').length).toBeGreaterThan(0);
    expect(screen.getByTestId('diff-x-scrollbar')).toBeInTheDocument();
    expect(document.querySelector('.st-diff-x-scrollbar-track')).toBeTruthy();
    expect(document.querySelector('.st-diff-x-scrollbar-thumb')).toBeTruthy();
  });

  it('syncs global horizontal scroll to all visible file scrollers', () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextId = 1;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    });

    render(<ZedDiffViewer diff={SAMPLE_DIFF_TWO_FILES} />);

    const xbar = screen.getByTestId('diff-x-scrollbar') as HTMLDivElement;
    const scrollers = screen.getAllByTestId('diff-hscroll-container') as HTMLDivElement[];
    expect(scrollers.length).toBe(2);

    xbar.scrollLeft = 120;
    fireEvent.scroll(xbar);

    // Flush scheduled rAF (including the "unlock" frame).
    while (callbacks.size > 0) {
      const batch = Array.from(callbacks.values());
      callbacks.clear();
      batch.forEach((cb) => cb(0));
    }

    expect(scrollers[0]!.scrollLeft).toBe(120);
    expect(scrollers[1]!.scrollLeft).toBe(120);
    rafSpy.mockRestore();
  });

  it('does not drop rapid scroll updates while syncing', () => {
    const queue: FrameRequestCallback[] = [];
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });

    render(<ZedDiffViewer diff={SAMPLE_DIFF_TWO_FILES} />);
    const scrollers = screen.getAllByTestId('diff-hscroll-container') as HTMLDivElement[];
    expect(scrollers.length).toBe(2);

    // First user scroll schedules a flush rAF.
    scrollers[0]!.scrollLeft = 100;
    fireEvent.scroll(scrollers[0]!);
    expect(queue.length).toBeGreaterThanOrEqual(1);

    // Run the flush, but not its unlock frame yet.
    const flush1 = queue.shift()!;
    flush1(0);
    expect(queue.length).toBeGreaterThanOrEqual(1);

    // Second user scroll arrives while we're still syncing (before unlock).
    scrollers[0]!.scrollLeft = 200;
    fireEvent.scroll(scrollers[0]!);
    expect(queue.length).toBeGreaterThanOrEqual(2);

    // Force the "second flush" to run before the unlock frame (this is the case that previously dropped updates).
    const unlock1 = queue[0]!;
    const flush2 = queue[1]!;
    queue.splice(1, 1);
    flush2(0);

    // Now unlock, then run any queued follow-up flush.
    queue.shift()!(0); // unlock1
    while (queue.length > 0) {
      const cb = queue.shift()!;
      cb(0);
    }

    expect(scrollers[1]!.scrollLeft).toBe(200);
    rafSpy.mockRestore();
  });

  it('pins hunk actions to the viewport right edge (overlay)', async () => {
    const { container } = render(
      <ZedDiffViewer
        diff={SAMPLE_DIFF_TWO_HUNKS}
        sessionId="s1"
        currentScope="unstaged"
        unstagedDiff={SAMPLE_DIFF_TWO_HUNKS}
      />
    );

    const scroller = screen.getByTestId('diff-scroll-container');
    const anchor = container.querySelector('[data-hunk-anchor="true"]') as HTMLElement | null;
    expect(anchor).toBeTruthy();

    // Force geometry so overlay position is deterministic in JSDOM.
    mockRect(scroller, { top: 0, height: 400 });
    // rawTop=10 => clamped to 24px
    mockRect(anchor!, { top: 10, height: 0 });

    await hoverFirstHunk(container);
    const overlay = screen.getByTestId('diff-hunk-actions-overlay');
    const overlayInner = overlay.querySelector('.st-diff-actions-overlay-inner') as HTMLElement | null;
    expect(overlayInner).toBeTruthy();
    expect(overlayInner!.style.top).toBe('24px');
  });

  it('hides overlay actions when the hovered hunk is offscreen', async () => {
    const { container } = render(
      <ZedDiffViewer
        diff={SAMPLE_DIFF_TWO_HUNKS}
        sessionId="s1"
        currentScope="unstaged"
        unstagedDiff={SAMPLE_DIFF_TWO_HUNKS}
      />
    );

    const scroller = screen.getByTestId('diff-scroll-container');
    const anchor = container.querySelector('[data-hunk-anchor="true"]') as HTMLElement | null;
    expect(anchor).toBeTruthy();
    mockRect(scroller, { top: 0, height: 200 });
    // rawTop=999 => offscreen => overlay hidden
    mockRect(anchor!, { top: 999, height: 0 });

    const codeCell = container.querySelector('td.diff-code') as HTMLElement | null;
    expect(codeCell).toBeTruthy();
    fireEvent.mouseMove(codeCell!);
    await waitFor(() => {
      const controls = screen.getAllByTestId('diff-hunk-controls')[0] as HTMLElement;
      expect(controls.classList.contains('st-hunk-hovered')).toBe(true);
    });
    const overlay = screen.getByTestId('diff-hunk-actions-overlay');
    expect(overlay).toBeInTheDocument();
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps diff scroll container constrained to the panel', () => {
    render(<ZedDiffViewer diff={SAMPLE_DIFF_TWO_FILES} />);
    const scroller = screen.getByTestId('diff-scroll-container');
    expect(scroller.className).toContain('absolute');
    expect(scroller.className).toContain('inset-0');
    expect(scroller.className).toContain('overflow-y-auto');
  });

  it('does not let the overlay block vertical scrolling gestures', () => {
    const { container } = render(<ZedDiffViewer diff={SAMPLE_DIFF_TWO_FILES} />);
    const css = container.querySelector('style')?.textContent || '';
    expect(css).toContain('.st-diff-actions-overlay');
    expect(css).toContain('.st-diff-actions-overlay-inner');
    expect(css).toContain('pointer-events: none');
    expect(css).toContain('.st-diff-actions-overlay-inner .st-diff-hunk-btn');
    expect(css).toContain('pointer-events: auto');
    expect(css).toContain('visibility: hidden');
  });

  describe('Markdown Preview', () => {
    const SAMPLE_MD_DIFF = `diff --git a/README.md b/README.md
index 1234567..abcdefg 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,4 @@
 # Title
-Old content
+New content
+More text`;

    const SAMPLE_NON_MD_DIFF = `diff --git a/file.txt b/file.txt
index 1234567..abcdefg 100644
--- a/file.txt
+++ b/file.txt
@@ -1,1 +1,1 @@
-old
+new`;

    it('shows preview button for markdown files when fileSources is provided', () => {
      render(
        <ZedDiffViewer
          diff={SAMPLE_MD_DIFF}
          fileSources={{ 'README.md': '# Title\nNew content\nMore text' }}
        />
      );
      const previewBtn = document.querySelector('.st-diff-preview-btn');
      expect(previewBtn).toBeInTheDocument();
    });

    it('does not show preview button for non-markdown files', () => {
      render(
        <ZedDiffViewer
          diff={SAMPLE_NON_MD_DIFF}
          fileSources={{ 'file.txt': 'new content' }}
        />
      );
      const previewBtn = document.querySelector('.st-diff-preview-btn');
      expect(previewBtn).not.toBeInTheDocument();
    });

    it('does not show preview button when fileSources is not provided', () => {
      render(<ZedDiffViewer diff={SAMPLE_MD_DIFF} />);
      const previewBtn = document.querySelector('.st-diff-preview-btn');
      expect(previewBtn).not.toBeInTheDocument();
    });

    it('toggles preview mode when clicking the preview button', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <ZedDiffViewer
          diff={SAMPLE_MD_DIFF}
          fileSources={{ 'README.md': '# Title\nNew content\nMore text' }}
        />
      );

      // Initially shows diff view
      expect(container.querySelector('.st-diff-table')).toBeInTheDocument();
      expect(container.querySelector('.st-markdown-preview')).not.toBeInTheDocument();

      // Click preview button
      const previewBtn = document.querySelector('.st-diff-preview-btn') as HTMLButtonElement;
      expect(previewBtn).toBeInTheDocument();
      await user.click(previewBtn);

      // Now shows markdown preview
      await waitFor(() => {
        expect(container.querySelector('.st-markdown-preview')).toBeInTheDocument();
      });

      // Click again to toggle back
      await user.click(previewBtn);
      await waitFor(() => {
        expect(container.querySelector('.st-diff-table')).toBeInTheDocument();
      });
    });

    it('renders markdown content in preview mode', async () => {
      const user = userEvent.setup();
      render(
        <ZedDiffViewer
          diff={SAMPLE_MD_DIFF}
          fileSources={{ 'README.md': '# Hello World\n\nThis is **bold** text.' }}
        />
      );

      const previewBtn = document.querySelector('.st-diff-preview-btn') as HTMLButtonElement;
      await user.click(previewBtn);

      await waitFor(() => {
        expect(screen.getByText('Hello World')).toBeInTheDocument();
        expect(screen.getByText('bold')).toBeInTheDocument();
      });
    });

    it('keeps file header sticky with top:0', () => {
      const { container } = render(<ZedDiffViewer diff={SAMPLE_MD_DIFF} />);
      const css = container.querySelector('style')?.textContent || '';
      expect(css).toContain('.st-diff-file-header');
      expect(css).toContain('position: sticky');
      expect(css).toContain('top: 0');
    });

    it('shows preview button for .mdx files', () => {
      const mdxDiff = `diff --git a/docs/page.mdx b/docs/page.mdx
index 1234567..abcdefg 100644
--- a/docs/page.mdx
+++ b/docs/page.mdx
@@ -1,1 +1,1 @@
-old
+new`;
      render(
        <ZedDiffViewer
          diff={mdxDiff}
          fileSources={{ 'docs/page.mdx': '# MDX Page' }}
        />
      );
      const previewBtn = document.querySelector('.st-diff-preview-btn');
      expect(previewBtn).toBeInTheDocument();
    });
  });

  describe('Image Preview', () => {
    const SAMPLE_IMAGE_DIFF = `diff --git a/image.png b/image.png
index 1234567..abcdefg 100644
--- a/image.png
+++ b/image.png
@@ -1,1 +1,1 @@
-old
+new`;

    it('defaults to preview mode for image files', async () => {
      const { container } = render(
        <ZedDiffViewer
          diff={SAMPLE_IMAGE_DIFF}
          fileSources={{ 'image.png': 'ZGF0YQ==' }}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole('img', { name: 'image.png' })).toBeInTheDocument();
      });
      expect(container.querySelector('.st-diff-table')).not.toBeInTheDocument();
    });
  });
});
