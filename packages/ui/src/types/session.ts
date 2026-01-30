export interface GitStatus {
  state: 'clean' | 'modified' | 'untracked' | 'ahead' | 'behind' | 'diverged' | 'conflict' | 'unknown';
  ahead?: number;
  behind?: number;
  additions?: number;
  deletions?: number;
  filesChanged?: number;
  lastChecked?: string;
  hasUncommittedChanges?: boolean;
  hasUntrackedFiles?: boolean;
  isReadyToMerge?: boolean;
}

export interface Session {
  id: string;
  name: string;
  status: 'initializing' | 'ready' | 'running' | 'waiting' | 'stopped' | 'completed_unviewed' | 'error';
  createdAt: string;
  worktreePath?: string;
  projectId?: number;
  folderId?: string;
  baseCommit?: string;
  baseBranch?: string;
  archived?: boolean;
  displayOrder?: number;
  toolType?: 'claude' | 'codex' | 'gemini' | 'kimi' | 'none';
  executionMode?: 'plan' | 'execute';
  gitStatus?: GitStatus;
  workspaceStage?: import('./workspace').WorkspaceStage;
  currentBranch?: string;
  ownerRepo?: string;
  isFork?: boolean;
  originOwnerRepo?: string;
}
