/**
 * Filters out OSC (Operating System Command) response sequences that should not be displayed.
 * These are responses to terminal queries (e.g., color queries) that get echoed back incorrectly.
 *
 * Common OSC responses to filter:
 * - OSC 10/11/12: Foreground/Background/Cursor color query responses
 * - Format: ESC ] Ps ; Pt (ST|BEL) where ST = ESC \ and BEL = \x07
 *
 * Background:
 * When shells initialize (especially with modern themes like Oh My Zsh, Powerlevel10k, Starship),
 * they send OSC queries to detect terminal capabilities. The terminal responds with color values,
 * but these responses can be incorrectly echoed to the display if not filtered.
 *
 * @param data Raw terminal output data
 * @returns Filtered data with OSC responses removed
 *
 * @example
 * ```typescript
 * // Filter OSC 11 background color response
 * filterOSCResponses('text\x1b]11;rgb:2828/2c2c/3434\x07more')
 * // Returns: 'textmore'
 *
 * // Preserve normal ANSI color codes
 * filterOSCResponses('\x1b[36mCyan\x1b[0m')
 * // Returns: '\x1b[36mCyan\x1b[0m'
 * ```
 */
export const filterOSCResponses = (data: string): string => {
  // Filter OSC sequences: \x1b]...\x07 or \x1b]...\x1b\\
  // This regex matches OSC sequences that are responses to queries
  // Pattern: ESC ] digits ; response (BEL or ST)
  // - \x1b\] : ESC followed by ]
  // - [0-9]+ : One or more digits (OSC command number)
  // - ; : Semicolon separator
  // - [^\x07\x1b]* : Any characters except BEL or ESC
  // - (?:\x07|\x1b\\) : Either BEL (\x07) or ST (ESC \)
  return data.replace(/\x1b\][0-9]+;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
};
