/**
 * claudeCodeView: what the board says about Claude Code, as pure rules. The server owns the
 * install and sign-in check and each run's progress; this module only words them for the board.
 *
 * DOM-free and React-free, so the settings form, the cards, the panel and the tests read one set
 * of rules.
 */

import type {
  ClaudeCodeStatus,
  WorkItemClaudeRun,
  WorkItemStatus,
} from '../../../core/src/messages.js';

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

/** What a run the board restarted under says, and what to do about it. */
export const CLAUDE_INTERRUPTED_NOTE =
  'Bị gián đoạn khi board khởi động lại. Gửi tiếp để tiếp tục.';

/** The note a Claude Code run shows when a board restart cut it short; null when it was not. */
export function claudeInterruptedNote(run: WorkItemClaudeRun | null | undefined): string | null {
  return run?.interrupted === true ? CLAUDE_INTERRUPTED_NOTE : null;
}

/**
 * The progress line of a running Claude Code item: the latest progress the run reported, trimmed.
 * Null while the item is not running, or while the run has reported nothing.
 */
export function claudeProgressLine(item: {
  status: WorkItemStatus;
  claudeRun?: WorkItemClaudeRun | null;
}): string | null {
  if (item.status !== 'running') return null;
  const progress = item.claudeRun?.progress?.trim() ?? '';
  return progress === '' ? null : progress;
}
