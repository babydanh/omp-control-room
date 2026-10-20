/**
 * agentMenu: what the right-click menu offers, as pure data.
 *
 * One menu serves every surface that shows work: a session row, a rail badge, a
 * task card, a planning card, a herdr agent, a project header, and the drawer
 * headers that show any of them. Items come from the subject alone: a task card
 * with no session offers task items only, and a pane with no folder offers no
 * folder copy. Nothing is listed disabled to explain an absence. The only
 * disabled item is a delete the server refuses while a session holds work, and
 * it says why.
 *
 * This file decides which items appear and in what order; the component draws
 * them and runs the chosen action. It also holds the name rules a rename is
 * checked against before it is sent, the placement that keeps the menu inside
 * the viewport, and the trigger that opens it from the mouse or the keyboard.
 */

import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';

import { sessionAcceptsWork } from './assigneeOptions.js';
import type { CompanyDrawerTab } from './companyState.js';
import type { HerdrDrawerTab } from './herdrView.js';
import type { IconName } from './iconNames.js';
import { HOLDS_WORK_REASON, sessionControls, type SessionControlSet } from './sessionActions.js';

/** A drawer header that opened the menu: whether the drawer is currently maximized. */
export interface DrawerView {
  maximized: boolean;
}

/** What a project header's menu needs to know, captured when it opens. */
export interface ProjectMenuFacts {
  key: string;
  name: string;
  path: string | null;
  collapsed: boolean;
  /** The folder the board switches to: set for a board folder that is not active. */
  switchTo: string | null;
  /** Errored sessions the cleanup may delete now; empty when there are none. */
  cleanable: string[];
}

/** What a menu was opened on. */
export type AgentMenuSubject =
  | { kind: 'session'; sessionId: string; drawer: DrawerView | null }
  | { kind: 'task'; taskId: string; sessionId: string | null; drawer: DrawerView | null }
  | { kind: 'workItem'; id: string; workspacePath: string }
  | { kind: 'planning'; promptId: string; sessionId: string | null }
  | { kind: 'squad'; runId: string; workspacePath: string }
  | { kind: 'herdr'; paneId: string; drawer: DrawerView | null }
  | { kind: 'sleeping'; paneId: string; drawer: DrawerView | null }
  | { kind: 'project'; project: ProjectMenuFacts };

export type SessionControlAction =
  'interrupt' | 'pause' | 'resume' | 'restart' | 'kill' | 'archive' | 'delete';

export type CopyWhat =
  | 'cwd'
  | 'sessionCode'
  | 'paneId'
  | 'taskCode'
  | 'workItemCode'
  | 'workItemText'
  | 'squadRunCode'
  | 'squadRequest'
  | 'path'
  | 'screen';

export type AgentMenuAction =
  | { kind: 'sessionTab'; tab: CompanyDrawerTab }
  | { kind: 'herdrTab'; tab: HerdrDrawerTab }
  | { kind: 'rename' }
  | { kind: 'copy'; what: CopyWhat }
  | { kind: 'control'; action: SessionControlAction }
  | { kind: 'focus' }
  | { kind: 'readScreen' }
  | { kind: 'maximize' }
  | { kind: 'openTask' }
  | { kind: 'openContract'; contractId: string }
  | { kind: 'openSession' }
  | { kind: 'cancelPrompt' }
  | { kind: 'toggleProject' }
  | { kind: 'openBoardFolder' }
  | { kind: 'renameFolder' }
  | { kind: 'cleanErrored' }
  | { kind: 'assignWork' }
  | { kind: 'describeRole' }
  | { kind: 'workItemAction'; action: WorkItemMenuAction }
  | { kind: 'squadAction'; action: SquadRunMenuAction }
  | { kind: 'wake' }
  | { kind: 'projectNodeAction'; action: 'project' | 'group' | 'folder' | 'repository' | 'worktree' };

export interface AgentMenuItem {
  /** Stable within one menu: a React key, and how tests find an item. */
  id: string;
  label: string;
  /** The glyph drawn before the label, from the board's icon set. */
  icon: IconName;
  action: AgentMenuAction;
  /** Shown dimmed and never run. Only a refused delete is ever disabled. */
  disabled: boolean;
  /** A few words on the right of the row, such as a refusal's cause; null when there is none. */
  hint: string | null;
  /** The full explanation, for the row's tooltip; null when the label says it all. */
  title: string | null;
  /** Drawn in the danger tone, and kept at the bottom of its menu. */
  danger: boolean;
  /** Drawn after a separator: items group as identity, views, controls, then danger. */
  startsGroup: boolean;
}

/**
 * What the work items menu needs to know about an agent: the folder it is tagged with, and
 * whether this connection may act at all.
 */
export interface WorkMenuFacts {
  /** The folder the agent is tagged with; null when it has none, so no work can go to it. */
  folder: string | null;
  /** False on a read-only connection, which offers no item that changes the board. */
  privileged: boolean;
}

/** What a session's menu needs to know. */
export interface SessionMenuFacts {
  status: string;
  /** The folder the session works in, when known. */
  cwd: string | null;
  /** Whether the session holds work; delete is refused for it. */
  holdsWork: boolean;
  /** What the work items menu needs; a session in a status that takes no work offers none. */
  work: WorkMenuFacts;
}

export interface TaskMenuFacts {
  code: string;
  /** The task's Contract when the board holds it; null when it does not. */
  contractId: string | null;
}

export type WorkItemMenuAction =
  | 'open'
  | 'assign'
  | 'followUp'
  | 'done'
  | 'failed'
  | 'cancel'
  | 'judge'
  | 'cleanWorktree'
  | 'askLeader';

export interface WorkItemMenuFacts {
  id: string;
  sequence: number;
  text: string;
  status: 'queued' | 'running' | 'needs_input' | 'review' | 'done' | 'failed';
  privileged: boolean;
  canJudge: boolean;
  canCleanWorktree: boolean;
  canAskLeader: boolean;
}
export type SquadRunMenuAction = 'open' | 'approve' | 'dismiss' | 'retry' | 'cancel' | 'remove';

export interface SquadRunMenuFacts {
  runId: string;
  request: string;
  status: 'planning' | 'proposed' | 'working' | 'done' | 'dismissed' | 'failed' | 'stopped';
  hasProposal: boolean;
  privileged: boolean;
}

/** Short hint shown beside a refused delete. The full reason is the row's tooltip. */
const HOLDS_WORK_HINT = 'đang giữ việc';

/** The session controls, in menu order. Kill and delete are danger items and sit last. */
const CONTROL_ITEMS: ReadonlyArray<{
  flag: keyof SessionControlSet;
  action: SessionControlAction;
  label: string;
  icon: IconName;
}> = [
  { flag: 'interrupt', action: 'interrupt', label: 'Dừng lượt', icon: 'stop' },
  { flag: 'pause', action: 'pause', label: 'Tạm dừng', icon: 'pause' },
  { flag: 'resume', action: 'resume', label: 'Tiếp tục', icon: 'play' },
  { flag: 'restart', action: 'restart', label: 'Khởi động lại', icon: 'refresh' },
  { flag: 'archive', action: 'archive', label: 'Lưu trữ', icon: 'archive' },
];

interface ItemSpec {
  id: string;
  label: string;
  icon: IconName;
  action: AgentMenuAction;
  danger?: boolean;
  startsGroup?: boolean;
  disabled?: boolean;
  hint?: string | null;
  title?: string | null;
}

function item(spec: ItemSpec): AgentMenuItem {
  return {
    id: spec.id,
    label: spec.label,
    icon: spec.icon,
    action: spec.action,
    disabled: spec.disabled ?? false,
    hint: spec.hint ?? null,
    title: spec.title ?? null,
    danger: spec.danger ?? false,
    startsGroup: spec.startsGroup ?? false,
  };
}

/** The same items, with the first one opening a new group. */
function withGroupStart(items: readonly AgentMenuItem[]): AgentMenuItem[] {
  return items.map((entry, index) => (index === 0 ? { ...entry, startsGroup: true } : entry));
}

/** The maximize item for a menu opened from a drawer header; none otherwise. */
function maximizeItems(drawer: DrawerView | null): AgentMenuItem[] {
  if (drawer === null) return [];
  return [
    item({
      id: 'maximize',
      label: drawer.maximized ? 'Thu nhỏ' : 'Phóng to',
      icon: drawer.maximized ? 'minimize' : 'maximize',
      action: { kind: 'maximize' },
    }),
  ];
}

/**
 * The items that give work to an agent. None is offered when the agent has no folder to queue
 * the work in, or the connection is read-only: the server would refuse the command.
 */
function workItemMenuItems(work: WorkMenuFacts | null): AgentMenuItem[] {
  if (work === null || work.folder === null || !work.privileged) return [];
  return [
    item({
      id: 'assign-work',
      label: 'Giao việc cho agent này…',
      icon: 'send',
      action: { kind: 'assignWork' },
    }),
    item({
      id: 'describe-role',
      label: 'Mô tả vai trò…',
      icon: 'file-text',
      action: { kind: 'describeRole' },
    }),
  ];
}

/**
 * The session items: identity, the drawer tabs, the work items its folder takes, the controls
 * its status allows, then the two danger items. A control the status does not allow is not listed.
 */
export function sessionMenuItems(
  session: SessionMenuFacts,
  drawer: DrawerView | null,
): AgentMenuItem[] {
  const controls = sessionControls(session.status);
  const work = sessionAcceptsWork(session.status) ? session.work : null;
  const allowedControls = CONTROL_ITEMS.filter((control) => controls[control.flag]).map((control) =>
    item({
      id: `control-${control.action}`,
      label: control.label,
      icon: control.icon,
      action: { kind: 'control', action: control.action },
    }),
  );
  const killItems = controls.kill
    ? [
        item({
          id: 'control-kill',
          label: 'Tắt phiên',
          icon: 'power',
          action: { kind: 'control', action: 'kill' },
          danger: true,
        }),
      ]
    : [];
  const deleteItem = item({
    id: 'control-delete',
    label: 'Xoá phiên…',
    icon: 'trash',
    action: { kind: 'control', action: 'delete' },
    danger: true,
    disabled: session.holdsWork,
    hint: session.holdsWork ? HOLDS_WORK_HINT : null,
    title: session.holdsWork ? HOLDS_WORK_REASON : null,
  });
  return [
    item({ id: 'rename', label: 'Đổi tên…', icon: 'pencil', action: { kind: 'rename' } }),
    item({
      id: 'copy-code',
      label: 'Sao chép mã phiên',
      icon: 'copy',
      action: { kind: 'copy', what: 'sessionCode' },
    }),
    ...(session.cwd === null
      ? []
      : [
          item({
            id: 'copy-cwd',
            label: 'Sao chép thư mục làm việc',
            icon: 'folder',
            action: { kind: 'copy', what: 'cwd' },
          }),
        ]),
    ...withGroupStart([
      item({
        id: 'tab-terminal',
        label: 'Mở Terminal',
        icon: 'terminal',
        action: { kind: 'sessionTab', tab: 'terminal' },
      }),
      item({
        id: 'tab-activity',
        label: 'Mở Hoạt động',
        icon: 'list',
        action: { kind: 'sessionTab', tab: 'activity' },
      }),
      item({
        id: 'tab-tasks',
        label: 'Mở Việc',
        icon: 'flag',
        action: { kind: 'sessionTab', tab: 'tasks' },
      }),
      item({
        id: 'tab-details',
        label: 'Mở Chi tiết',
        icon: 'info',
        action: { kind: 'sessionTab', tab: 'details' },
      }),
      ...maximizeItems(drawer),
    ]),
    ...withGroupStart(workItemMenuItems(work)),
    ...withGroupStart(allowedControls),
    ...withGroupStart([...killItems, deleteItem]),
  ];
}

/** The task items a task card offers: its detail, its contract when it has one, its code. */
function taskMenuItems(task: TaskMenuFacts): AgentMenuItem[] {
  return [
    item({ id: 'task-open', label: 'Xem chi tiết', icon: 'eye', action: { kind: 'openTask' } }),
    ...(task.contractId === null
      ? []
      : [
          item({
            id: 'task-contract',
            label: 'Xem Contract',
            icon: 'file-text',
            action: { kind: 'openContract', contractId: task.contractId },
          }),
        ]),
    item({
      id: 'copy-task',
      label: 'Sao chép mã việc',
      icon: 'copy',
      action: { kind: 'copy', what: 'taskCode' },
    }),
  ];
}

/**
 * The items for a task card: the task's own, then its session's when a session
 * runs it. A drawer opened on a task with no session still offers maximize.
 */
export function taskCardMenuItems(
  task: TaskMenuFacts,
  session: SessionMenuFacts | null,
  drawer: DrawerView | null,
): AgentMenuItem[] {
  const own = taskMenuItems(task);
  if (session === null) return [...own, ...withGroupStart(maximizeItems(drawer))];
  return [...own, ...withGroupStart(sessionMenuItems(session, drawer))];
}

/** The valid controls for one work item card, followed by its identity copies. */
export function workItemCardMenuItems(work: WorkItemMenuFacts): AgentMenuItem[] {
  const items: AgentMenuItem[] = [
    item({
      id: 'work-open',
      label: 'Xem chi tiết',
      icon: 'eye',
      action: { kind: 'workItemAction', action: 'open' },
    }),
  ];
  if (work.privileged) {
    if (work.status === 'queued' || work.status === 'review' || work.status === 'failed') {
      items.push(
        item({
          id: 'work-assign',
          label: 'Giao lại',
          icon: 'send',
          action: { kind: 'workItemAction', action: 'assign' },
        }),
      );
    }
    if (work.status === 'review' || work.status === 'failed') {
      items.push(
        item({
          id: 'work-follow-up',
          label: 'Hỏi tiếp',
          icon: 'send',
          action: { kind: 'workItemAction', action: 'followUp' },
        }),
      );
    }
    if (work.status !== 'done') {
      items.push(
        item({
          id: 'work-done',
          label: 'Đánh dấu xong',
          icon: 'check',
          action: { kind: 'workItemAction', action: 'done' },
        }),
      );
    }
    if (['queued', 'running', 'needs_input', 'review'].includes(work.status)) {
      items.push(
        item({
          id: 'work-failed',
          label: 'Đánh dấu thất bại',
          icon: 'x-circle',
          action: { kind: 'workItemAction', action: 'failed' },
          danger: true,
        }),
      );
    }
    if (work.status === 'queued') {
      items.push(
        item({
          id: 'work-cancel',
          label: 'Huỷ việc',
          icon: 'stop',
          action: { kind: 'workItemAction', action: 'cancel' },
          danger: true,
        }),
      );
    }
    if (work.canJudge) {
      items.push(
        item({
          id: 'work-judge',
          label: 'Chạy giám khảo',
          icon: 'check',
          action: { kind: 'workItemAction', action: 'judge' },
        }),
      );
    }
    if (work.canCleanWorktree) {
      items.push(
        item({
          id: 'work-clean',
          label: 'Dọn worktree',
          icon: 'trash',
          action: { kind: 'workItemAction', action: 'cleanWorktree' },
          danger: true,
        }),
      );
    }
    if (work.canAskLeader) {
      items.push(
        item({
          id: 'work-squad',
          label: 'Hỏi đội trưởng bước tiếp',
          icon: 'send',
          action: { kind: 'workItemAction', action: 'askLeader' },
        }),
      );
    }
  }
  items.push(
    item({
      id: 'copy-work-code',
      label: 'Sao chép mã việc',
      icon: 'copy',
      action: { kind: 'copy', what: 'workItemCode' },
    }),
    item({
      id: 'copy-work-text',
      label: 'Sao chép nội dung',
      icon: 'copy',
      action: { kind: 'copy', what: 'workItemText' },
    }),
  );
  return items;
}
/** The valid actions and identity copies for one squad run. */
export function squadRunMenuItems(run: SquadRunMenuFacts): AgentMenuItem[] {
  const items: AgentMenuItem[] = [
    item({
      id: 'squad-open',
      label: 'Xem chi tiết',
      icon: 'eye',
      action: { kind: 'squadAction', action: 'open' },
    }),
  ];
  if (run.privileged) {
    if (run.status === 'proposed' && run.hasProposal) {
      items.push(
        item({
          id: 'squad-approve',
          label: 'Duyệt đề xuất…',
          icon: 'check',
          action: { kind: 'squadAction', action: 'approve' },
        }),
        item({
          id: 'squad-dismiss',
          label: 'Bỏ đề xuất',
          icon: 'x-circle',
          action: { kind: 'squadAction', action: 'dismiss' },
        }),
      );
    }
    if (run.status === 'failed') {
      items.push(
        item({
          id: 'squad-retry',
          label: 'Thử lại',
          icon: 'refresh',
          action: { kind: 'squadAction', action: 'retry' },
        }),
      );
    }
    if (run.status === 'planning' || run.status === 'proposed' || run.status === 'working') {
      items.push(
        item({
          id: 'squad-cancel',
          label: 'Huỷ lượt',
          icon: 'stop',
          action: { kind: 'squadAction', action: 'cancel' },
          danger: true,
        }),
      );
    }
    if (
      run.status === 'done' ||
      run.status === 'dismissed' ||
      run.status === 'stopped' ||
      run.status === 'failed'
    ) {
      items.push(
        item({
          id: 'squad-remove',
          label: 'Xoá khỏi bảng',
          icon: 'trash',
          action: { kind: 'squadAction', action: 'remove' },
          danger: true,
        }),
      );
    }
  }
  items.push(
    item({
      id: 'copy-squad-run-code',
      label: 'Sao chép mã lượt',
      icon: 'copy',
      action: { kind: 'copy', what: 'squadRunCode' },
    }),
    item({
      id: 'copy-squad-request',
      label: 'Sao chép nội dung yêu cầu',
      icon: 'copy',
      action: { kind: 'copy', what: 'squadRequest' },
    }),
  );
  return items;
}

/**
 * A planning card's items: its Director session when it has one, then cancelling the
 * prompt. The cancel opens its group only after another item, so no separator sits on top.
 */
export function planningMenuItems(hasSession: boolean): AgentMenuItem[] {
  const cancel = item({
    id: 'planning-cancel',
    label: 'Huỷ prompt này…',
    icon: 'x-circle',
    action: { kind: 'cancelPrompt' },
    danger: true,
  });
  if (!hasSession) return [cancel];
  return [
    item({
      id: 'planning-session',
      label: 'Xem phiên Giám đốc',
      icon: 'external',
      action: { kind: 'openSession' },
    }),
    { ...cancel, startsGroup: true },
  ];
}

/**
 * The items for a herdr agent: its views, its pane actions, its work items, then copies and
 * maximize.
 */
export function herdrMenuItems(
  folder: string | null,
  drawer: DrawerView | null,
  work: WorkMenuFacts | null,
): AgentMenuItem[] {
  return [
    item({
      id: 'info',
      label: 'Xem chi tiết',
      icon: 'info',
      action: { kind: 'herdrTab', tab: 'info' },
    }),
    item({ id: 'rename', label: 'Đổi tên…', icon: 'pencil', action: { kind: 'rename' } }),
    ...withGroupStart([
      item({
        id: 'screen',
        label: 'Xem màn hình',
        icon: 'monitor',
        action: { kind: 'herdrTab', tab: 'screen' },
      }),
      item({
        id: 'read',
        label: 'Đọc lại màn hình',
        icon: 'refresh',
        action: { kind: 'readScreen' },
      }),
      item({ id: 'focus', label: 'Mở trong herdr', icon: 'external', action: { kind: 'focus' } }),
    ]),
    ...withGroupStart(workItemMenuItems(work)),
    ...withGroupStart([
      item({
        id: 'copyScreen',
        label: 'Sao chép màn hình',
        icon: 'copy',
        action: { kind: 'copy', what: 'screen' },
      }),
      ...(folder === null
        ? []
        : [
            item({
              id: 'copy-cwd',
              label: 'Sao chép thư mục',
              icon: 'folder',
              action: { kind: 'copy', what: 'cwd' },
            }),
          ]),
      item({
        id: 'copy-pane',
        label: 'Sao chép pane id',
        icon: 'copy',
        action: { kind: 'copy', what: 'paneId' },
      }),
      ...maximizeItems(drawer),
    ]),
  ];
}

/** The items for a hibernated session: waking it, then maximize. Nothing else acts on a sleeping pane. */
export function sleepingMenuItems(drawer: DrawerView | null): AgentMenuItem[] {
  return [
    item({ id: 'wake', label: 'Đánh thức', icon: 'sun', action: { kind: 'wake' } }),
    ...withGroupStart(maximizeItems(drawer)),
  ];
}

/** The items for a project header: fold or open it, copy its path, switch the board, clean up. */
export function projectMenuItems(project: ProjectMenuFacts): AgentMenuItem[] {
  return [
    item({
      id: 'toggle',
      label: project.collapsed ? 'Mở rộng' : 'Thu gọn',
      icon: project.collapsed ? 'chevron-down' : 'chevron-up',
      action: { kind: 'toggleProject' },
    }),
    ...(project.path === null
      ? []
      : [
          item({
            id: 'copy-path',
            label: 'Sao chép đường dẫn',
            icon: 'copy',
            action: { kind: 'copy', what: 'path' },
          }),
          item({
            id: 'rename-folder',
            label: 'Đổi tên thư mục',
            icon: 'pencil',
            action: { kind: 'renameFolder' },
          }),
        ]),
    ...withGroupStart(
      project.switchTo === null
        ? []
        : [
            item({
              id: 'open-board',
              label: 'Mở thư mục này trên bảng',
              icon: 'folder',
              action: { kind: 'openBoardFolder' },
            }),
          ],
    ),
    ...withGroupStart(
      project.cleanable.length === 0
        ? []
        : [
            item({
              id: 'clean',
              label: `Dọn ${project.cleanable.length} phiên lỗi…`,
              icon: 'trash',
              action: { kind: 'cleanErrored' },
              danger: true,
            }),
          ],
    ),
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
