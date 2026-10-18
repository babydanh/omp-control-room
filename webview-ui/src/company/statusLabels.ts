/**
 * statusLabels: the Vietnamese NAME of every value the wire carries.
 *
 * Everything in this file is a DISPLAY mapping. None of it is a translation of
 * a stored value: the coordinator compares these exact strings, writes them
 * into snapshots and matches them across a reload, so a status stays English
 * on the wire and is only given a Vietnamese label where a reader sees it.
 * `contract.status`, `task.status`, `session.status` and the rest are untouched
 * by anything here -- `data-testid`s, `data-omp-status` attributes and the
 * selectors the e2e suite drives still carry the wire value.
 *
 * Every helper takes a `string` rather than the generated union, because the
 * snapshot is a `Record<string, T>` and a value read back out of one is not
 * narrowed by the compiler. An unrecognised value is printed as itself rather
 * than collapsed to a neighbour: a status this view does not know is still a
 * fact, and rounding it to something it recognises would be a lie.
 */

import type {
  Attempt,
  Contract,
  QuotaSnapshot,
  Task,
  WorkspaceChange,
} from '../../../core/src/company.js';
import type { CompanyDrawerTab } from './companyState.js';

/**
 * The one fallback rule, shared by every table below: a value with no label is
 * printed unchanged. Keeping it here is what stops one call site from quietly
 * showing `undefined` while another shows the raw value.
 */
function labelFor(table: Readonly<Record<string, string>>, value: string): string {
  return table[value] ?? value;
}

const TASK_STATUS_LABELS: Record<Task['status'], string> = {
  planned: 'Đã lên kế hoạch',
  ready: 'Sẵn sàng',
  running: 'Đang chạy',
  waiting_input: 'Chờ phản hồi',
  paused: 'Tạm dừng',
  verifying: 'Đang kiểm chứng',
  changes_requested: 'Đã yêu cầu sửa',
  done: 'Hoàn thành',
  failed: 'Thất bại',
  cancelled: 'Đã hủy',
};

/** A task's wire status as the board card and the plan panel read it. */
export function taskStatusLabel(status: string): string {
  return labelFor(TASK_STATUS_LABELS, status);
}

const CONTRACT_STATUS_LABELS: Record<Contract['status'], string> = {
  draft: 'Bản nháp',
  clarifying: 'Đang làm rõ',
  architecture_review: 'Đang duyệt kiến trúc',
  awaiting_approval: 'Chờ phê duyệt',
  approved: 'Đã phê duyệt',
  running: 'Đang chạy',
  completed: 'Đã hoàn tất',
  blocked: 'Bị chặn',
  cancelled: 'Đã hủy',
};

/** A Contract's wire status as the plan panel header reads it. */
export function contractStatusLabel(status: string): string {
  return labelFor(CONTRACT_STATUS_LABELS, status);
}

/**
 * Session lifecycle, from `sessionActions.ts`'s own vocabulary: a parked
 * session and a paused one are different states with different recovery costs,
 * and this is where the reader is told which one they are looking at.
 */
const SESSION_STATUS_LABELS: Readonly<Record<string, string>> = {
  parked: 'Đang tạm trữ',
  starting: 'Đang khởi động',
  idle: 'Nhàn rỗi',
  busy: 'Đang bận',
  waiting_input: 'Chờ phản hồi',
  pausing: 'Đang tạm dừng',
  paused: 'Tạm dừng',
  stopping: 'Đang dừng',
  stopped: 'Đã dừng',
  crashed: 'Đã sập',
  archived: 'Đã lưu trữ',
};

/** A session's wire status, wherever a panel prints one. */
export function sessionStatusLabel(status: string): string {
  return labelFor(SESSION_STATUS_LABELS, status);
}

const ATTEMPT_STATUS_LABELS: Record<Attempt['status'], string> = {
  running: 'Đang chạy',
  passed: 'Đạt',
  failed: 'Thất bại',
  interrupted: 'Bị gián đoạn',
  blocked: 'Bị chặn',
};

/** An attempt's wire verdict as the activity list reads it. */
export function attemptStatusLabel(status: string): string {
  return labelFor(ATTEMPT_STATUS_LABELS, status);
}

const CHANGE_KIND_LABELS: Record<WorkspaceChange['kind'], string> = {
  create: 'Tạo',
  modify: 'Sửa',
  delete: 'Xóa',
};

/** How a workspace file was changed, as the change rows read it. */
export function changeKindLabel(kind: string): string {
  return labelFor(CHANGE_KIND_LABELS, kind);
}

/**
 * A report's requirement outcome, as `companyReport.ts` derives it. The value
 * is an English enum on the wire; the panel says `Đã đạt` and the snapshot
 * keeps `satisfied`.
 */
const REQUIREMENT_OUTCOME_LABELS: Readonly<Record<string, string>> = {
  satisfied: 'Đã đạt',
  failed: 'Thất bại',
  in_progress: 'Đang thực hiện',
  blocked: 'Bị chặn',
};

export function requirementOutcomeLabel(result: string): string {
  return labelFor(REQUIREMENT_OUTCOME_LABELS, result);
}

const QUOTA_STATUS_LABELS: Record<QuotaSnapshot['status'], string> = {
  available: 'Khả dụng',
  unsupported: 'Không hỗ trợ',
  unauthenticated: 'Chưa xác thực',
  error: 'Lỗi',
  stale: 'Đã cũ',
};

export function quotaStatusLabel(status: string): string {
  return labelFor(QUOTA_STATUS_LABELS, status);
}

/**
 * The drawer's tabs. These ids ARE the selection (`CompanyDrawerTab`), so they
 * travel through `client.select({ tab })` and across surfaces; only the drawn
 * word is Vietnamese.
 */
export const DRAWER_TAB_LABELS: Record<CompanyDrawerTab, string> = {
  activity: 'Hoạt động',
  terminal: 'Terminal',
  tasks: 'Việc',
  details: 'Chi tiết',
};
