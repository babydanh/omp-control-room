import { describe, expect, it } from 'vitest';

import {
  HERDR_COMPANY_TOOLTIP,
  sendMenuEntries,
  type SendMenuEntryId,
  type SendMenuFacts,
  sendMenuStep,
} from '../src/company/composerSendMenu.js';
import { FOLDER_LIST_LOADING_MESSAGE } from '../src/company/folderView.js';
import { SHORTCUTS } from '../src/company/shortcuts.js';

/** Facts under which every entry can run. */
const READY: SendMenuFacts = {
  blocker: null,
  busy: false,
  resumeOpen: false,
  squadPending: false,
  squadTeam: { ok: true },
  newSessionWaits: false,
  herdrTarget: false,
  hasFocus: true,
  folderLoading: false,
  hasText: true,
};

/** The reason one entry is off under these facts, or null when it can run. */
function reasonOf(facts: SendMenuFacts, id: SendMenuEntryId): string | null {
  const entry = sendMenuEntries(facts).find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`no entry ${id}`);
  return entry.disabledReason;
}

describe('sendMenuEntries', () => {
  it('lists the agent, squad and company entries in that order', () => {
    expect(sendMenuEntries(READY).map((entry) => entry.id)).toEqual(['agent', 'squad', 'company']);
  });

  it('gives the squad and company entries the shortcuts that run them, and the agent none', () => {
    const [agent, squad, company] = sendMenuEntries(READY);
    expect(agent?.shortcut).toBeNull();
    expect(squad?.shortcut).toBe('composer.squad');
    expect(company?.shortcut).toBe('composer.company');
    for (const shortcut of [squad?.shortcut, company?.shortcut]) {
      expect(SHORTCUTS.some((def) => def.id === shortcut)).toBe(true);
    }
  });

  it('turns every entry on when the draft can go anywhere', () => {
    expect(sendMenuEntries(READY).map((entry) => entry.disabledReason)).toEqual([null, null, null]);
  });

  it('keeps the agent entry off with no folder in focus, while the folder list loads, or with no text', () => {
    expect(reasonOf({ ...READY, hasFocus: false }, 'agent')).toBe('Chọn một thư mục trước.');
    expect(reasonOf({ ...READY, folderLoading: true }, 'agent')).toBe(FOLDER_LIST_LOADING_MESSAGE);
    expect(reasonOf({ ...READY, hasText: false }, 'agent')).toBe('Nhập nội dung trước.');
  });

  it('shows the folder reason on the squad entry when the folder has no team', () => {
    const squadTeam = {
      ok: false,
      reason: 'Thư mục này chưa có agent hay phiên omp nào.',
    } as const;
    expect(reasonOf({ ...READY, squadTeam }, 'squad')).toBe(squadTeam.reason);
    expect(reasonOf({ ...READY, squadTeam }, 'company')).toBeNull();
  });

  it('turns the squad and company entries off while the box waits on a send, a picker or a blocker', () => {
    const busy = 'Đang gửi, chờ xong đã.';
    const picker = 'Đóng danh sách phiên đã lưu trước.';
    expect(reasonOf({ ...READY, busy: true }, 'squad')).toBe(busy);
    expect(reasonOf({ ...READY, busy: true }, 'company')).toBe(busy);
    expect(reasonOf({ ...READY, resumeOpen: true }, 'squad')).toBe(picker);
    expect(reasonOf({ ...READY, resumeOpen: true }, 'company')).toBe(picker);
    expect(reasonOf({ ...READY, blocker: 'Hãy nhập điều bạn muốn gửi.' }, 'squad')).toBe(
      'Hãy nhập điều bạn muốn gửi.',
    );
  });

  it('keeps the squad entry off while its own request is pending', () => {
    expect(reasonOf({ ...READY, squadPending: true }, 'squad')).toBe('Đội đang nhận nội dung này.');
    expect(reasonOf({ ...READY, squadPending: true }, 'company')).toBeNull();
  });

  it('turns the company entry off for a herdr target, and keeps the squad entry on', () => {
    expect(reasonOf({ ...READY, herdrTarget: true }, 'company')).toBe(HERDR_COMPANY_TOOLTIP);
    expect(reasonOf({ ...READY, herdrTarget: true }, 'squad')).toBeNull();
  });

  it('turns the company entry off while a new session waits for the folder list', () => {
    expect(reasonOf({ ...READY, newSessionWaits: true }, 'company')).toBe(
      FOLDER_LIST_LOADING_MESSAGE,
    );
  });

  it('keeps the description of an off entry, so its reason can sit on a line of its own', () => {
    const onEntry = sendMenuEntries(READY).find((entry) => entry.id === 'squad');
    const offEntry = sendMenuEntries({ ...READY, busy: true }).find(
      (entry) => entry.id === 'squad',
    );
    expect(offEntry?.description).toBeTruthy();
    expect(offEntry?.description).toBe(onEntry?.description);
  });
});

describe('sendMenuStep', () => {
  it('moves down and wraps from the last entry to the first', () => {
    expect(sendMenuStep('ArrowDown', 0, 3)).toBe(1);
    expect(sendMenuStep('ArrowDown', 2, 3)).toBe(0);
    expect(sendMenuStep('ArrowDown', -1, 3)).toBe(0);
  });

  it('moves up and wraps from the first entry to the last', () => {
    expect(sendMenuStep('ArrowUp', 2, 3)).toBe(1);
    expect(sendMenuStep('ArrowUp', 0, 3)).toBe(2);
    expect(sendMenuStep('ArrowUp', -1, 3)).toBe(2);
  });

  it('jumps to the first and last entries with Home and End', () => {
    expect(sendMenuStep('Home', 2, 3)).toBe(0);
    expect(sendMenuStep('End', 0, 3)).toBe(2);
  });

  it('moves nothing for other keys, or when no entry can take focus', () => {
    expect(sendMenuStep('Enter', 0, 3)).toBeNull();
    expect(sendMenuStep('a', 0, 3)).toBeNull();
    expect(sendMenuStep('ArrowDown', -1, 0)).toBeNull();
  });
});
