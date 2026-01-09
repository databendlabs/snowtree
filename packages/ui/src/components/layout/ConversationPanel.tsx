import React from 'react';
import { TimelineView } from '../panels/timeline/TimelineView';
import type { ConversationPanelProps } from './types';

export const ConversationPanel: React.FC<ConversationPanelProps> = React.memo(({
  session,
  pendingMessage
}) => {
  return (
    <TimelineView
      sessionId={session.id}
      session={session}
      pendingMessage={pendingMessage}
    />
  );
});

ConversationPanel.displayName = 'ConversationPanel';

export default ConversationPanel;
