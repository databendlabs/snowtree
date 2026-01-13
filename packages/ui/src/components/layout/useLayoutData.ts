import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { API } from '../../utils/api';
import { withTimeout } from '../../utils/withTimeout';
import type { Session } from '../../types/session';
import type { ToolPanel, BaseAIPanelState } from '@snowtree/core/types/panels';
import type { CLITool, ImageAttachment, ExecutionMode } from './types';

interface UseLayoutDataResult {
  session: Session | null;
  aiPanel: ToolPanel | null;
  branchName: string;
  selectedTool: CLITool;
  isProcessing: boolean;
  isLoadingSession: boolean;
  loadError: string | null;
  executionMode: ExecutionMode;
  reload: () => void;
  setSelectedTool: (tool: CLITool) => void;
  setExecutionMode: (mode: ExecutionMode) => void;
  sendMessage: (message: string, images?: ImageAttachment[], planMode?: boolean) => Promise<void>;
  sendMessageToTool: (tool: CLITool, message: string, options?: { skipCheckpointAutoCommit?: boolean }) => Promise<void>;
  cancelRequest: () => Promise<void>;
}

export function useLayoutData(sessionId: string | null): UseLayoutDataResult {
  const [session, setSession] = useState<Session | null>(null);
  const [aiPanel, setAiPanel] = useState<ToolPanel | null>(null);
  const [branchName, setBranchName] = useState<string>('main');
  const [selectedTool, setSelectedTool] = useState<CLITool>('claude');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isLoadingSession, setIsLoadingSession] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const [reloadToken, setReloadToken] = useState(0);

  // Derive executionMode from aiPanel state
  const executionMode = useMemo<ExecutionMode>(() => {
    const customState = aiPanel?.state?.customState as BaseAIPanelState | undefined;
    return customState?.executionMode || 'execute';
  }, [aiPanel]);

  // Update execution mode and persist to panel state
  const setExecutionMode = useCallback(async (mode: ExecutionMode) => {
    if (!aiPanel) return;

    try {
      const currentState = aiPanel.state || { isActive: true };
      const currentCustomState = (currentState.customState as BaseAIPanelState) || {};

      const updatedPanel = {
        ...aiPanel,
        state: {
          ...currentState,
          customState: {
            ...currentCustomState,
            executionMode: mode
          }
        }
      };

      // Update local state immediately for responsive UI
      setAiPanel(updatedPanel);

      // Persist to backend
      await window.electronAPI?.panels?.update(aiPanel.id, {
        state: updatedPanel.state
      });
    } catch (error) {
      console.error('Failed to update execution mode:', error);
    }
  }, [aiPanel]);

  useEffect(() => {
    if (!sessionId) {
      setSession(null);
      setAiPanel(null);
      setIsProcessing(false);
      return;
    }

    // Clear stale data when switching sessions
    setSession(null);
    setAiPanel(null);
    setBranchName('main');
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
          setSelectedTool(response.data.toolType === 'codex' ? 'codex' : 'claude');
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

          const ai = panels.find(p => p.type === 'claude' || p.type === 'codex') || null;
          setAiPanel(ai);

          if (ai) {
            setSelectedTool(ai.type as CLITool);
          }
        }
      } catch (error) {
        console.error('Failed to load panels:', error);
      }
    };

    const loadBranch = async () => {
      try {
        const response = await withTimeout(API.sessions.getGitCommands(sessionId), 10_000, 'Load branch');
        if (requestId !== requestIdRef.current) return;
        if (response.success && response.data) {
          setBranchName(response.data.currentBranch || 'main');
        }
      } catch (error) {
        console.error('Failed to load branch:', error);
      }
    };

    Promise.allSettled([loadSession(), loadPanels(), loadBranch()]).finally(() => {
      if (requestId === requestIdRef.current) {
        setIsLoadingSession(false);
      }
    });
  }, [sessionId, reloadToken]);

  useEffect(() => {
    if (!sessionId) return;

    const handleSessionCreated = (createdSession: Session) => {
      if (createdSession.id !== sessionId) return;
      setSession(createdSession);
      setSelectedTool(createdSession.toolType === 'codex' ? 'codex' : 'claude');
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

  const ensureAiPanel = useCallback(async (desiredPanelType: 'claude' | 'codex') => {
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
        name: desiredPanelType === 'codex' ? 'Codex' : 'Claude'
      });

      if (createResponse?.success && createResponse.data) {
        panelToUse = createResponse.data;
        setAiPanel(panelToUse);
      } else {
        console.error('Failed to create AI panel:', createResponse?.error);
        return null;
      }
    }

    return panelToUse;
  }, [session, aiPanel]);

  const sendMessage = useCallback(async (message: string, images?: ImageAttachment[], planMode?: boolean) => {
    if (!session) return;

    setIsProcessing(true);

    try {
      const desiredPanelType = selectedTool === 'codex' ? 'codex' : 'claude';
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
      const desiredPanelType = tool === 'codex' ? 'codex' : 'claude';
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
    branchName,
    selectedTool,
    isProcessing,
    isLoadingSession,
    loadError,
    executionMode,
    reload: () => setReloadToken((v) => v + 1),
    setSelectedTool,
    setExecutionMode,
    sendMessage,
    sendMessageToTool,
    cancelRequest
  };
}

export default useLayoutData;
