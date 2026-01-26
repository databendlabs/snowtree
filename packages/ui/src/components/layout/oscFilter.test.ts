import { describe, it, expect } from 'vitest';
import { filterOSCResponses } from './oscFilter';

describe('filterOSCResponses', () => {
  describe('OSC 11 (Background Color) Responses', () => {
    it('filters OSC 11 response with BEL terminator', () => {
      const input = '➜  test \x1b]11;rgb:2828/2c2c/3434\x07\n';
      const expected = '➜  test \n';
      expect(filterOSCResponses(input)).toBe(expected);
    });

    it('filters OSC 11 response with ST terminator', () => {
      const input = 'test\x1b]11;rgb:c8c8/cccc/d4d4\x1b\\output';
      const expected = 'testoutput';
      expect(filterOSCResponses(input)).toBe(expected);
    });

    it('filters OSC 11 response in the middle of text', () => {
      const input = 'before\x1b]11;rgb:1111/2222/3333\x07after';
      const expected = 'beforeafter';
      expect(filterOSCResponses(input)).toBe(expected);
    });
  });

  describe('OSC 10 (Foreground Color) Responses', () => {
    it('filters OSC 10 response with BEL terminator', () => {
      const input = 'text\x1b]10;rgb:ffff/ffff/ffff\x07more text';
      const expected = 'textmore text';
      expect(filterOSCResponses(input)).toBe(expected);
    });

    it('filters OSC 10 response with ST terminator', () => {
      const input = 'start\x1b]10;rgb:0000/0000/0000\x1b\\end';
      const expected = 'startend';
      expect(filterOSCResponses(input)).toBe(expected);
    });
  });

  describe('OSC 12 (Cursor Color) Responses', () => {
    it('filters OSC 12 response with BEL terminator', () => {
      const input = 'cursor\x1b]12;rgb:61af/efef/0000\x07test';
      const expected = 'cursortest';
      expect(filterOSCResponses(input)).toBe(expected);
    });

    it('filters OSC 12 response with ST terminator', () => {
      const input = 'a\x1b]12;rgb:ffff/0000/0000\x1b\\b';
      const expected = 'ab';
      expect(filterOSCResponses(input)).toBe(expected);
    });
  });

  describe('Multiple OSC Responses', () => {
    it('filters multiple OSC responses in single string', () => {
      const input = '\x1b]10;rgb:ffff/ffff/ffff\x07\x1b]11;rgb:0000/0000/0000\x07normal text';
      const expected = 'normal text';
      expect(filterOSCResponses(input)).toBe(expected);
    });

    it('filters mixed OSC 10, 11, and 12 responses', () => {
      const input = 'a\x1b]10;rgb:1111/1111/1111\x07b\x1b]11;rgb:2222/2222/2222\x07c\x1b]12;rgb:3333/3333/3333\x07d';
      const expected = 'abcd';
      expect(filterOSCResponses(input)).toBe(expected);
    });

    it('filters consecutive OSC responses', () => {
      const input = '\x1b]11;rgb:1111/2222/3333\x07\x1b]11;rgb:4444/5555/6666\x07\x1b]11;rgb:7777/8888/9999\x07';
      const expected = '';
      expect(filterOSCResponses(input)).toBe(expected);
    });
  });

  describe('ANSI Color Codes Preservation', () => {
    it('preserves normal ANSI color codes (CSI sequences)', () => {
      const input = '\x1b[36mCyan text\x1b[0m';
      expect(filterOSCResponses(input)).toBe(input);
    });

    it('preserves ANSI bold codes', () => {
      const input = '\x1b[1mBold text\x1b[0m';
      expect(filterOSCResponses(input)).toBe(input);
    });

    it('preserves ANSI 256-color codes', () => {
      const input = '\x1b[38;5;214mOrange\x1b[0m';
      expect(filterOSCResponses(input)).toBe(input);
    });

    it('preserves ANSI RGB color codes', () => {
      const input = '\x1b[38;2;255;100;50mRGB Color\x1b[0m';
      expect(filterOSCResponses(input)).toBe(input);
    });
  });

  describe('Mixed OSC and ANSI Sequences', () => {
    it('filters OSC while preserving ANSI codes', () => {
      const input = '\x1b[1mBold\x1b]11;rgb:1111/2222/3333\x07\x1b[0m';
      const expected = '\x1b[1mBold\x1b[0m';
      expect(filterOSCResponses(input)).toBe(expected);
    });

    it('handles complex mixed sequences', () => {
      const input = '\x1b[36m\x1b]10;rgb:ffff/ffff/ffff\x07Cyan\x1b]11;rgb:0000/0000/0000\x07\x1b[0m';
      const expected = '\x1b[36mCyan\x1b[0m';
      expect(filterOSCResponses(input)).toBe(expected);
    });

    it('preserves ANSI before and after OSC filtering', () => {
      const input = '\x1b[32mGreen\x1b[0m\x1b]11;rgb:1234/5678/9abc\x07\x1b[31mRed\x1b[0m';
      const expected = '\x1b[32mGreen\x1b[0m\x1b[31mRed\x1b[0m';
      expect(filterOSCResponses(input)).toBe(expected);
    });
  });

  describe('Edge Cases', () => {
    it('handles empty string', () => {
      expect(filterOSCResponses('')).toBe('');
    });

    it('handles string with no OSC sequences', () => {
      const input = 'normal text without any escape sequences';
      expect(filterOSCResponses(input)).toBe(input);
    });

    it('handles OSC response at start of string', () => {
      const input = '\x1b]11;rgb:1111/2222/3333\x07text';
      const expected = 'text';
      expect(filterOSCResponses(input)).toBe(expected);
    });

    it('handles OSC response at end of string', () => {
      const input = 'text\x1b]11;rgb:1111/2222/3333\x07';
      const expected = 'text';
      expect(filterOSCResponses(input)).toBe(expected);
    });

    it('handles only OSC response', () => {
      const input = '\x1b]11;rgb:1111/2222/3333\x07';
      const expected = '';
      expect(filterOSCResponses(input)).toBe(expected);
    });

    it('handles newlines and special characters', () => {
      const input = 'line1\n\x1b]11;rgb:1111/2222/3333\x07line2\r\n';
      const expected = 'line1\nline2\r\n';
      expect(filterOSCResponses(input)).toBe(expected);
    });

    it('handles unicode characters', () => {
      const input = '➜ 🚀 \x1b]11;rgb:1111/2222/3333\x07 测试';
      const expected = '➜ 🚀  测试';
      expect(filterOSCResponses(input)).toBe(expected);
    });
  });

  describe('Real-world Shell Prompt Scenarios', () => {
    it('filters Oh My Zsh color query responses', () => {
      const input = '➜  project git:(main) \x1b]11;rgb:2828/2c2c/3434\x07✗ ';
      const expected = '➜  project git:(main) ✗ ';
      expect(filterOSCResponses(input)).toBe(expected);
    });

    it('filters Powerlevel10k initialization sequences', () => {
      const input = '\x1b]10;rgb:c8c8/cccc/d4d4\x07\x1b]11;rgb:2828/2c2c/3434\x07\x1b]12;rgb:61af/efef/0000\x07$ ';
      const expected = '$ ';
      expect(filterOSCResponses(input)).toBe(expected);
    });

    it('handles Starship prompt with color queries', () => {
      const input = '\x1b]11;rgb:1e1e/1e1e/1e1e\x07\x1b[1;32m❯\x1b[0m ';
      const expected = '\x1b[1;32m❯\x1b[0m ';
      expect(filterOSCResponses(input)).toBe(expected);
    });
  });

  describe('Issue #82 Regression Tests', () => {
    it('prevents the bug reported in issue #82', () => {
      // The actual bug sequence from the issue
      const input = '➜  pretoria-wsmv5f5n git:(pretoria-wsmv5f5n) ✗ \x1b]11;rgb:2828/2c2c/3434\x07\n';
      const result = filterOSCResponses(input);

      // Should not contain the OSC response
      expect(result).not.toContain('\x1b]11');
      expect(result).not.toContain('rgb:2828/2c2c/3434');

      // Should preserve the prompt
      expect(result).toContain('➜  pretoria-wsmv5f5n');
      expect(result).toContain('git:(pretoria-wsmv5f5n)');
      expect(result).toContain('✗');
    });

    it('handles multiple terminal open/close cycles', () => {
      // Simulating multiple terminal opens that each send color queries
      const inputs = [
        '\x1b]11;rgb:2828/2c2c/3434\x07prompt1$ ',
        '\x1b]11;rgb:2828/2c2c/3434\x07prompt2$ ',
        '\x1b]11;rgb:2828/2c2c/3434\x07prompt3$ ',
      ];

      inputs.forEach((input, index) => {
        const result = filterOSCResponses(input);
        expect(result).toBe(`prompt${index + 1}$ `);
        expect(result).not.toContain('\x1b]11');
      });
    });
  });
});
