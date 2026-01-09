import './ThinkingMessage.css';

export interface ThinkingMessageProps {
  content: string;
  timestamp: string;
  isStreaming?: boolean;
}

export function ThinkingMessage({ content, timestamp, isStreaming }: ThinkingMessageProps) {
  const formatTime = (isoString: string) => {
    const date = new Date(isoString);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  };

  return (
    <div className="thinking-message">
      <div className="thinking-header">
        <span className="thinking-icon" title="AI is thinking">🧠</span>
        <span className="thinking-label">Thinking</span>
        {isStreaming && <span className="streaming-indicator" title="Streaming...">●</span>}
        <span className="thinking-timestamp">{formatTime(timestamp)}</span>
      </div>
      <div className="thinking-content">
        {content}
        {isStreaming && <span className="cursor-blink">▊</span>}
      </div>
    </div>
  );
}
