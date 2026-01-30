export interface ToolPanel {
    id: string;
    sessionId: string;
    type: ToolPanelType;
    title: string;
    state: ToolPanelState;
    metadata: ToolPanelMetadata;
}
export type ToolPanelType = 'terminal' | 'claude' | 'codex' | 'gemini' | 'kimi' | 'diff' | 'editor' | 'logs' | 'dashboard' | 'setup-tasks';
export interface ToolPanelState {
    isActive: boolean;
    isPinned?: boolean;
    hasBeenViewed?: boolean;
    customState?: TerminalPanelState | ClaudePanelState | CodexPanelState | GeminiPanelState | KimiPanelState | DiffPanelState | EditorPanelState | LogsPanelState | DashboardPanelState | SetupTasksPanelState | Record<string, unknown>;
}
export interface TerminalPanelState {
    isInitialized?: boolean;
    cwd?: string;
    shellType?: string;
    scrollbackBuffer?: string | string[];
    commandHistory?: string[];
    environmentVars?: Record<string, string>;
    dimensions?: {
        cols: number;
        rows: number;
    };
    lastActiveCommand?: string;
    cursorPosition?: {
        x: number;
        y: number;
    };
    selectionText?: string;
    lastActivityTime?: string;
    tmuxSessionId?: string;
    outputSizeLimit?: number;
}
export interface DiffPanelState {
    lastRefresh?: string;
    currentDiff?: string;
    filesChanged?: number;
    insertions?: number;
    deletions?: number;
    isDiffStale?: boolean;
    viewMode?: 'split' | 'unified';
    showWhitespace?: boolean;
    contextLines?: number;
    commitSha?: string;
}
export type PanelStatus = 'idle' | 'running' | 'waiting' | 'stopped' | 'completed_unviewed' | 'error';
export type ExecutionMode = 'execute' | 'plan';
export interface BaseAIPanelState {
    isInitialized?: boolean;
    lastPrompt?: string;
    model?: string;
    lastActivityTime?: string;
    lastInput?: string;
    panelStatus?: PanelStatus;
    hasUnviewedContent?: boolean;
    executionMode?: ExecutionMode;
    agentSessionId?: string;
    claudeSessionId?: string;
    codexSessionId?: string;
    claudeResumeId?: string;
    codexResumeId?: string;
}
export interface ClaudePanelState extends BaseAIPanelState {
    permissionMode?: 'approve' | 'ignore';
    contextUsage?: string | null;
    autoContextRunState?: 'idle' | 'running';
    lastAutoContextAt?: string;
}
export interface CodexPanelState extends BaseAIPanelState {
    modelProvider?: string;
    approvalPolicy?: 'auto' | 'manual';
    sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
    webSearch?: boolean;
    codexConfig?: {
        model: string;
        thinkingLevel: 'low' | 'medium' | 'high';
        sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
        webSearch: boolean;
    };
}
export interface GeminiPanelState extends BaseAIPanelState {
    approvalMode?: 'default' | 'auto_edit' | 'yolo' | 'plan';
}
export interface KimiPanelState extends BaseAIPanelState {
    approvalMode?: 'default' | 'yolo';
}
export interface EditorPanelState {
    filePath?: string;
    content?: string;
    isDirty?: boolean;
    cursorPosition?: {
        line: number;
        column: number;
    };
    scrollPosition?: number;
    language?: string;
    readOnly?: boolean;
    fontSize?: number;
    theme?: string;
    expandedDirs?: string[];
    fileTreeWidth?: number;
    searchQuery?: string;
    showSearch?: boolean;
}
export interface LogsPanelState {
    isRunning: boolean;
    processId?: number;
    command?: string;
    startTime?: string;
    endTime?: string;
    exitCode?: number;
    outputBuffer?: string[];
    errorCount?: number;
    warningCount?: number;
    lastActivityTime?: string;
}
export interface DashboardPanelState {
    lastRefresh?: string;
    filterType?: 'all' | 'stale' | 'changes' | 'pr';
    isRefreshing?: boolean;
    cachedData?: Record<string, unknown>;
}
export interface SetupTasksPanelState {
    lastCheck?: string;
    tasksCompleted?: Record<string, boolean>;
    dismissedTasks?: string[];
}
export interface ToolPanelMetadata {
    createdAt: string;
    lastActiveAt: string;
    position: number;
    permanent?: boolean;
}
export interface CreatePanelRequest {
    sessionId: string;
    type: ToolPanelType;
    title?: string;
    initialState?: TerminalPanelState | ClaudePanelState | CodexPanelState | GeminiPanelState | KimiPanelState | DiffPanelState | EditorPanelState | LogsPanelState | DashboardPanelState | SetupTasksPanelState | {
        customState?: unknown;
    };
    metadata?: Partial<ToolPanelMetadata>;
}
export interface UpdatePanelRequest {
    panelId: string;
    updates: Partial<ToolPanel>;
}
export interface PanelEvent {
    type: PanelEventType;
    source: {
        panelId: string;
        panelType: ToolPanelType;
        sessionId: string;
    };
    data: unknown;
    timestamp: string;
}
export type PanelEventType = 'terminal:command_executed' | 'terminal:exit' | 'files:changed' | 'diff:refreshed' | 'editor:file_saved' | 'editor:file_changed' | 'process:started' | 'process:output' | 'process:ended' | 'git:operation_started' | 'git:operation_completed' | 'git:operation_failed';
export interface PanelEventSubscription {
    panelId: string;
    eventTypes: PanelEventType[];
    callback: (event: PanelEvent) => void;
}
export interface PanelCapabilities {
    canEmit: PanelEventType[];
    canConsume: PanelEventType[];
    requiresProcess?: boolean;
    singleton?: boolean;
    permanent?: boolean;
    canAppearInProjects?: boolean;
    canAppearInWorktrees?: boolean;
}
export declare const PANEL_CAPABILITIES: Record<ToolPanelType, PanelCapabilities>;
//# sourceMappingURL=panels.d.ts.map
