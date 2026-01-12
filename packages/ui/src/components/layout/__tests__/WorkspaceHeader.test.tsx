import { describe, it, expect } from 'vitest';
import type { Session } from '../../../types/session';

// Extract the getRepositoryName function for testing
function getRepositoryName(worktreePath?: string): string | null {
  if (!worktreePath) return null;

  const parts = worktreePath.split('/');
  const worktreesIndex = parts.lastIndexOf('worktrees');

  if (worktreesIndex > 0) {
    return parts[worktreesIndex - 1];
  }

  return null;
}

describe('WorkspaceHeader - getRepositoryName', () => {
  it('should extract repository name from standard worktree path', () => {
    const path = '/Users/bohu/github/blog-hexo/worktrees/montreal-wphnwwp9';
    expect(getRepositoryName(path)).toBe('blog-hexo');
  });

  it('should extract repository name from nested directory path', () => {
    const path = '/Users/user/projects/my-repo/worktrees/feature-123';
    expect(getRepositoryName(path)).toBe('my-repo');
  });

  it('should extract repository name from Windows-style path', () => {
    const path = 'C:/Users/user/repos/my-project/worktrees/branch-name';
    expect(getRepositoryName(path)).toBe('my-project');
  });

  it('should return null when worktreePath is undefined', () => {
    expect(getRepositoryName(undefined)).toBeNull();
  });

  it('should return null when worktreePath is empty', () => {
    expect(getRepositoryName('')).toBeNull();
  });

  it('should return null when "worktrees" is not in path', () => {
    const path = '/Users/bohu/github/blog-hexo';
    expect(getRepositoryName(path)).toBeNull();
  });

  it('should return null when "worktrees" is at the beginning of path', () => {
    const path = 'worktrees/some-branch';
    expect(getRepositoryName(path)).toBeNull();
  });

  it('should handle multiple "worktrees" directories in path', () => {
    // Should use the last occurrence of "worktrees"
    const path = '/Users/bohu/worktrees/project/worktrees/branch-name';
    expect(getRepositoryName(path)).toBe('project');
  });

  it('should handle repository names with dashes and underscores', () => {
    const path = '/Users/user/projects/my-awesome_repo/worktrees/feature-branch';
    expect(getRepositoryName(path)).toBe('my-awesome_repo');
  });

  it('should handle repository names with dots', () => {
    const path = '/Users/user/projects/repo.v2.0/worktrees/main';
    expect(getRepositoryName(path)).toBe('repo.v2.0');
  });
});
