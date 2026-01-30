export interface Session {
    id: string;
    name: string;
    worktreePath: string;
    prompt: string;
    initialPrompt?: string;
    status: 'waiting' | 'initializing' | 'running' | 'stopped' | 'completed' | 'error' | 'pending' | 'failed' | 'ready' | 'completed_unviewed';
    statusMessage?: string;
    pid?: number;
    createdAt: Date;
    updatedAt?: Date;
    lastActivity: Date;
    output: SessionOutput[];
    jsonMessages: unknown[];
    error?: string;
    exitCode?: number;
    isRunning: boolean;
    lastViewedAt?: string;
    permissionMode?: 'approve' | 'ignore';
    runStartedAt?: string;
    isMainRepo?: boolean;
    projectId?: number;
    folderId?: string;
    displayOrder?: number;
    isFavorite?: boolean;
    autoCommit?: boolean;
    toolType: 'claude' | 'codex' | 'gemini' | 'kimi' | 'none';
    baseCommit?: string;
    baseBranch?: string;
    commitMode?: 'structured' | 'checkpoint' | 'disabled';
    commitModeSettings?: string;
    skipContinueNext?: boolean;
    archived?: boolean;
    claudeSessionId?: string;
    executionMode?: 'plan' | 'execute';
}
export interface SessionUpdate {
    name?: string;
    status?: Session['status'];
    statusMessage?: string;
    pid?: number;
    error?: string;
    worktreePath?: string;
    worktreeName?: string;
    baseCommit?: string | null;
    baseBranch?: string | null;
    skipContinueNext?: boolean;
    toolType?: 'claude' | 'codex' | 'gemini' | 'kimi' | 'none';
    executionMode?: 'plan' | 'execute';
}
export interface GitStatus {
    branch?: string;
    ahead?: number;
    behind?: number;
    staged?: number;
    modified?: number;
    untracked?: number;
    conflicted?: number;
    detached?: boolean;
    clean?: boolean;
    hasUncommittedChanges?: boolean;
    hasUntrackedFiles?: boolean;
    state: string;
    additions?: number;
    deletions?: number;
    filesChanged?: number;
    secondaryStates?: string[];
    lastChecked?: string;
    totalCommits?: number;
}
export interface SessionOutput {
    id: number;
    session_id: string;
    type: 'stdout' | 'stderr' | 'system' | 'json' | 'error';
    data: string;
    timestamp: string;
    panel_id?: string;
}
//# sourceMappingURL=session.d.ts.map
