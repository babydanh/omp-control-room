import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isReplayableClientMessage } from '../../core/src/messageDelivery.js';
import {
  type AgentMenuSubject,
  agentMenuTriggers,
  herdrMenuItems,
  herdrNameProblem,
  MENU_MARGIN_PX,
  type MenuTarget,
  placeMenu,
  sessionMenuItems,
  sessionNameProblem,
} from '../src/company/agentMenu.js';
import { copyText } from '../src/company/clipboard.js';
import {
  herdrInfoRequest,
  herdrRename,
  isCompanyServerMessage,
  sessionInfoRequest,
  sessionRename,
} from '../src/company/companyMessages.js';
import { HOLDS_WORK_REASON } from '../src/company/sessionActions.js';

const NO_SESSION_REASON = 'Chưa có phiên nào để thao tác.';
const FOLDER_UNKNOWN_REASON = 'Chưa rõ thư mục làm việc.';

describe('sessionMenuItems', () => {
  it('lists the session actions, then the controls its status allows', () => {
    const items = sessionMenuItems({ status: 'busy', cwd: '/work', holdsWork: false });

    expect(items.map((item) => item.label)).toEqual([
      'Xem thông tin',
      'Đổi tên…',
      'Sao chép thư mục làm việc',
      'Sao chép mã phiên',
      'Mở Log',
      'Mở Lệnh',
      'Mở Terminal',
      'Dừng lượt',
      'Tạm dừng',
      'Tắt phiên',
      'Xoá phiên…',
    ]);
    expect(items.every((item) => !item.disabled)).toBe(true);
  });

  it('offers resume and restart for a parked session; delete is listed for every status', () => {
    const parked = sessionMenuItems({ status: 'parked', cwd: '/work', holdsWork: false });
    const parkedControls = parked.filter((item) => item.action.kind === 'control');
    expect(parkedControls.map((item) => item.label)).toEqual([
      'Tiếp tục',
      'Khởi động lại',
      'Xoá phiên…',
    ]);

    const archived = sessionMenuItems({ status: 'archived', cwd: '/work', holdsWork: false });
    const archivedControls = archived.filter((item) => item.action.kind === 'control');
    expect(archivedControls.map((item) => item.label)).toEqual(['Xoá phiên…']);
  });

  it('marks the kill and delete controls as dangerous and maps each to its action', () => {
    const items = sessionMenuItems({ status: 'busy', cwd: '/work', holdsWork: false });

    expect(items.find((item) => item.label === 'Dừng lượt')).toMatchObject({
      danger: false,
      action: { kind: 'control', action: 'interrupt' },
    });
    expect(items.find((item) => item.label === 'Tắt phiên')).toMatchObject({
      danger: true,
      action: { kind: 'control', action: 'kill' },
    });
    expect(items.find((item) => item.label === 'Xoá phiên…')).toMatchObject({
      danger: true,
      action: { kind: 'control', action: 'delete' },
    });
    expect(items.filter((item) => item.danger).map((item) => item.label)).toEqual([
      'Tắt phiên',
      'Xoá phiên…',
    ]);
  });

  it('starts a group at the log tabs and at the first control', () => {
    const items = sessionMenuItems({ status: 'busy', cwd: '/work', holdsWork: false });
    const starts = items.filter((item) => item.startsGroup).map((item) => item.label);

    expect(starts).toEqual(['Mở Log', 'Dừng lượt']);
  });

  it('offers interrupt only while a turn runs', () => {
    const idle = sessionMenuItems({ status: 'idle', cwd: '/work', holdsWork: false });
    expect(idle.some((item) => item.label === 'Dừng lượt')).toBe(false);

    const busy = sessionMenuItems({ status: 'busy', cwd: '/work', holdsWork: false });
    expect(busy.some((item) => item.label === 'Dừng lượt')).toBe(true);
  });

  it('disables delete with the reason while the session holds work', () => {
    const items = sessionMenuItems({ status: 'busy', cwd: '/work', holdsWork: true });

    expect(items.find((item) => item.id === 'control-delete')).toMatchObject({
      disabled: true,
      reason: HOLDS_WORK_REASON,
    });
  });

  it('enables delete for a session that holds no work', () => {
    const items = sessionMenuItems({ status: 'parked', cwd: '/work', holdsWork: false });

    expect(items.find((item) => item.id === 'control-delete')).toMatchObject({ disabled: false });
  });

  it('shows every item disabled when the subject holds no session', () => {
    const items = sessionMenuItems(null);

    expect(items.every((item) => item.disabled)).toBe(true);
    expect(items.every((item) => item.reason === NO_SESSION_REASON)).toBe(true);
    expect(items.map((item) => item.label)).toContain('Lưu trữ');
    expect(items.map((item) => item.label)).toContain('Xoá phiên…');
  });

  it('disables only the folder copy when the folder is not known', () => {
    const items = sessionMenuItems({ status: 'busy', cwd: null, holdsWork: false });

    expect(items.find((item) => item.id === 'copy-cwd')).toMatchObject({
      disabled: true,
      reason: FOLDER_UNKNOWN_REASON,
    });
    expect(items.find((item) => item.id === 'copy-code')).toMatchObject({ disabled: false });
  });
});

describe('herdrMenuItems', () => {
  it('lists the herdr actions in order', () => {
    expect(herdrMenuItems('/repo').map((item) => item.label)).toEqual([
      'Xem thông tin',
      'Đổi tên…',
      'Xem màn hình',
      'Mở trong herdr',
      'Sao chép thư mục',
      'Sao chép pane id',
    ]);
  });

  it('maps the info and screen items to the drawer tabs', () => {
    const items = herdrMenuItems('/repo');

    expect(items.find((item) => item.id === 'info')?.action).toEqual({
      kind: 'herdrTab',
      tab: 'info',
    });
    expect(items.find((item) => item.id === 'screen')?.action).toEqual({
      kind: 'herdrTab',
      tab: 'screen',
    });
  });

  it('disables the folder copy when herdr reports no folder', () => {
    expect(herdrMenuItems(null).find((item) => item.id === 'copy-cwd')).toMatchObject({
      disabled: true,
      reason: FOLDER_UNKNOWN_REASON,
    });
  });
});

describe('herdrNameProblem', () => {
  it.each(['a', 'claude-1', 'pane_2', 'a'.repeat(32), '  spaced  '])('accepts %j', (name) => {
    expect(herdrNameProblem(name)).toBeNull();
  });

  it.each(['', '   ', '1pane', 'Pane', 'has space', 'dot.name', 'a'.repeat(33)])(
    'refuses %j with a reason',
    (name) => {
      expect(herdrNameProblem(name)).not.toBeNull();
    },
  );

  it('explains a blank name and a malformed one differently', () => {
    expect(herdrNameProblem('')).toBe('Tên không được để trống.');
    expect(herdrNameProblem('Pane')).toMatch(/^Tên không hợp lệ\. /);
  });
});

describe('sessionNameProblem', () => {
  it('refuses a blank name and one over 60 characters', () => {
    expect(sessionNameProblem('   ')).toBe('Tên không được để trống.');
    expect(sessionNameProblem('x'.repeat(61))).toBe('Tên tối đa 60 ký tự.');
  });

  it('accepts a name up to 60 characters, trimmed first', () => {
    expect(sessionNameProblem('x'.repeat(60))).toBeNull();
    expect(sessionNameProblem('  Đội 1  ')).toBeNull();
  });
});

describe('placeMenu', () => {
  const size = { width: 240, height: 300 };
  const viewport = { width: 1000, height: 800 };

  it('opens at the pointer when the menu fits', () => {
    expect(placeMenu({ x: 100, y: 120 }, size, viewport)).toEqual({ x: 100, y: 120 });
  });

  it('pulls the menu back inside the right and bottom edges', () => {
    expect(placeMenu({ x: 990, y: 790 }, size, viewport)).toEqual({
      x: 1000 - 240 - MENU_MARGIN_PX,
      y: 800 - 300 - MENU_MARGIN_PX,
    });
  });

  it('keeps the menu off the left and top edges', () => {
    expect(placeMenu({ x: -20, y: -5 }, size, viewport)).toEqual({
      x: MENU_MARGIN_PX,
      y: MENU_MARGIN_PX,
    });
  });

  it('keeps the margin even when the viewport is smaller than the menu', () => {
    expect(placeMenu({ x: 50, y: 50 }, size, { width: 100, height: 100 })).toEqual({
      x: MENU_MARGIN_PX,
      y: MENU_MARGIN_PX,
    });
  });
});

describe('agentMenuTriggers', () => {
  const subject: AgentMenuSubject = { kind: 'herdr', paneId: 'p1' };

  it('opens at the pointer on a right click and cancels the native menu', () => {
    const open = vi.fn();
    const preventDefault = vi.fn();
    const element = {
      getBoundingClientRect: () => ({ left: 0, bottom: 0 }),
    } as unknown as MenuTarget;
    const event = {
      preventDefault,
      clientX: 40,
      clientY: 60,
      currentTarget: element,
    } as unknown as ReactMouseEvent<MenuTarget>;

    agentMenuTriggers<MenuTarget>(subject, open).onContextMenu(event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith({
      subject,
      anchor: { x: 40, y: 60 },
      returnFocus: element,
    });
  });

  it('opens below the element for the context-menu key and for Shift+F10', () => {
    const open = vi.fn();
    const element = {
      getBoundingClientRect: () => ({ left: 100, bottom: 200 }),
    } as unknown as MenuTarget;
    const triggers = agentMenuTriggers<MenuTarget>(subject, open);

    for (const key of [
      { key: 'ContextMenu', shiftKey: false },
      { key: 'F10', shiftKey: true },
    ]) {
      const event = {
        ...key,
        preventDefault: vi.fn(),
        currentTarget: element,
      } as unknown as ReactKeyboardEvent<MenuTarget>;
      triggers.onKeyDown(event);
    }

    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenLastCalledWith({
      subject,
      anchor: { x: 112, y: 200 },
      returnFocus: element,
    });
  });

  it('ignores a bare F10 and every other key', () => {
    const open = vi.fn();
    const triggers = agentMenuTriggers<MenuTarget>(subject, open);
    const element = {
      getBoundingClientRect: () => ({ left: 0, bottom: 0 }),
    } as unknown as MenuTarget;

    for (const key of ['F10', 'Enter', 'Escape']) {
      const event = {
        key,
        shiftKey: false,
        preventDefault: vi.fn(),
        currentTarget: element,
      } as unknown as ReactKeyboardEvent<MenuTarget>;
      triggers.onKeyDown(event);
    }

    expect(open).not.toHaveBeenCalled();
  });
});

describe('copyText', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes the text and reports success', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await expect(copyText('C:/repo')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('C:/repo');
  });

  it('reports a refused write as a failure instead of throwing', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: () => Promise.reject(new Error('denied')) },
    });

    await expect(copyText('C:/repo')).resolves.toBe(false);
  });

  it('reports a missing clipboard as a failure', async () => {
    vi.stubGlobal('navigator', {});

    await expect(copyText('C:/repo')).resolves.toBe(false);
  });
});

describe('company request builders and replay rules', () => {
  it('builds the rename and info requests the server expects', () => {
    expect(sessionRename('r1', 's1', 'Đội A')).toEqual({
      type: 'companySessionRename',
      requestId: 'r1',
      sessionId: 's1',
      name: 'Đội A',
    });
    expect(sessionInfoRequest('r2', 's1')).toEqual({
      type: 'companySessionInfoRequest',
      requestId: 'r2',
      sessionId: 's1',
    });
    expect(herdrRename('r3', 'p1', 'builder')).toEqual({
      type: 'herdrRename',
      requestId: 'r3',
      paneId: 'p1',
      name: 'builder',
    });
    expect(herdrInfoRequest('r4', 'p1')).toEqual({
      type: 'herdrInfoRequest',
      requestId: 'r4',
      paneId: 'p1',
    });
  });

  it('accepts the info replies from the server', () => {
    expect(isCompanyServerMessage({ type: 'companySessionInfo' })).toBe(true);
    expect(isCompanyServerMessage({ type: 'herdrInfo' })).toBe(true);
  });

  it('replays the read-only info requests on reconnect, never a rename', () => {
    expect(isReplayableClientMessage({ type: 'companySessionInfoRequest' })).toBe(true);
    expect(isReplayableClientMessage({ type: 'herdrInfoRequest' })).toBe(true);
    expect(isReplayableClientMessage({ type: 'companySessionRename' })).toBe(false);
    expect(isReplayableClientMessage({ type: 'herdrRename' })).toBe(false);
  });
});
