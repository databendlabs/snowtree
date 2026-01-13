import { useState, useEffect, useCallback, useRef } from 'react';
import './UserQuestionDialog.css';

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface UserQuestionDialogProps {
  questions: Question[];
  onSubmit: (answers: Record<string, string | string[]>) => void;
  onCancel?: () => void;
}

export function UserQuestionDialog({ questions, onSubmit, onCancel }: UserQuestionDialogProps) {
  const single = questions.length === 1 && questions[0]?.multiSelect !== true;
  const tabs = single ? 1 : questions.length + 1; // questions + confirm tab

  const [tab, setTab] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [customInput, setCustomInput] = useState<Record<string, string>>({});
  const [selectedOption, setSelectedOption] = useState(0);
  const [editingCustom, setEditingCustom] = useState(false);

  const currentQuestion = questions[tab];
  const isConfirmTab = !single && tab === questions.length;
  const options = currentQuestion?.options ?? [];
  const totalOptions = options.length + 1; // options + "Type your own answer"
  const isOtherSelected = selectedOption === options.length;
  const customValue = customInput[String(tab)] ?? '';
  const isCustomPicked = customValue && answers[String(tab)]?.includes(customValue);

  // Use refs to access latest values in keyboard handler without stale closures
  const stateRef = useRef({
    tab,
    tabs,
    single,
    answers,
    customInput,
    selectedOption,
    totalOptions,
    editingCustom,
    customValue,
    isConfirmTab,
    isOtherSelected,
    isCustomPicked,
    currentQuestion,
    options,
    questions,
    onSubmit,
    onCancel,
  });

  // Update ref on every render
  stateRef.current = {
    tab,
    tabs,
    single,
    answers,
    customInput,
    selectedOption,
    totalOptions,
    editingCustom,
    customValue,
    isConfirmTab,
    isOtherSelected,
    isCustomPicked,
    currentQuestion,
    options,
    questions,
    onSubmit,
    onCancel,
  };

  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const state = stateRef.current;

    // Only handle navigation keys to avoid interfering with text input
    const navigationKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'h', 'l', 'j', 'k', 'Enter', 'Escape'];
    if (!navigationKeys.includes(e.key)) return;

    const pick = (answer: string, custom: boolean = false) => {
      const key = String(state.tab);
      const newAnswers = { ...state.answers, [key]: [answer] };
      setAnswers(newAnswers);
      if (custom) {
        setCustomInput({ ...state.customInput, [key]: answer });
      }
      if (state.single) {
        state.onSubmit({ 0: [answer] });
        return;
      }
      setTab(state.tab + 1);
      setSelectedOption(0);
    };

    const toggle = (answer: string) => {
      const key = String(state.tab);
      const existing = state.answers[key] ?? [];
      const next = [...existing];
      const index = next.indexOf(answer);
      if (index === -1) next.push(answer);
      else next.splice(index, 1);
      setAnswers({ ...state.answers, [key]: next });
    };

    const submit = () => {
      const result: Record<string, string | string[]> = {};
      state.questions.forEach((q, idx) => {
        const key = String(idx);
        const selected = state.answers[key] ?? [];
        result[key] = q.multiSelect ? selected : selected[0] || '';
      });
      state.onSubmit(result);
    };

    // Handle custom input editing
    if (state.editingCustom && !state.isConfirmTab) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setEditingCustom(false);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const text = state.customValue.trim();
        const key = String(state.tab);
        const prev = state.customInput[key];

        if (!text) {
          // Clear custom input
          if (prev) {
            setCustomInput({ ...state.customInput, [key]: '' });
            setAnswers({
              ...state.answers,
              [key]: (state.answers[key] ?? []).filter(x => x !== prev)
            });
          }
          setEditingCustom(false);
          return;
        }

        if (state.currentQuestion?.multiSelect) {
          setCustomInput({ ...state.customInput, [key]: text });
          const existing = state.answers[key] ?? [];
          const next = [...existing];
          if (prev) {
            const index = next.indexOf(prev);
            if (index !== -1) next.splice(index, 1);
          }
          if (!next.includes(text)) next.push(text);
          setAnswers({ ...state.answers, [key]: next });
          setEditingCustom(false);
          return;
        }

        // Single select - pick and move to next
        pick(text, true);
        setEditingCustom(false);
        return;
      }
      // Let input handle other keys
      return;
    }

    // Tab navigation (Left/Right or H/L)
    if (e.key === 'ArrowLeft' || e.key === 'h') {
      e.preventDefault();
      const next = (state.tab - 1 + state.tabs) % state.tabs;
      setTab(next);
      setSelectedOption(0);
    }

    if (e.key === 'ArrowRight' || e.key === 'l') {
      e.preventDefault();
      const next = (state.tab + 1) % state.tabs;
      setTab(next);
      setSelectedOption(0);
    }

    // Confirm tab
    if (state.isConfirmTab) {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        submit();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        state.onCancel?.();
      }
      return;
    }

    // Option selection (Up/Down or J/K)
    if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      setSelectedOption((state.selectedOption - 1 + state.totalOptions) % state.totalOptions);
    }

    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      setSelectedOption((state.selectedOption + 1) % state.totalOptions);
    }

    // Enter to confirm selection
    if (e.key === 'Enter') {
      e.preventDefault();
      if (state.isOtherSelected) {
        if (!state.currentQuestion?.multiSelect) {
          setEditingCustom(true);
          return;
        }
        const value = state.customValue;
        if (value && state.isCustomPicked) {
          toggle(value);
          return;
        }
        setEditingCustom(true);
        return;
      }
      const opt = state.options[state.selectedOption];
      if (!opt) return;
      if (state.currentQuestion?.multiSelect) {
        toggle(opt.label);
        return;
      }
      pick(opt.label);
    }

    // Escape to cancel
    if (e.key === 'Escape') {
      e.preventDefault();
      state.onCancel?.();
    }
  }, []);

  useEffect(() => {
    // Use capture: true to handle events before other handlers can intercept them
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [handleKeyDown]);

  return (
    <div className="user-question-inline">
      {/* Tab headers (if multiple questions) */}
      {!single && (
        <div className="question-tabs">
          {questions.map((q, index) => {
            const isActive = index === tab;
            const isAnswered = (answers[String(index)]?.length ?? 0) > 0;
            return (
              <div
                key={index}
                className={`tab ${isActive ? 'active' : ''} ${isAnswered ? 'answered' : ''}`}
              >
                {q.header}
              </div>
            );
          })}
          <div className={`tab ${isConfirmTab ? 'active' : ''}`}>
            Confirm
          </div>
        </div>
      )}

      {/* Question content */}
      {!isConfirmTab && currentQuestion && (
        <div className="question-content">
          <div className="question-text">
            {currentQuestion.question}
            {currentQuestion.multiSelect && ' (select all that apply)'}
          </div>

          {/* Options list */}
          <div className="options-list-tui">
            {options.map((opt, i) => {
              const isActive = i === selectedOption;
              const isPicked = answers[String(tab)]?.includes(opt.label);
              return (
                <div
                  key={i}
                  className={`option-tui ${isActive ? 'active' : ''} ${isPicked ? 'picked' : ''}`}
                >
                  <div className="option-label">
                    <span className="option-number">{i + 1}.</span>
                    <span className="option-text">{opt.label}</span>
                    {isPicked && <span className="check-mark">✓</span>}
                  </div>
                  <div className="option-description">{opt.description}</div>
                </div>
              );
            })}

            {/* "Type your own answer" option */}
            <div
              className={`option-tui ${isOtherSelected ? 'active' : ''} ${isCustomPicked ? 'picked' : ''}`}
            >
              <div className="option-label">
                <span className="option-number">{options.length + 1}.</span>
                <span className="option-text">Type your own answer</span>
                {isCustomPicked && <span className="check-mark">✓</span>}
              </div>
              {editingCustom && (
                <div className="custom-input-container">
                  <input
                    type="text"
                    className="custom-input-tui"
                    placeholder="Type your own answer"
                    value={customValue}
                    onChange={(e) => setCustomInput({ ...customInput, [String(tab)]: e.target.value })}
                    autoFocus
                  />
                </div>
              )}
              {!editingCustom && customValue && (
                <div className="custom-value">{customValue}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Confirm/Review tab */}
      {isConfirmTab && !single && (
        <div className="question-content">
          <div className="question-text">Review</div>
          <div className="review-list">
            {questions.map((q, index) => {
              const value = answers[String(index)]?.join(', ') ?? '';
              const answered = Boolean(value);
              return (
                <div key={index} className="review-item">
                  <span className="review-label">{q.header}:</span>
                  <span className={`review-value ${answered ? '' : 'unanswered'}`}>
                    {answered ? value : '(not answered)'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Keyboard shortcuts help */}
      <div className="keyboard-shortcuts">
        {!isConfirmTab && (
          <span className="shortcut">
            <span className="key">↑↓</span> <span className="hint">select</span>
          </span>
        )}
        <span className="shortcut">
          <span className="key">enter</span>{' '}
          <span className="hint">
            {isConfirmTab ? 'submit' : currentQuestion?.multiSelect ? 'toggle' : single ? 'submit' : 'confirm'}
          </span>
        </span>
        <span className="shortcut">
          <span className="key">esc</span> <span className="hint">dismiss</span>
        </span>
      </div>
    </div>
  );
}
