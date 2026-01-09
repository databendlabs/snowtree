import { useState } from 'react';
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
  const [answers, setAnswers] = useState<Record<string, Set<string>>>({});
  const [customInput, setCustomInput] = useState<Record<string, string>>({});

  const handleOptionToggle = (questionIdx: number, label: string, multiSelect: boolean) => {
    const key = String(questionIdx);
    const current = answers[key] || new Set();

    if (multiSelect) {
      const updated = new Set(current);
      if (updated.has(label)) {
        updated.delete(label);
      } else {
        updated.add(label);
      }
      setAnswers({ ...answers, [key]: updated });
    } else {
      setAnswers({ ...answers, [key]: new Set([label]) });
    }
  };

  const handleSubmit = () => {
    const result: Record<string, string | string[]> = {};

    questions.forEach((q, idx) => {
      const key = String(idx);
      const selected = Array.from(answers[key] || []);

      // If "Other" is selected, use custom input
      if (selected.includes('Other') && customInput[key]) {
        result[key] = customInput[key];
      } else if (q.multiSelect) {
        result[key] = selected.filter(s => s !== 'Other');
      } else {
        result[key] = selected.find(s => s !== 'Other') || '';
      }
    });

    onSubmit(result);
  };

  const canSubmit = () => {
    return questions.every((_q, idx) => {
      const key = String(idx);
      const selected = answers[key];
      if (!selected || selected.size === 0) return false;
      // If "Other" is selected, ensure custom input is provided
      if (selected.has('Other')) {
        return customInput[key]?.trim().length > 0;
      }
      return true;
    });
  };

  return (
    <div className="user-question-overlay">
      <div className="user-question-dialog">
        <div className="dialog-header">
          <span className="dialog-icon">🤔</span>
          <h3 className="dialog-title">AI needs your input</h3>
        </div>

        <div className="dialog-body">
          {questions.map((q, qIdx) => (
            <div key={qIdx} className="question-block">
              <div className="question-header-badge">
                <span className="question-badge">{q.header}</span>
              </div>
              <p className="question-text">{q.question}</p>

              <div className="options-list">
                {q.options.map((opt, optIdx) => {
                  const isSelected = answers[String(qIdx)]?.has(opt.label);
                  return (
                    <div
                      key={optIdx}
                      className={`option ${isSelected ? 'selected' : ''}`}
                      onClick={() => handleOptionToggle(qIdx, opt.label, q.multiSelect)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleOptionToggle(qIdx, opt.label, q.multiSelect);
                        }
                      }}
                    >
                      <div className="option-header">
                        <input
                          type={q.multiSelect ? 'checkbox' : 'radio'}
                          checked={isSelected}
                          onChange={() => {}} // Handled by div onClick
                          onClick={(e) => e.stopPropagation()}
                          tabIndex={-1}
                        />
                        <span className="option-label">{opt.label}</span>
                      </div>
                      <p className="option-description">{opt.description}</p>
                    </div>
                  );
                })}

                {/* Automatic "Other" option */}
                <div
                  className={`option ${answers[String(qIdx)]?.has('Other') ? 'selected' : ''}`}
                  onClick={() => handleOptionToggle(qIdx, 'Other', q.multiSelect)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleOptionToggle(qIdx, 'Other', q.multiSelect);
                    }
                  }}
                >
                  <div className="option-header">
                    <input
                      type={q.multiSelect ? 'checkbox' : 'radio'}
                      checked={answers[String(qIdx)]?.has('Other')}
                      onChange={() => {}} // Handled by div onClick
                      onClick={(e) => e.stopPropagation()}
                      tabIndex={-1}
                    />
                    <span className="option-label">Other</span>
                  </div>
                  {answers[String(qIdx)]?.has('Other') && (
                    <input
                      type="text"
                      placeholder="Please specify..."
                      value={customInput[String(qIdx)] || ''}
                      onChange={(e) =>
                        setCustomInput({ ...customInput, [String(qIdx)]: e.target.value })
                      }
                      onClick={(e) => e.stopPropagation()}
                      className="custom-input"
                      autoFocus
                    />
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="dialog-actions">
          {onCancel && (
            <button onClick={onCancel} className="cancel-btn" type="button">
              Cancel
            </button>
          )}
          <button
            onClick={handleSubmit}
            className="submit-btn"
            disabled={!canSubmit()}
            type="button"
          >
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}
