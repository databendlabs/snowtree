import type { Session } from '../../types/session';
import type { DiffTarget } from '../../types/diff';
import type { TodoItem } from '../../stores/sessionStore';

export type CLITool = 'claude' | 'codex' | 'gemini';

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  type: 'added' | 'deleted' | 'modified' | 'renamed';
  /**
   * True when the file does not exist in HEAD (e.g. newly added but not committed).
   * Used to keep "Untracked" stable across staging operations until commit.
   */
  isNew?: boolean;
}

export interface WorkspaceHeaderProps {
  session: Session;
  branchName: string;
  remoteName: string | null;
}

export interface PendingMessage {
  content: string;
  timestamp: string;
  images?: ImageAttachment[];
}

export interface ConversationPanelProps {
  session: Session;
  pendingMessage?: PendingMessage | null;
}

export interface ImageAttachment {
  id: string;
  filename: string;
  mime: string;
  dataUrl: string;
}

export type ExecutionMode = 'execute' | 'plan';

export interface InputBarProps {
  session: Session;
  panelId: string | null;
  selectedTool: CLITool;
  onSend: (message: string, images?: ImageAttachment[], planMode?: boolean) => void;
  onCancel: () => void;
  isProcessing: boolean;
  onToggleAgent?: () => void;
  onToggleExecutionMode?: () => void;
  placeholder?: string;
  focusRequestId?: number;
  initialExecutionMode?: ExecutionMode;
}

export interface RightPanelProps {
  session: Session;
  todos: TodoItem[];
  onFileClick: (filePath: string, target: DiffTarget, files?: FileChange[]) => void;
  onCommitUncommittedChanges?: () => void;
  isCommitDisabled?: boolean;
  onCommitClick?: (target: DiffTarget, files: FileChange[]) => void;
  onPushPR?: () => void;
  isPushPRDisabled?: boolean;
  onUpdateBranch?: () => void;
  isUpdateBranchDisabled?: boolean;
  onSyncPR?: () => void;
  isSyncPRDisabled?: boolean;
}

export interface DiffOverlayProps {
  isOpen: boolean;
  filePath: string | null;
  sessionId: string;
  target: DiffTarget | null;
  files?: FileChange[];
  onClose: () => void;
  banner?: {
    title: string;
    description?: string;
    primaryLabel: string;
    onPrimary: () => void;
    secondaryLabel?: string;
    onSecondary?: () => void;
    primaryDisabled?: boolean;
  };
}

export interface MainLayoutProps {
  session: Session | null;
  hideRightPanel?: boolean;
}
