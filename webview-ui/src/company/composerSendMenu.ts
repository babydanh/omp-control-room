/**
 * The composer's send menu: the three ways to hand the draft on besides the plain send. The
 * entries and the reason each one is off are pure, so the menu's rules are tested without a DOM.
 */

import { FOLDER_LIST_LOADING_MESSAGE } from './folderView.js';
import type { IconName } from './iconNames.js';
import type { ShortcutId } from './shortcuts.js';
import type { SquadStartVerdict } from './squadView.js';

/** The menu's entries, in the order they show. */
export type SendMenuEntryId = 'agent' | 'squad' | 'company';

/** What the composer knows that decides which entries can run. */
export interface SendMenuFacts {
  /** Why the draft cannot be sent at all, or null when it can. */
  readonly blocker: string | null;
  /** A send from this box is in flight. */
  readonly busy: boolean;
  /** A `/resume` picker is open in the box. */
  readonly resumeOpen: boolean;
  /** A squad request from this box has not been answered yet. */
  readonly squadPending: boolean;
  /** Whether the folder has a team to hand work to, and why not. */
  readonly squadTeam: SquadStartVerdict;
  /** A new session is waiting for the folder list. */
  readonly newSessionWaits: boolean;
  /** A herdr agent is the selected target, so the Company workflow cannot take the draft. */
  readonly herdrTarget: boolean;
  /** A folder is in focus, so work can be assigned to one of its agents. */
  readonly hasFocus: boolean;
  readonly folderLoading: boolean;
  /** The draft has text to hand on. */
  readonly hasText: boolean;
}

export interface SendMenuEntry {
  readonly id: SendMenuEntryId;
  readonly label: string;
  /** What the entry does, in one line. */
  readonly description: string;
  readonly icon: IconName;
  /** The keyboard shortcut that runs the same entry, or null when it has none. */
  readonly shortcut: ShortcutId | null;
  /** Why the entry cannot run now, or null when it can. */
  readonly disabledReason: string | null;
}

/** The Company entry's reason while a herdr agent is the target. */
export const HERDR_COMPANY_TOOLTIP = 'Không giao cho công ty khi đang gửi tới agent herdr.';

const NO_FOCUS_REASON = 'Chọn một thư mục trước.';
const EMPTY_TEXT_REASON = 'Nhập nội dung trước.';
const BUSY_REASON = 'Đang gửi, chờ xong đã.';
const RESUME_OPEN_REASON = 'Đóng danh sách phiên đã lưu trước.';
const SQUAD_PENDING_REASON = 'Đội đang nhận nội dung này.';

/** Why a send from this box has to wait, or null when nothing holds it. */
function waitReason(facts: SendMenuFacts): string | null {
  if (facts.busy) return BUSY_REASON;
  if (facts.resumeOpen) return RESUME_OPEN_REASON;
  return null;
}

function agentReason(facts: SendMenuFacts): string | null {
  if (!facts.hasFocus) return NO_FOCUS_REASON;
  if (facts.folderLoading) return FOLDER_LIST_LOADING_MESSAGE;
  if (!facts.hasText) return EMPTY_TEXT_REASON;
  return null;
}

function squadReason(facts: SendMenuFacts): string | null {
  if (!facts.squadTeam.ok) return facts.squadTeam.reason;
  return facts.blocker ?? waitReason(facts) ?? (facts.squadPending ? SQUAD_PENDING_REASON : null);
}

function companyReason(facts: SendMenuFacts): string | null {
  if (facts.herdrTarget) return HERDR_COMPANY_TOOLTIP;
  return (
    facts.blocker ??
    waitReason(facts) ??
    (facts.newSessionWaits ? FOLDER_LIST_LOADING_MESSAGE : null)
  );
}

/** The three entries with the reason each is off, or null when it can run. */
export function sendMenuEntries(facts: SendMenuFacts): readonly SendMenuEntry[] {
  return [
    {
      id: 'agent',
      label: 'Một agent…',
      description: 'Giao nội dung này thành một việc cho agent bạn chọn.',
      icon: 'send',
      shortcut: null,
      disabledReason: agentReason(facts),
    },
    {
      id: 'squad',
      label: 'Đội',
      description: 'Đội trưởng chia nội dung này cho các agent trong thư mục.',
      icon: 'users',
      shortcut: 'composer.squad',
      disabledReason: squadReason(facts),
    },
    {
      id: 'company',
      label: 'Công ty',
      description: 'Giám đốc lập kế hoạch, duyệt, rồi giao cho các agent làm.',
      icon: 'flag',
      shortcut: 'composer.company',
      disabledReason: companyReason(facts),
    },
  ];
}

/**
 * The index a menu key moves focus to among `count` enabled entries, or null when the key moves
 * nothing. `current` is -1 when focus is not on an entry.
 */
export function sendMenuStep(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowUp':
      return current <= 0 ? count - 1 : current - 1;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
