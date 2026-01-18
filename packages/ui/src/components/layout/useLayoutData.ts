import { useState, useEffect, useCallback, useRef } from 'react';
import { API } from '../../utils/api';
import { withTimeout } from '../../utils/withTimeout';
import type { Session } from '../../types/session';
import type { ToolPanel, BaseAIPanelState } from '@snowtree/core/types/panels';
import type { CLITool, ImageAttachment, ExecutionMode } from './types';
import { useEnsureTerminalPanel } from './useEnsureTerminalPanel';

interface UseLayoutDataResult {
  session: Session | null;
  aiPanel: ToolPanel | null;
  terminalPanel: ToolPanel | null;
  branchName: string;
  remoteName: string | null;
  selectedTool: CLITool;
  isProcessing: boolean;
  isLoadingSession: boolean;
  loadError: string | null;
  executionMode: ExecutionMode;
  reload: () => void;
  setSelectedTool: (tool: CLITool) => void;
  setExecutionMode: (mode: ExecutionMode) => void;
  toggleExecutionMode: () => void;
  cycleSelectedTool: () => void;
  sendMessage: (message: string, images?: ImageAttachment[], planMode?: boolean) => Promise<void>;
  sendMessageToTool: (tool: CLITool, message: string, options?: { skipCheckpointAutoCommit?: boolean }) => Promise<void>;
  cancelRequest: () => Promise<void>;
}

export function useLayoutData(sessionId: string | null): UseLayoutDataResult {
  const [session, setSession] = useState<Session | null>(null);
  const [aiPanel, setAiPanel] = useState<ToolPanel | null>(null);
  const aiPanelRef = useRef<ToolPanel | null>(null);
  const [terminalPanel, setTerminalPanel] = useState<ToolPanel | null>(null);
  const [branchName, setBranchName] = useState<string>('main');
  const [remoteName, setRemoteName] = useState<string | null>(null);
  const [selectedTool, setSelectedTool] = useState<CLITool>('claude');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isLoadingSession, setIsLoadingSession] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const [reloadToken, setReloadToken] = useState(0);
  const branchPollTimerRef = useRef<number | null>(null);
  const branchPollInFlightRef = useRef(false);

  // Local execution mode state - derived from session
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('execute');
  const executionModeRef = useRef<ExecutionMode>(executionMode);

  useEffect(() => {
    aiPanelRef.current = aiPanel;
  }, [aiPanel]);

  useEffect(() => {
    executionModeRef.current = executionMode;
  }, [executionMode]);

  // Update execution mode and persist to session
  const setExecutionModeWithPersist = useCallback(async (mode: ExecutionMode) => {
    if (!session) return;

    setExecutionMode(mode);

    // Persist the execution mode by updating the session's executionMode
    try {
      await API.sessions.update(session.id, { executionMode: mode });
    } catch (error) {
      console.error('Failed to update session executionMode:', error);
    }
  }, [session]);

  const toggleExecutionMode = useCallback(() => {
    const currentMode = executionModeRef.current;
    const nextMode: ExecutionMode = currentMode === 'execute' ? 'plan' : 'execute';
    void setExecutionModeWithPersist(nextMode);
  }, [setExecutionModeWithPersist]);

  const setSelectedToolWithPersist = useCallback(async (tool: CLITool) => {
    if (!session) return;

    setSelectedTool(tool);

    // Persist the tool selection by updating the session's toolType
    try {
      await API.sessions.update(session.id, { toolType: tool });
    } catch (error) {
      console.error('Failed to update session toolType:', error);
    }
  }, [session]);

  const cycleSelectedTool = useCallback(async () => {
    if (!session) return;

    const tools: CLITool[] = ['claude', 'codex', 'gemini'];
    const currentIndex = tools.indexOf(selectedTool);
    const nextIndex = (currentIndex + 1) % tools.length;
    const nextTool = tools[nextIndex];

    await setSelectedToolWithPersist(nextTool);
  }, [session, selectedTool, setSelectedToolWithPersist]);

  useEffect(() => {
    if (!sessionId) {
      setSession(null);
      setAiPanel(null);
      setTerminalPanel(null);
      setIsProcessing(false);
      return;
    }

    // Clear stale data when switching sessions
    setSession(null);
    setAiPanel(null);
    setTerminalPanel(null);
    setBranchName('main');
    setRemoteName(null);
    setLoadError(null);
    setIsProcessing(false);
    setIsLoadingSession(true);
    const requestId = ++requestIdRef.current;

    const loadSession = async () => {
      try {
        const response = await withTimeout(API.sessions.get(sessionId), 10_000, 'Load workspace');
        if (requestId !== requestIdRef.current) return;
        if (response.success && response.data) {
          setSession(response.data);
          setSelectedTool(
            response.data.toolType === 'codex'
              ? 'codex'
              : response.data.toolType === 'gemini'
                ? 'gemini'
                : 'claude'
          );
          setExecutionMode(response.data.executionMode === 'plan' ? 'plan' : 'execute');
          setIsProcessing(
            response.data.status === 'running' || response.data.status === 'initializing'
          );
        } else if (!response.success) {
          setLoadError(response.error || 'Failed to load workspace');
        }
      } catch (error) {
        if (requestId !== requestIdRef.current) return;
        setLoadError(error instanceof Error ? error.message : 'Failed to load workspace');
      }
    };

    const loadPanels = async () => {
      try {
        const panelsResponse = await withTimeout(window.electronAPI.panels.list(sessionId), 10_000, 'Load panels');
        if (requestId !== requestIdRef.current) return;
        if (panelsResponse?.success && panelsResponse.data) {
          const panels: ToolPanel[] = panelsResponse.data;

          const ai = panels.find(p => p.type === 'claude' || p.type === 'codex' || p.type === 'gemini') || null;
          setAiPanel(ai);
          const terminal = panels.find(p => p.type === 'terminal') || null;
          setTerminalPanel(terminal);
          // Note: Do NOT override selectedTool here - it's already set from session.toolType
        }
      } catch (error) {
        console.error('Failed to load panels:', error);
      }
    };

    Promise.allSettled([loadSession(), loadPanels()]).finally(() => {
      if (requestId === requestIdRef.current) {
        setIsLoadingSession(false);
      }
    });
  }, [sessionId, reloadToken]);

  useEnsureTerminalPanel(session, terminalPanel, setTerminalPanel);

  useEffect(() => {
    if (!sessionId) return;

    if (branchPollTimerRef.current) {
      window.clearInterval(branchPollTimerRef.current);
      branchPollTimerRef.current = null;
    }

    let cancelled = false;

    const pollBranch = async () => {
      if (cancelled) return;
      if (document.visibilityState !== 'visible') return;
      if (branchPollInFlightRef.current) return;

      branchPollInFlightRef.current = true;
      try {
        const response = await withTimeout(API.sessions.getGitCommands(sessionId), 8_000, 'Load branch');
        if (cancelled) return;
        if (response.success && response.data) {
          const nextBranch = String(response.data.currentBranch || '').trim();
          if (nextBranch) setBranchName((prev) => (prev === nextBranch ? prev : nextBranch));

          const nextRemote = response.data.remoteName ?? null;
          setRemoteName((prev) => (prev === nextRemote ? prev : nextRemote));
        }
      } catch {
        // best-effort; branch polling should never break the UI
      } finally {
        branchPollInFlightRef.current = false;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void pollBranch();
    };

    document.addEventListener('visibilitychange', handleVisibility);
    void pollBranch();

    branchPollTimerRef.current = window.setInterval(pollBranch, 2_000);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibility);
      if (branchPollTimerRef.current) {
        window.clearInterval(branchPollTimerRef.current);
        branchPollTimerRef.current = null;
      }
      branchPollInFlightRef.current = false;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;

    const handleSessionCreated = (createdSession: Session) => {
      if (createdSession.id !== sessionId) return;
      setSession(createdSession);
      setSelectedTool(
        createdSession.toolType === 'codex'
          ? 'codex'
          : createdSession.toolType === 'gemini'
            ? 'gemini'
            : 'claude'
      );
      setIsProcessing(
        createdSession.status === 'running' || createdSession.status === 'initializing'
      );
      setLoadError(null);
      setIsLoadingSession(false);
    };

    const handleSessionUpdate = (updatedSession: Session) => {
      if (updatedSession.id === sessionId) {
        setSession(updatedSession);
        setIsProcessing(
          updatedSession.status === 'running' || updatedSession.status === 'initializing'
        );
      }
    };

    const unsubscribes: Array<() => void> = [];
    const unsubCreated = window.electronAPI?.events?.onSessionCreated?.(handleSessionCreated);
    if (unsubCreated) unsubscribes.push(unsubCreated);
    const unsubUpdated = window.electronAPI?.events?.onSessionUpdated?.(handleSessionUpdate);
    if (unsubUpdated) unsubscribes.push(unsubUpdated);

    return () => {
      unsubscribes.forEach((u) => u());
    };
  }, [sessionId]);

  const ensureAiPanel = useCallback(async (desiredPanelType: 'claude' | 'codex' | 'gemini') => {
    if (!session) return null;

    let panelToUse = aiPanel;

    if (panelToUse && panelToUse.sessionId !== session.id) {
      panelToUse = null;
      setAiPanel(null);
    }

    if (!panelToUse || panelToUse.type !== desiredPanelType) {
      const panelsResponse = await window.electronAPI.panels.list(session.id);
      if (panelsResponse?.success && panelsResponse.data) {
        const panels: ToolPanel[] = panelsResponse.data;
        const existingPanel = panels.find(p => p.type === desiredPanelType);
        if (existingPanel) {
          panelToUse = existingPanel;
          setAiPanel(existingPanel);
        } else {
          panelToUse = null;
        }
      } else {
        panelToUse = null;
      }
    }

    if (!panelToUse) {
      const createResponse = await window.electronAPI.panels.create({
        sessionId: session.id,
        type: desiredPanelType,
        name: desiredPanelType === 'codex' ? 'Codex' : desiredPanelType === 'gemini' ? 'Gemini' : 'Claude'
      });

      if (createResponse?.success && createResponse.data) {
        panelToUse = createResponse.data;

        // Apply local execution mode to newly created panel
        const currentLocalMode = executionMode;
        if (currentLocalMode !== 'execute') {
          const panelWithMode = {
            ...panelToUse,
            state: {
              ...(panelToUse.state || { isActive: true }),
              customState: {
                ...((panelToUse.state?.customState as BaseAIPanelState) || {}),
                executionMode: currentLocalMode
              }
            }
          };
          setAiPanel(panelWithMode);
          // Persist the mode to backend
          await window.electronAPI?.panels?.update(panelToUse.id, {
            state: panelWithMode.state
          });
          panelToUse = panelWithMode;
        } else {
          setAiPanel(panelToUse);
        }
      } else {
        console.error('Failed to create AI panel:', createResponse?.error);
        return null;
      }
    }

    return panelToUse;
  }, [session, aiPanel, executionMode]);

  const sendMessage = useCallback(async (message: string, images?: ImageAttachment[], planMode?: boolean) => {
    if (!session) return;

    setIsProcessing(true);

    try {
      const desiredPanelType = selectedTool === 'codex' ? 'codex' : selectedTool === 'gemini' ? 'gemini' : 'claude';
      const panelToUse = await ensureAiPanel(desiredPanelType);

      if (!panelToUse) {
        console.error('No AI panel available');
        setIsProcessing(false);
        return;
      }

      const result = await window.electronAPI?.panels?.continue(panelToUse.id, message, undefined, { planMode }, images);
      if (result && !result.success) {
        console.error('Failed to send message:', result.error);
        setIsProcessing(false);
      }
    } catch (error) {
      console.error('Failed to send message:', error);
      setIsProcessing(false);
    }
  }, [session, selectedTool, ensureAiPanel]);

  const sendMessageToTool = useCallback(async (tool: CLITool, message: string, options?: { skipCheckpointAutoCommit?: boolean }) => {
    if (!session) return;

    setIsProcessing(true);

    try {
      const desiredPanelType = tool === 'codex' ? 'codex' : tool === 'gemini' ? 'gemini' : 'claude';
      const panelToUse = await ensureAiPanel(desiredPanelType);

      if (!panelToUse) {
        console.error('No AI panel available');
        setIsProcessing(false);
        return;
      }

      const result = await window.electronAPI?.panels?.continue(panelToUse.id, message, undefined, options);
      if (result && !result.success) {
        console.error('Failed to send message:', result.error);
        setIsProcessing(false);
      }
    } catch (error) {
      console.error('Failed to send message:', error);
      setIsProcessing(false);
    }
  }, [session, ensureAiPanel]);

  const cancelRequest = useCallback(async () => {
    if (!session) return;

    try {
      await API.sessions.stop(session.id);
      setIsProcessing(false);
    } catch (error) {
      console.error('Failed to cancel request:', error);
    }
  }, [session]);

  return {
    session,
    aiPanel,
    terminalPanel,
    branchName,
    remoteName,
    selectedTool,
    isProcessing,
    isLoadingSession,
    loadError,
    executionMode,
    reload: () => setReloadToken((v) => v + 1),
    setSelectedTool: setSelectedToolWithPersist,
    setExecutionMode,
    toggleExecutionMode,
    cycleSelectedTool,
    sendMessage,
    sendMessageToTool,
    cancelRequest
  };
}

export default useLayoutData;
