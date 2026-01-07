import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ZedDiffViewer } from './ZedDiffViewer';
import { API } from '../../../utils/api';

vi.mock('../../../utils/api', () => ({
  API: {
    sessions: {
      stageHunk: vi.fn(),
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
  it('renders viewer', () => {
    render(<ZedDiffViewer diff={SAMPLE_DIFF_TWO_HUNKS} />);
    expect(screen.getByTestId('diff-viewer-zed')).toBeInTheDocument();
  });

  it('stages a hunk when scope is unstaged', async () => {
    (API.sessions.stageHunk as any).mockResolvedValue({ success: true, data: { success: true } });
    render(
      <ZedDiffViewer
        diff={SAMPLE_DIFF_TWO_HUNKS}
        sessionId="s1"
        currentScope="unstaged"
        unstagedDiff={SAMPLE_DIFF_TWO_HUNKS}
      />
    );

    const stage = screen.getAllByTestId('diff-hunk-stage')[0] as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(stage);
    });

    await waitFor(() => {
      expect(API.sessions.stageHunk).toHaveBeenCalledWith('s1', expect.objectContaining({ isStaging: true }));
    });
  });

  it('unstages a hunk when scope is staged', async () => {
    (API.sessions.stageHunk as any).mockResolvedValue({ success: true, data: { success: true } });
    render(
      <ZedDiffViewer
        diff={SAMPLE_DIFF_TWO_HUNKS}
        sessionId="s1"
        currentScope="staged"
        stagedDiff={SAMPLE_DIFF_TWO_HUNKS}
      />
    );

    const stage = screen.getAllByTestId('diff-hunk-stage')[0] as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(stage);
    });

    await waitFor(() => {
      expect(API.sessions.stageHunk).toHaveBeenCalledWith('s1', expect.objectContaining({ isStaging: false }));
    });
  });

  it('restores a hunk using the current scope', async () => {
    (API.sessions.restoreHunk as any).mockResolvedValue({ success: true, data: { success: true } });
    render(
      <ZedDiffViewer
        diff={SAMPLE_DIFF_TWO_HUNKS}
        sessionId="s1"
        currentScope="unstaged"
        unstagedDiff={SAMPLE_DIFF_TWO_HUNKS}
      />
    );

    const restore = screen.getAllByTestId('diff-hunk-restore')[0] as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(restore);
    });

    await waitFor(() => {
      expect(API.sessions.restoreHunk).toHaveBeenCalledWith('s1', expect.objectContaining({ scope: 'unstaged' }));
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

  it('renders a persistent frame style for staged hunks', () => {
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
    expect(css).toContain('Zed-like: staged hunks have a persistent frame');
  });
});
