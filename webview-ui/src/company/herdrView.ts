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
