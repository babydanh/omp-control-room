/**
 * claudeCodeView: how the board words Claude Code's install and sign-in status. The server owns
 * the check, and this module provides pure status labels for the board and its settings form.
 *
 * DOM-free and React-free, so the settings form and tests read one set of rules.
 */

import type { ClaudeCodeStatus } from '../../../core/src/messages.js';

const CLAUDE_STATUS_WORD_VI: Readonly<Record<ClaudeCodeStatus['state'], string>> = {
  unknown: 'Claude Code: chưa kiểm tra',
  missing: 'Claude Code: chưa cài',
  signed_out: 'Claude Code: chưa đăng nhập — chạy `claude` để đăng nhập',
  signed_in: 'Claude Code: đã đăng nhập (gói Claude)',
};

/** The status line for a folder's Claude Code check. Until a check answers, it reads as unknown. */
export function claudeStatusLabel(status: ClaudeCodeStatus | null): string {
  return status === null ? CLAUDE_STATUS_WORD_VI.unknown : CLAUDE_STATUS_WORD_VI[status.state];
}

