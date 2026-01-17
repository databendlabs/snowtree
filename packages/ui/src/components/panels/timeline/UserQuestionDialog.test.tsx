import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { UserQuestionDialog, type Question, type UserQuestionDialogProps } from './UserQuestionDialog';

describe('UserQuestionDialog', () => {
  let mockOnSubmit: ReturnType<typeof vi.fn>;
  let mockOnCancel: ReturnType<typeof vi.fn>;

  const singleQuestion: Question[] = [
    {
      question: 'Which framework do you prefer?',
      header: 'Framework',
      options: [
        { label: 'React', description: 'A JavaScript library for building user interfaces' },
        { label: 'Vue', description: 'The Progressive JavaScript Framework' },
        { label: 'Angular', description: 'Platform for building mobile and desktop web apps' },
      ],
      multiSelect: false,
    },
  ];

  const multipleQuestions: Question[] = [
    {
      question: 'Which framework do you prefer?',
      header: 'Framework',
      options: [
        { label: 'React', description: 'A JavaScript library for building user interfaces' },
        { label: 'Vue', description: 'The Progressive JavaScript Framework' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which features do you want?',
      header: 'Features',
      options: [
        { label: 'TypeScript', description: 'Add type safety' },
        { label: 'ESLint', description: 'Code linting' },
      ],
      multiSelect: true,
    },
  ];

  beforeEach(() => {
    mockOnSubmit = vi.fn();
    mockOnCancel = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Single question mode', () => {
    it('should render a single question with options', () => {
      render(
        <UserQuestionDialog
          questions={singleQuestion}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      expect(screen.getByText('Which framework do you prefer?')).toBeInTheDocument();
      expect(screen.getByText('React')).toBeInTheDocument();
      expect(screen.getByText('Vue')).toBeInTheDocument();
      expect(screen.getByText('Angular')).toBeInTheDocument();
      expect(screen.getByText('Type your own answer')).toBeInTheDocument();
    });

    it('should not show tab headers for single question', () => {
      render(
        <UserQuestionDialog
          questions={singleQuestion}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      expect(screen.queryByText('Framework')).not.toBeInTheDocument();
      expect(screen.queryByText('Confirm')).not.toBeInTheDocument();
    });

    it('should submit immediately on Enter for single question', () => {
      render(
        <UserQuestionDialog
          questions={singleQuestion}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      // Press Enter on first option (React)
      fireEvent.keyDown(window, { key: 'Enter' });

      expect(mockOnSubmit).toHaveBeenCalledWith({ 0: ['React'] });
    });

    it('should navigate options with ArrowDown/ArrowUp', () => {
      render(
        <UserQuestionDialog
          questions={singleQuestion}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      // First option should be active by default
      const options = document.querySelectorAll('.option-tui');
      expect(options[0]).toHaveClass('active');

      // Press ArrowDown to move to second option
      fireEvent.keyDown(window, { key: 'ArrowDown' });
      expect(options[0]).not.toHaveClass('active');
      expect(options[1]).toHaveClass('active');

      // Press ArrowUp to go back
      fireEvent.keyDown(window, { key: 'ArrowUp' });
      expect(options[0]).toHaveClass('active');
      expect(options[1]).not.toHaveClass('active');
    });

    it('should navigate options with j/k keys', () => {
      render(
        <UserQuestionDialog
          questions={singleQuestion}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      const options = document.querySelectorAll('.option-tui');
      expect(options[0]).toHaveClass('active');

      // Press j to move down
      fireEvent.keyDown(window, { key: 'j' });
      expect(options[1]).toHaveClass('active');

      // Press k to move up
      fireEvent.keyDown(window, { key: 'k' });
      expect(options[0]).toHaveClass('active');
    });

    it('should call onCancel when Escape is pressed', () => {
      render(
        <UserQuestionDialog
          questions={singleQuestion}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      fireEvent.keyDown(window, { key: 'Escape' });

      expect(mockOnCancel).toHaveBeenCalledTimes(1);
    });

    it('should wrap around when navigating past last option', () => {
      render(
        <UserQuestionDialog
          questions={singleQuestion}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      const options = document.querySelectorAll('.option-tui');
      // 4 options: React, Vue, Angular, "Type your own"

      // Navigate to last option
      fireEvent.keyDown(window, { key: 'ArrowDown' }); // Vue
      fireEvent.keyDown(window, { key: 'ArrowDown' }); // Angular
      fireEvent.keyDown(window, { key: 'ArrowDown' }); // Type your own
      expect(options[3]).toHaveClass('active');

      // Wrap to first
      fireEvent.keyDown(window, { key: 'ArrowDown' });
      expect(options[0]).toHaveClass('active');
    });

    it('should select different option before submitting', () => {
      render(
        <UserQuestionDialog
          questions={singleQuestion}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      // Navigate to Vue (second option)
      fireEvent.keyDown(window, { key: 'ArrowDown' });

      // Submit
      fireEvent.keyDown(window, { key: 'Enter' });

      expect(mockOnSubmit).toHaveBeenCalledWith({ 0: ['Vue'] });
    });
  });

  describe('Multiple questions mode', () => {
    it('should show tab headers for multiple questions', () => {
      render(
        <UserQuestionDialog
          questions={multipleQuestions}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      expect(screen.getByText('Framework')).toBeInTheDocument();
      expect(screen.getByText('Features')).toBeInTheDocument();
      expect(screen.getByText('Confirm')).toBeInTheDocument();
    });

    it('should show first question content initially', () => {
      render(
        <UserQuestionDialog
          questions={multipleQuestions}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      expect(screen.getByText('Which framework do you prefer?')).toBeInTheDocument();
      expect(screen.getByText('React')).toBeInTheDocument();
    });

    it('should advance to next question on Enter (single select)', () => {
      render(
        <UserQuestionDialog
          questions={multipleQuestions}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      // Select React and advance
      fireEvent.keyDown(window, { key: 'Enter' });

      // Should now show second question - check for the option that exists only on Features tab
      expect(screen.getByText('TypeScript')).toBeInTheDocument();
      // Check that Features tab is now active
      const featuresTab = screen.getByText('Features');
      expect(featuresTab).toHaveClass('active');
    });

    it('should navigate between tabs with ArrowLeft/ArrowRight', () => {
      render(
        <UserQuestionDialog
          questions={multipleQuestions}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      // Should be on first tab (Framework)
      expect(screen.getByText('React')).toBeInTheDocument();
      const frameworkTab = screen.getByText('Framework');
      expect(frameworkTab).toHaveClass('active');

      // Move to next tab (Features)
      fireEvent.keyDown(window, { key: 'ArrowRight' });
      expect(screen.getByText('TypeScript')).toBeInTheDocument();
      const featuresTab = screen.getByText('Features');
      expect(featuresTab).toHaveClass('active');

      // Move back (Framework)
      fireEvent.keyDown(window, { key: 'ArrowLeft' });
      expect(screen.getByText('React')).toBeInTheDocument();
      expect(frameworkTab).toHaveClass('active');
    });

    it('should navigate between tabs with h/l keys', () => {
      render(
        <UserQuestionDialog
          questions={multipleQuestions}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      // Should start on Framework tab with React option
      expect(screen.getByText('React')).toBeInTheDocument();

      // Move to next tab with l
      fireEvent.keyDown(window, { key: 'l' });

      // Should now show Features tab (has TypeScript option)
      expect(screen.getByText('TypeScript')).toBeInTheDocument();

      // Move back with h
      fireEvent.keyDown(window, { key: 'h' });

      // Should be back on Framework tab
      expect(screen.getByText('React')).toBeInTheDocument();
    });

    it('should toggle options in multi-select mode', () => {
      render(
        <UserQuestionDialog
          questions={multipleQuestions}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      // Navigate to Features tab (multi-select)
      fireEvent.keyDown(window, { key: 'ArrowRight' });

      // Select TypeScript
      fireEvent.keyDown(window, { key: 'Enter' });
      expect(screen.getAllByTestId('check-mark').length).toBeGreaterThan(0);

      // Toggle it off
      fireEvent.keyDown(window, { key: 'Enter' });
      expect(screen.queryAllByTestId('check-mark')).toHaveLength(0);
    });

    it('should show Review tab content', () => {
      render(
        <UserQuestionDialog
          questions={multipleQuestions}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      // Navigate to Confirm tab
      fireEvent.keyDown(window, { key: 'ArrowRight' }); // Features
      fireEvent.keyDown(window, { key: 'ArrowRight' }); // Confirm

      expect(screen.getByText('Review')).toBeInTheDocument();
      expect(screen.getByText('Framework:')).toBeInTheDocument();
      expect(screen.getByText('Features:')).toBeInTheDocument();
    });

    it('should submit on Enter from Confirm tab', () => {
      render(
        <UserQuestionDialog
          questions={multipleQuestions}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      // Select React
      fireEvent.keyDown(window, { key: 'Enter' });

      // Select TypeScript
      fireEvent.keyDown(window, { key: 'Enter' });

      // Navigate to Confirm tab
      fireEvent.keyDown(window, { key: 'ArrowRight' });

      // Submit
      fireEvent.keyDown(window, { key: 'Enter' });

      expect(mockOnSubmit).toHaveBeenCalledWith({
        0: 'React',
        1: ['TypeScript'],
      });
    });

    it('should mark tabs as answered', () => {
      render(
        <UserQuestionDialog
          questions={multipleQuestions}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      // First tab should be active
      const tabs = document.querySelectorAll('.tab');
      expect(tabs[0]).toHaveClass('active');

      // Select an option
      fireEvent.keyDown(window, { key: 'Enter' });

      // First tab should now be answered
      expect(tabs[0]).toHaveClass('answered');
    });
  });

  describe('Custom input', () => {
    it('should show custom input when "Type your own" is selected and Enter pressed', () => {
      render(
        <UserQuestionDialog
          questions={singleQuestion}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      // Navigate to "Type your own answer" (last option, index 3)
      fireEvent.keyDown(window, { key: 'ArrowDown' }); // Vue
      fireEvent.keyDown(window, { key: 'ArrowDown' }); // Angular
      fireEvent.keyDown(window, { key: 'ArrowDown' }); // Type your own

      // Press Enter to start editing
      fireEvent.keyDown(window, { key: 'Enter' });

      // Custom input should appear
      const input = screen.getByPlaceholderText('Type your own answer');
      expect(input).toBeInTheDocument();
    });

    it('should submit custom input on Enter', async () => {
      render(
        <UserQuestionDialog
          questions={singleQuestion}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      // Navigate to "Type your own answer"
      fireEvent.keyDown(window, { key: 'ArrowDown' });
      fireEvent.keyDown(window, { key: 'ArrowDown' });
      fireEvent.keyDown(window, { key: 'ArrowDown' });

      // Enter editing mode
      fireEvent.keyDown(window, { key: 'Enter' });

      // Type custom value
      const input = screen.getByPlaceholderText('Type your own answer');
      fireEvent.change(input, { target: { value: 'Svelte' } });

      // Submit custom value
      fireEvent.keyDown(window, { key: 'Enter' });

      expect(mockOnSubmit).toHaveBeenCalledWith({ 0: ['Svelte'] });
    });

    it('should exit custom input editing on Escape', () => {
      render(
        <UserQuestionDialog
          questions={singleQuestion}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      // Navigate to "Type your own answer" and enter editing
      fireEvent.keyDown(window, { key: 'ArrowDown' });
      fireEvent.keyDown(window, { key: 'ArrowDown' });
      fireEvent.keyDown(window, { key: 'ArrowDown' });
      fireEvent.keyDown(window, { key: 'Enter' });

      // Input should be visible
      expect(screen.getByPlaceholderText('Type your own answer')).toBeInTheDocument();

      // Press Escape to exit editing
      fireEvent.keyDown(window, { key: 'Escape' });

      // Input should be hidden (but onCancel should NOT be called since we're exiting edit mode)
      // The component stays open, just exits edit mode
      expect(mockOnCancel).not.toHaveBeenCalled();
    });
  });

  describe('Keyboard shortcuts display', () => {
    it('should show navigation shortcuts', () => {
      render(
        <UserQuestionDialog
          questions={singleQuestion}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      expect(screen.getByTestId('nav-keys-icon')).toBeInTheDocument();
      expect(screen.getByText('select')).toBeInTheDocument();
      expect(screen.getByText('enter')).toBeInTheDocument();
      expect(screen.getByText('esc')).toBeInTheDocument();
      expect(screen.getByText('dismiss')).toBeInTheDocument();
    });

    it('should show "submit" hint for single question', () => {
      render(
        <UserQuestionDialog
          questions={singleQuestion}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      expect(screen.getByText('submit')).toBeInTheDocument();
    });

    it('should show "toggle" hint for multi-select question', () => {
      render(
        <UserQuestionDialog
          questions={multipleQuestions}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      // Navigate to the Features tab (multi-select)
      fireEvent.keyDown(window, { key: 'ArrowRight' });

      expect(screen.getByText('toggle')).toBeInTheDocument();
    });

    it('should show "confirm" hint for single-select in multi-question mode', () => {
      render(
        <UserQuestionDialog
          questions={multipleQuestions}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      expect(screen.getByText('confirm')).toBeInTheDocument();
    });

    it('should show "submit" hint on confirm tab', () => {
      render(
        <UserQuestionDialog
          questions={multipleQuestions}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      // Navigate to confirm tab
      fireEvent.keyDown(window, { key: 'ArrowRight' }); // Features
      fireEvent.keyDown(window, { key: 'ArrowRight' }); // Confirm

      expect(screen.getByText('submit')).toBeInTheDocument();
    });
  });

  describe('Edge cases', () => {
    it('should handle empty options gracefully', () => {
      const emptyOptions: Question[] = [
        {
          question: 'Choose something',
          header: 'Choice',
          options: [],
          multiSelect: false,
        },
      ];

      render(
        <UserQuestionDialog
          questions={emptyOptions}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
        />
      );

      // Should still render with "Type your own answer"
      expect(screen.getByText('Type your own answer')).toBeInTheDocument();
    });

    it('should not call onCancel if not provided', () => {
      render(
        <UserQuestionDialog
          questions={singleQuestion}
          onSubmit={mockOnSubmit}
        />
      );

      // Should not throw when pressing Escape
      expect(() => {
        fireEvent.keyDown(window, { key: 'Escape' });
      }).not.toThrow();
    });
  });
});
