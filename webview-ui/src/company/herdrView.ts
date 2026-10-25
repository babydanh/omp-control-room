/**
 * herdrView: how a herdr agent's status reads on the board, as pure data.
 *
 * herdr reports its own vocabulary (working / blocked / idle / done / unknown).
 * This file maps it to the board's tones once, so the sidebar and the drawer
 * cannot disagree about what "blocked" means.
 */

import type { HerdrAgent } from '../../../core/src/company.js';
import type { HerdrKey } from '../../../core/src/messages.js';

export type HerdrTone = 'working' | 'needs' | 'idle' | 'done' | 'unknown';

const TONE_BY_HERDR_STATUS: Readonly<Record<HerdrAgent['status'], HerdrTone>> = {
  working: 'working',
  blocked: 'needs',
  idle: 'idle',
  done: 'done',
  unknown: 'unknown',
};

export function herdrToneFor(status: HerdrAgent['status']): HerdrTone {
  return TONE_BY_HERDR_STATUS[status];
}

export const HERDR_TONE_LABELS: Readonly<Record<HerdrTone, string>> = {
  working: 'đang làm',
  needs: 'chờ bạn',
  idle: 'rảnh',
  done: 'xong',
  unknown: 'không rõ',
};

/** The herdr drawer's two tabs: the live screen, and what the agent is running. */
export type HerdrDrawerTab = 'screen' | 'info';

export const HERDR_DRAWER_TAB_LABELS: Readonly<Record<HerdrDrawerTab, string>> = {
  screen: 'Màn hình',
  info: 'Chi tiết',
};

/** Sort rank: what needs the user first, then what is moving, then the rest. */
export const HERDR_TONE_RANK: Readonly<Record<HerdrTone, number>> = {
  needs: 0,
  working: 1,
  idle: 2,
  done: 3,
  unknown: 4,
};

/** The keys the drawer offers while an agent waits on a choice. */
export const HERDR_CHOICE_KEYS: readonly { key: HerdrKey; label: string }[] = [
  { key: 'up', label: '↑' },
  { key: 'down', label: '↓' },
  { key: 'enter', label: 'Enter' },
  { key: 'esc', label: 'Esc' },
  { key: 'ctrl+c', label: 'Ctrl+C' },
];

/** How long a pane the board just opened or woke may stay out of herdr's list before it counts as gone. */
export const HERDR_START_GRACE_MS = 60_000;

/**
 * What the drawer shows for a pane herdr does not list. A pane the board just started or woke
 * takes a few seconds to appear (the agent is still launching): that is a wait, not a loss.
 */
export function missingPaneView(starting: boolean, elapsedMs: number): { readonly loading: boolean; readonly text: string } {
  if (starting && elapsedMs < HERDR_START_GRACE_MS) {
    return { loading: true, text: 'Đang khởi động phiên trong tab herdr mới…' };
  }
  if (starting) {
    return { loading: false, text: 'Phiên chưa lên sau 1 phút. Xem tab herdr mới mở để biết lỗi, hoặc đánh thức lại.' };
  }
  return { loading: false, text: 'Agent này không còn trong herdr.' };
}
