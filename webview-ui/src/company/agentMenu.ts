/**
 * agentMenu: what the right-click menu on an agent offers, as pure data.
 *
 * One menu serves every surface that shows an agent: sidebar rows, rail badges,
 * task cards, and herdr rows. This file decides which items appear and which are
 * enabled; the component draws them and runs the chosen action. It also holds the
 * name rules a rename is checked against before it is sent, the placement that keeps
 * the menu inside the viewport, and the trigger that opens it from the mouse or the
 * keyboard.
 */

import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';

import type { HerdrDrawerTab } from './herdrView.js';
import { HOLDS_WORK_REASON, sessionControls, type SessionControlSet } from './sessionActions.js';

/** What a menu was opened on. A session subject with no session is a task card nobody runs. */
export type AgentMenuSubject =
  { kind: 'session'; sessionId: string | null } | { kind: 'herdr'; paneId: string };

/** The drawer tabs a session's menu can open. */
export type SessionMenuTab = 'info' | 'log' | 'commands' | 'terminal';

export type SessionControlAction =
  'interrupt' | 'pause' | 'resume' | 'restart' | 'kill' | 'archive' | 'delete';

export type AgentMenuAction =
  | { kind: 'sessionTab'; tab: SessionMenuTab }
  | { kind: 'rename' }
  | { kind: 'copy'; what: 'cwd' | 'sessionCode' | 'paneId' }
  | { kind: 'control'; action: SessionControlAction }
  | { kind: 'herdrTab'; tab: HerdrDrawerTab }
  | { kind: 'focus' };

export interface AgentMenuItem {
  /** Stable within one menu: a React key, and how tests find an item. */
  id: string;
  label: string;
  action: AgentMenuAction;
  /** Shown dimmed and never run. */
  disabled: boolean;
  /** Why the item is disabled, in a few words; null when it is enabled. */
  reason: string | null;
  /** Drawn in the warning tone: a control that stops work. */
  danger: boolean;
  /** Drawn after a rule: the groups are identity, opening, then controls. */
  startsGroup: boolean;
}

/** What a session's menu needs to know: its wire status, and the folder it works in if known. */
export interface SessionMenuFacts {
  status: string;
  cwd: string | null;
  /** Whether the session holds work; delete is refused for it, so its item is disabled. */
  holdsWork: boolean;
}

const NO_SESSION_REASON = 'Chưa có phiên nào để thao tác.';
const FOLDER_UNKNOWN_REASON = 'Chưa rõ thư mục làm việc.';

const CONTROL_ITEMS: ReadonlyArray<{
  flag: keyof SessionControlSet;
  action: SessionControlAction;
  label: string;
  danger: boolean;
}> = [
  { flag: 'interrupt', action: 'interrupt', label: 'Dừng lượt', danger: false },
  { flag: 'pause', action: 'pause', label: 'Tạm dừng', danger: false },
  { flag: 'resume', action: 'resume', label: 'Tiếp tục', danger: false },
  { flag: 'restart', action: 'restart', label: 'Khởi động lại', danger: false },
  { flag: 'kill', action: 'kill', label: 'Tắt phiên', danger: true },
  { flag: 'archive', action: 'archive', label: 'Lưu trữ', danger: false },
];

interface MenuItemSpec {
  id: string;
  label: string;
  action: AgentMenuAction;
  /** Null when the item is enabled; otherwise why it is not. */
  blockedBy: string | null;
  danger?: boolean;
  startsGroup?: boolean;
}

function menuItem(spec: MenuItemSpec): AgentMenuItem {
  return {
    id: spec.id,
    label: spec.label,
    action: spec.action,
    disabled: spec.blockedBy !== null,
    reason: spec.blockedBy,
    danger: spec.danger ?? false,
    startsGroup: spec.startsGroup ?? false,
  };
}

/**
 * The items for a session. `session` is null when the subject holds no session at
 * all: every item is still listed but disabled, so the user sees what the menu does.
 * Controls follow the session's status through `sessionControls`.
 */
export function sessionMenuItems(session: SessionMenuFacts | null): AgentMenuItem[] {
  const blocked = session === null ? NO_SESSION_REASON : null;
  const folderBlocked = blocked ?? (session?.cwd ? null : FOLDER_UNKNOWN_REASON);
  const deleteBlocked = blocked ?? (session?.holdsWork ? HOLDS_WORK_REASON : null);
  const controls: SessionControlSet | null =
    session === null ? null : sessionControls(session.status);
  const controlItems = CONTROL_ITEMS.filter(
    (control) => controls === null || controls[control.flag],
  );
  return [
    menuItem({
      id: 'info',
      label: 'Xem thông tin',
      action: { kind: 'sessionTab', tab: 'info' },
      blockedBy: blocked,
    }),
    menuItem({ id: 'rename', label: 'Đổi tên…', action: { kind: 'rename' }, blockedBy: blocked }),
    menuItem({
      id: 'copy-cwd',
      label: 'Sao chép thư mục làm việc',
      action: { kind: 'copy', what: 'cwd' },
      blockedBy: folderBlocked,
    }),
    menuItem({
      id: 'copy-code',
      label: 'Sao chép mã phiên',
      action: { kind: 'copy', what: 'sessionCode' },
      blockedBy: blocked,
    }),
    menuItem({
      id: 'tab-log',
      label: 'Mở Log',
      action: { kind: 'sessionTab', tab: 'log' },
      blockedBy: blocked,
      startsGroup: true,
    }),
    menuItem({
      id: 'tab-commands',
      label: 'Mở Lệnh',
      action: { kind: 'sessionTab', tab: 'commands' },
      blockedBy: blocked,
    }),
    menuItem({
      id: 'tab-terminal',
      label: 'Mở Terminal',
      action: { kind: 'sessionTab', tab: 'terminal' },
      blockedBy: blocked,
    }),
    ...controlItems.map((control, index) =>
      menuItem({
        id: `control-${control.action}`,
        label: control.label,
        action: { kind: 'control', action: control.action },
        blockedBy: blocked,
        danger: control.danger,
        startsGroup: index === 0,
      }),
    ),
    menuItem({
      id: 'control-delete',
      label: 'Xoá phiên…',
      action: { kind: 'control', action: 'delete' },
      blockedBy: deleteBlocked,
      danger: true,
      startsGroup: controlItems.length === 0,
    }),
  ];
}

/** The items for a herdr agent. `folder` is the pane's working folder, null when unknown. */
export function herdrMenuItems(folder: string | null): AgentMenuItem[] {
  return [
    menuItem({
      id: 'info',
      label: 'Xem thông tin',
      action: { kind: 'herdrTab', tab: 'info' },
      blockedBy: null,
    }),
    menuItem({ id: 'rename', label: 'Đổi tên…', action: { kind: 'rename' }, blockedBy: null }),
    menuItem({
      id: 'screen',
      label: 'Xem màn hình',
      action: { kind: 'herdrTab', tab: 'screen' },
      blockedBy: null,
      startsGroup: true,
    }),
    menuItem({ id: 'focus', label: 'Mở trong herdr', action: { kind: 'focus' }, blockedBy: null }),
    menuItem({
      id: 'copy-cwd',
      label: 'Sao chép thư mục',
      action: { kind: 'copy', what: 'cwd' },
      blockedBy: folder ? null : FOLDER_UNKNOWN_REASON,
      startsGroup: true,
    }),
    menuItem({
      id: 'copy-pane',
      label: 'Sao chép pane id',
      action: { kind: 'copy', what: 'paneId' },
      blockedBy: null,
    }),
  ];
}

/** The pane-name rule herdr enforces. The same text is the hint and the refusal. */
export const HERDR_NAME_RULE =
  'Gồm chữ thường a–z, số, "_" hoặc "-"; bắt đầu bằng chữ; tối đa 32 ký tự.';

const HERDR_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** Why a herdr pane name cannot be sent, or null when it can. The name is trimmed first. */
export function herdrNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'Tên không được để trống.';
  if (!HERDR_NAME_PATTERN.test(trimmed)) return `Tên không hợp lệ. ${HERDR_NAME_RULE}`;
  return null;
}

export const SESSION_NAME_MAX_LENGTH = 60;

/** Why a session name cannot be sent, or null when it can. The name is trimmed first. */
export function sessionNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'Tên không được để trống.';
  if (trimmed.length > SESSION_NAME_MAX_LENGTH) {
    return `Tên tối đa ${SESSION_NAME_MAX_LENGTH} ký tự.`;
  }
  return null;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Gap kept between the menu and the viewport edge. */
export const MENU_MARGIN_PX = 8;

/** Where a menu of `size`, opened at `anchor`, goes so it stays inside the viewport. */
export function placeMenu(anchor: Point, size: Size, viewport: Size): Point {
  const maxX = viewport.width - size.width - MENU_MARGIN_PX;
  const maxY = viewport.height - size.height - MENU_MARGIN_PX;
  return {
    x: Math.max(MENU_MARGIN_PX, Math.min(anchor.x, maxX)),
    y: Math.max(MENU_MARGIN_PX, Math.min(anchor.y, maxY)),
  };
}

/** The part of an element the menu uses: where it sits, and how focus returns to it. */
export interface MenuTarget {
  getBoundingClientRect(): { left: number; bottom: number };
  focus(options?: { preventScroll?: boolean }): void;
}

/** A request to open the menu, as the surface that was used makes it. */
export interface AgentMenuRequest {
  subject: AgentMenuSubject;
  /** Where the menu opens, in viewport pixels. */
  anchor: Point;
  /** What had focus before the menu opened; Esc returns focus to it. */
  returnFocus: MenuTarget | null;
}

/** The handlers that open the menu on one element. */
export interface AgentMenuTriggers<T extends MenuTarget> {
  onContextMenu: (event: ReactMouseEvent<T>) => void;
  onKeyDown: (event: ReactKeyboardEvent<T>) => void;
}

/** Gap from the element's left edge where a keyboard-opened menu appears. */
const KEY_ANCHOR_INSET_PX = 12;

/**
 * Handlers that open the agent menu for `subject`: the right mouse button, the
 * context-menu key, and Shift+F10. A keyboard request anchors below the element, so
 * it works without a pointer.
 */
export function agentMenuTriggers<T extends MenuTarget>(
  subject: AgentMenuSubject,
  open: (request: AgentMenuRequest) => void,
): AgentMenuTriggers<T> {
  return {
    onContextMenu(event) {
      event.preventDefault();
      open({
        subject,
        anchor: { x: event.clientX, y: event.clientY },
        returnFocus: event.currentTarget,
      });
    },
    onKeyDown(event) {
      const opensMenu = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
      if (!opensMenu) return;
      event.preventDefault();
      const element: MenuTarget = event.currentTarget;
      const rect = element.getBoundingClientRect();
      open({
        subject,
        anchor: { x: rect.left + KEY_ANCHOR_INSET_PX, y: rect.bottom },
        returnFocus: event.currentTarget,
      });
    },
  };
}
