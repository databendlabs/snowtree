import { useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import type { TodoItem } from '../stores/sessionStore';

interface TodoListProps {
  todos: TodoItem[];
  onClear?: () => void;
}

function getStatusIcon(status: string): string {
  switch (status) {
    case 'completed':
      return '✓';
    case 'in_progress':
      return '→';
    case 'pending':
      return '○';
    default:
      return '·';
  }
}

const colors = {
  bg: {
    secondary: 'var(--st-surface)',
    hover: 'var(--st-hover)',
  },
  text: {
    secondary: 'var(--st-text-muted)',
    muted: 'var(--st-text-faint)',
    primary: 'var(--st-text)',
  },
  border: 'var(--st-border-variant)',
  accent: 'var(--st-accent)',
  success: 'var(--st-success)',
};

export function TodoList({ todos, onClear }: TodoListProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);

  if (!todos || todos.length === 0) {
    return null;
  }

  const completedCount = todos.filter(t => t.status === 'completed').length;

  return (
    <div
      className="flex-shrink-0"
      style={{ borderTop: `1px solid ${colors.border}` }}
    >
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ backgroundColor: colors.bg.secondary }}
      >
        <button
          type="button"
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="flex items-center gap-1.5 text-xs font-medium transition-all duration-75 px-1.5 py-0.5 -ml-1.5 rounded st-hoverable st-focus-ring"
          style={{ color: colors.text.secondary }}
        >
          <ChevronDown
            className={`w-3 h-3 transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
            style={{ color: colors.text.muted }}
          />
          <span>Tasks</span>
          <span
            className="ml-1 px-1.5 py-0.5 text-[10px] rounded font-mono"
            style={{
              backgroundColor: colors.bg.hover,
              color: colors.text.muted,
            }}
          >
            {completedCount}/{todos.length}
          </span>
        </button>
        {onClear && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            className="p-1.5 rounded transition-all duration-75 st-hoverable st-focus-ring"
            title="Clear tasks"
          >
            <X
              className="w-3 h-3"
              style={{ color: colors.text.muted }}
            />
          </button>
        )}
      </div>

      <div
        className={`transition-all origin-top ${isCollapsed ? 'opacity-0 scale-y-0 h-0' : 'opacity-100 scale-y-100'}`}
        style={{ transitionDuration: '150ms' }}
      >
        <div className="px-3 py-3 space-y-1.5">
          {todos.map((todo, index) => (
            <div
              key={index}
              className="flex items-start gap-2 text-xs"
            >
              <span
                className="flex-shrink-0 mt-0.5"
                style={{
                  color:
                    todo.status === 'completed'
                      ? colors.success
                      : todo.status === 'in_progress'
                      ? colors.accent
                      : colors.text.muted,
                }}
              >
                {getStatusIcon(todo.status)}
              </span>
              <span
                className={`flex-1 ${
                  todo.status === 'completed' ? 'line-through' : ''
                } ${
                  todo.status === 'in_progress' ? 'font-medium' : ''
                }`}
                style={{
                  color:
                    todo.status === 'completed'
                      ? colors.text.muted
                      : todo.status === 'in_progress'
                      ? colors.text.primary
                      : colors.text.muted,
                }}
              >
                {todo.status === 'in_progress' && todo.activeForm
                  ? todo.activeForm
                  : todo.content}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
