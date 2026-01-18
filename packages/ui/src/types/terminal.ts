export type TerminalSummary = {
  id: string;
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: string;
};

export type TerminalOutputEvent = {
  sessionId: string;
  terminalId: string;
  data: string;
  type?: 'stdout' | 'stderr';
};

export type TerminalExitEvent = {
  sessionId: string;
  terminalId: string;
  exitCode: number;
  signal?: number;
};

export type TerminalClosedEvent = {
  sessionId: string;
  terminalId: string;
};
