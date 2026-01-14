import type { SessionOutput } from '@snowtree/core/types/session';

// Re-export for backward compatibility
export type { SessionOutput };

// Database-layer Session type (snake_case matching database schema)
export interface Session {
  id: string;
  name: string;
  worktree_path: string;
  worktree_name: string;
  initial_prompt: string;
  status: string;
  status_message?: string | null;
  pid?: number | null;
  created_at: string;
  updated_at: string;
  last_output?: string | null;
  exit_code?: number | null;
  last_viewed_at?: string | null;
  permission_mode?: 'approve' | 'ignore' | null;
  run_started_at?: string | null;
  is_main_repo?: boolean | null;
  project_id?: number | null;
  folder_id?: string | null;
  claude_session_id?: string | null;
  display_order?: number | null;
  is_favorite?: boolean | null;
  auto_commit?: boolean | null;
  tool_type?: 'claude' | 'codex' | 'none' | null;
  base_commit?: string | null;
  base_branch?: string | null;
  commit_mode?: 'structured' | 'checkpoint' | 'disabled' | null;
  commit_mode_settings?: string | null;
  skip_continue_next?: boolean | null;
  archived?: boolean | null;
  execution_mode?: 'plan' | 'execute' | null;
}

export interface Project {
  id: number;
  name: string;
  path: string;
  system_prompt?: string | null;
  run_script?: string | null;
  build_script?: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  default_permission_mode?: 'approve' | 'ignore';
  open_ide_command?: string | null;
  display_order?: number;
  worktree_folder?: string | null;
  lastUsedModel?: string;
  commit_mode?: 'structured' | 'checkpoint' | 'disabled';
  commit_structured_prompt_template?: string;
  commit_checkpoint_prefix?: string;
}

export interface ProjectRunCommand {
  id: number;
  project_id: number;
  command: string;
  display_name?: string;
  order_index: number;
  created_at: string;
}

export interface Folder {
  id: string;
  name: string;
  project_id: number;
  parent_folder_id?: string | null;
  display_order: number;
  created_at: string;
  updated_at: string;
}

// Session and SessionOutput are now imported from @snowtree/core above

export interface ConversationMessage {
  id: number;
  session_id: string;
  message_type: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface CreateSessionData {
  id: string;
  name: string;
  initial_prompt: string;
  worktree_name: string;
  worktree_path: string;
  project_id: number;
  folder_id?: string;
  permission_mode?: 'approve' | 'ignore';
  is_main_repo?: boolean;
  display_order?: number;
  auto_commit?: boolean;
  tool_type?: 'claude' | 'codex' | 'none';
  base_commit?: string;
  base_branch?: string;
  commit_mode?: 'structured' | 'checkpoint' | 'disabled';
  commit_mode_settings?: string; // JSON string of CommitModeSettings
}

export interface UpdateSessionData {
  name?: string;
  status?: Session['status'];
  status_message?: string;
  last_output?: string;
  exit_code?: number;
  pid?: number;
  folder_id?: string | null;
  claude_session_id?: string;
  run_started_at?: string;
  is_favorite?: boolean;
  auto_commit?: boolean;
  commit_mode?: 'structured' | 'checkpoint' | 'disabled';
  commit_mode_settings?: string; // JSON string of CommitModeSettings
  skip_continue_next?: boolean;
  worktree_path?: string;
  worktree_name?: string;
  base_commit?: string | null;
  base_branch?: string | null;
  archived?: boolean;
}

export interface PromptMarker {
  id: number;
  session_id: string;
  prompt_text: string;
  output_index: number;
  output_line?: number;
  timestamp: string;
  completion_timestamp?: string;
}

export interface ExecutionDiff {
  id: number;
  session_id: string;
  prompt_marker_id?: number;
  execution_sequence: number;
  git_diff?: string;
  files_changed?: string[]; // JSON array of changed file paths
  stats_additions: number;
  stats_deletions: number;
  stats_files_changed: number;
  before_commit_hash?: string;
  after_commit_hash?: string;
  commit_message?: string;
  timestamp: string;
  comparison_branch?: string;
  history_source?: 'remote' | 'local' | 'branch';
  history_limit_reached?: boolean;
}

export interface CreateExecutionDiffData {
  session_id: string;
  prompt_marker_id?: number;
  execution_sequence: number;
  git_diff?: string;
  files_changed?: string[];
  stats_additions?: number;
  stats_deletions?: number;
  stats_files_changed?: number;
  before_commit_hash?: string;
  after_commit_hash?: string;
  commit_message?: string;
}

export interface CreatePanelExecutionDiffData {
  panel_id: string;
  prompt_marker_id?: number;
  execution_sequence: number;
  git_diff?: string;
  files_changed?: string[];
  stats_additions?: number;
  stats_deletions?: number;
  stats_files_changed?: number;
  before_commit_hash?: string;
  after_commit_hash?: string;
  commit_message?: string;
}

export interface TimelineEvent {
  id: number;
  session_id: string;
  seq: number;
  timestamp: string;
  kind: 'chat.user' | 'chat.assistant' | 'thinking' | 'tool_use' | 'tool_result' | 'user_question' | 'cli.command' | 'git.command' | 'worktree.command';
  status?: 'started' | 'finished' | 'failed' | 'pending' | 'answered';
  command?: string;
  cwd?: string;
  duration_ms?: number;
  exit_code?: number;
  panel_id?: string;
  tool?: string;
  meta?: Record<string, unknown>;
  // New fields for extended event types
  tool_name?: string;
  tool_input?: string;
  tool_result?: string;
  is_error?: number;
  content?: string;
  is_streaming?: number;
  tool_use_id?: string;
  questions?: string;
  answers?: string;
  action_type?: string;
  thinking_id?: string;  // Unique ID for streaming thinking updates
}

export interface CreateTimelineEventData {
  session_id: string;
  timestamp: string;
  kind: TimelineEvent['kind'];
  status?: TimelineEvent['status'];
  command?: string;
  cwd?: string;
  duration_ms?: number;
  exit_code?: number;
  panel_id?: string;
  tool?: TimelineEvent['tool'];
  meta?: Record<string, unknown>;
  // New fields for extended event types
  tool_name?: string;
  tool_input?: string;
  tool_result?: string;
  is_error?: number;
  content?: string;
  is_streaming?: number;
  tool_use_id?: string;
  questions?: string;
  answers?: string;
  action_type?: string;
  thinking_id?: string;  // Unique ID for streaming thinking updates
}
