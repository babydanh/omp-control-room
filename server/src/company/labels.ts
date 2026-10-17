/**
 * Vietnamese labels for the Company wire enums.
 *
 * The enums themselves stay English everywhere: they are `===`-compared, used
 * as object keys, persisted into snapshots and matched on by the webview.
 * Translating a value would corrupt all of that. What this module provides is
 * the other half — a VALUE to LABEL map used at the point where a raw enum is
 * interpolated into a sentence a person reads (an error message, a routing
 * reason, a task's `routeReason` badge on the board).
 *
 * Keep the two in sync: adding a member to a union in core/src/messages.ts
 * means adding its label here, or the interpolation falls back to the raw
 * English value at runtime.
 */

import type { CompanyRole, CompanySession, Contract } from '../../../core/src/messages.js';
import type { CompanySessionAction } from './companyCoordinator.js';

export const SESSION_ACTION_LABELS: Readonly<Record<CompanySessionAction, string>> = {
  pause: 'tạm dừng',
  resume: 'tiếp tục',
  kill: 'dừng',
  restart: 'khởi động lại',
  archive: 'lưu trữ',
};

export const SESSION_STATUS_LABELS: Readonly<Record<CompanySession['status'], string>> = {
  parked: 'đang đậu',
  starting: 'đang khởi động',
  idle: 'rảnh',
  busy: 'đang bận',
  waiting_input: 'đang chờ phản hồi',
  pausing: 'đang tạm dừng',
  paused: 'đã tạm dừng',
  stopping: 'đang dừng',
  stopped: 'đã dừng',
  crashed: 'đã sập',
  archived: 'đã lưu trữ',
};

export const CONTRACT_STATUS_LABELS: Readonly<Record<Contract['status'], string>> = {
  draft: 'bản nháp',
  clarifying: 'đang làm rõ',
  architecture_review: 'đang đánh giá kiến trúc',
  awaiting_approval: 'đang chờ duyệt',
  approved: 'đã duyệt',
  running: 'đang chạy',
  completed: 'đã hoàn tất',
  blocked: 'bị chặn',
  cancelled: 'đã hủy',
};

export const PROMPT_DELIVERY_LABELS: Readonly<Record<string, string>> = {
  prompt: 'thường',
  steer: 'điều hướng',
  follow_up: 'theo dõi',
};

// Mirrors webview-ui/src/company/roleProfiles.ts ROLE_LABELS, so a role named
// inside a server sentence reads the same as one the webview labels itself.
export const ROLE_LABELS: Readonly<Record<CompanyRole, string>> = {
  director: 'Giám đốc',
  advisor: 'Cố vấn',
  worker: 'Nhân viên',
  qa: 'QA',
  judge: 'Trọng tài',
};

/** A Contract status as a reader sees it, not as the wire spells it. */
export function describeStatus(status: Contract['status']): string {
  return CONTRACT_STATUS_LABELS[status] ?? status;
}

export function sessionStatusLabel(status: CompanySession['status']): string {
  return SESSION_STATUS_LABELS[status] ?? status;
}
