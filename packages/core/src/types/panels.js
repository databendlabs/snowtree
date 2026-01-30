"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PANEL_CAPABILITIES = void 0;
// Panel Registry - Currently only terminal is implemented
exports.PANEL_CAPABILITIES = {
    terminal: {
        canEmit: ['terminal:command_executed', 'terminal:exit', 'files:changed'],
        canConsume: [], // Terminal doesn't consume events in Phase 1-2
        requiresProcess: true,
        singleton: false,
        canAppearInProjects: true, // Terminal can appear in projects
        canAppearInWorktrees: true // Terminal can appear in worktrees
    },
    claude: {
        canEmit: ['files:changed'], // Claude can change files through tool calls
        canConsume: [], // Claude doesn't consume events in initial implementation
        requiresProcess: true,
        singleton: false,
        canAppearInProjects: true, // Claude can appear in projects
        canAppearInWorktrees: true // Claude can appear in worktrees
    },
    codex: {
        canEmit: ['files:changed'], // Codex can change files through tool calls
        canConsume: [], // Codex doesn't consume events in initial implementation
        requiresProcess: true,
        singleton: false,
        canAppearInProjects: true, // Codex can appear in projects
        canAppearInWorktrees: true // Codex can appear in worktrees
    },
    gemini: {
        canEmit: ['files:changed'], // Gemini can change files through tool calls
        canConsume: [], // Gemini doesn't consume events in initial implementation
        requiresProcess: true,
        singleton: false,
        canAppearInProjects: true, // Gemini can appear in projects
        canAppearInWorktrees: true // Gemini can appear in worktrees
    },
    kimi: {
        canEmit: ['files:changed'], // Kimi can change files through tool calls
        canConsume: [], // Kimi doesn't consume events in initial implementation
        requiresProcess: true,
        singleton: false,
        canAppearInProjects: true, // Kimi can appear in projects
        canAppearInWorktrees: true // Kimi can appear in worktrees
    },
    diff: {
        canEmit: ['diff:refreshed'],
        canConsume: ['files:changed', 'terminal:command_executed'],
        requiresProcess: false, // No background process
        singleton: true, // Only one diff panel
        permanent: true, // Cannot be closed
        canAppearInProjects: false, // Diff not available in projects (no worktree)
        canAppearInWorktrees: true // Diff only in worktrees
    },
    editor: {
        canEmit: ['editor:file_saved', 'editor:file_changed'],
        canConsume: ['files:changed'], // React to file system changes
        requiresProcess: false, // No background process needed
        singleton: false, // Multiple editors allowed
        canAppearInProjects: true, // Editor can appear in projects
        canAppearInWorktrees: true // Editor can appear in worktrees
    },
    logs: {
        canEmit: ['process:started', 'process:output', 'process:ended'],
        canConsume: [], // Logs doesn't listen to other panels
        requiresProcess: true, // Manages script processes
        singleton: true, // ONLY ONE logs panel per session
        canAppearInProjects: true, // Logs can appear in projects
        canAppearInWorktrees: true // Logs can appear in worktrees
    },
    dashboard: {
        canEmit: [], // Dashboard doesn't emit events
        canConsume: ['files:changed'], // Refresh on file changes
        requiresProcess: false, // No background process
        singleton: true, // Only one dashboard panel
        permanent: true, // Cannot be closed (like diff panel)
        canAppearInProjects: true, // Dashboard ONLY in projects
        canAppearInWorktrees: false // Dashboard NOT in worktrees
    },
    'setup-tasks': {
        canEmit: [], // Setup tasks doesn't emit events
        canConsume: ['files:changed'], // Refresh when files change (e.g., gitignore)
        requiresProcess: false, // No background process
        singleton: true, // Only one setup tasks panel
        permanent: true, // Cannot be closed (like dashboard)
        canAppearInProjects: true, // Setup tasks ONLY in projects
        canAppearInWorktrees: false // Setup tasks NOT in worktrees
    }
};
//# sourceMappingURL=panels.js.map
