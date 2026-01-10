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
    const headers = screen.getAllByTestId('diff-file-header').map((el) => el.textContent);
    expect(headers[0]).toBe('a.txt');
    expect(headers[1]).toBe('b.txt');
  });

  it('renders a distinct gutter style for staged hunks', () => {
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
    expect(css).toContain('opacity: 0.75');
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

  it('shows a persistent staged badge for staged hunks', () => {
    render(
      <ZedDiffViewer
        diff={SAMPLE_DIFF_TWO_HUNKS}
        sessionId="s1"
        currentScope="staged"
        stagedDiff={SAMPLE_DIFF_TWO_HUNKS}
      />
    );
    expect(screen.getAllByLabelText('Hunk staged').length).toBeGreaterThan(0);
  });

  it('uses a single scroll container for horizontal scrolling', () => {
    render(<ZedDiffViewer diff={SAMPLE_DIFF_TWO_FILES} />);
    const root = screen.getByTestId('diff-scroll-container') as HTMLDivElement;
    expect(root).toBeInTheDocument();
    // Regression guard: don’t create per-file horizontal scrollers (causes sync jank on large diffs).
    expect(screen.queryByTestId('diff-hscroll-container')).toBeNull();
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
    expect(screen.queryByTestId('diff-hunk-actions-overlay')).toBeNull();
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
  });
});
