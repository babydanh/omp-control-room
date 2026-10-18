/**
 * Pure shaping for the session insight OMP reports: todo progress, the subagent
 * summary, the plan-mode label, the one-line progress label for cards, and the
 * gate that keeps an insight off a session that is no longer running. Nothing
 * here invents state the server did not report.
 */

import type {
  CompanySessionInsight,
  CompanySessionSubagent,
  CompanySessionSummary,
  CompanySessionTodo,
  CompanySessionTodoTask,
} from '../../../core/src/messages.js';

type TodoStatus = CompanySessionTodoTask['status'];
type SubagentStatus = CompanySessionSubagent['status'];

export const TODO_STATUS_LABELS: Record<TodoStatus, string> = {
  pending: 'Chờ',
  in_progress: 'Đang làm',
  completed: 'Xong',
  abandoned: 'Bỏ',
  blocked: 'Bị chặn',
};

export const SUBAGENT_STATUS_LABELS: Record<SubagentStatus, string> = {
  pending: 'Chờ',
  running: 'Đang chạy',
  completed: 'Xong',
  failed: 'Lỗi',
  aborted: 'Đã hủy',
};

/** Session statuses in which an OMP process is running and its insight is current. */
const LIVE_SESSION_STATUSES: Record<string, true> = {
  starting: true,
  idle: true,
  busy: true,
  waiting_input: true,
  pausing: true,
};

export interface TodoProgress {
  /** Completed tasks. */
  done: number;
  /** Every task except abandoned ones, which OMP no longer expects to finish. */
  total: number;
  /** Content of the first in-progress task, when OMP reports one. */
  active?: string;
}

export function todoProgress(todo: CompanySessionTodo): TodoProgress {
  const tasks = todo.phases
    .flatMap((phase) => phase.tasks)
    .filter((task) => task.status !== 'abandoned');
  const active = tasks.find((task) => task.status === 'in_progress');
  return {
    done: tasks.filter((task) => task.status === 'completed').length,
    total: tasks.length,
    ...(active === undefined ? {} : { active: active.content }),
  };
}

export interface SubagentSummary {
  /** Subagents currently running. */
  running: number;
  total: number;
}

export function subagentSummary(subagents: readonly CompanySessionSubagent[]): SubagentSummary {
  return {
    running: subagents.filter((row) => row.status === 'running').length,
    total: subagents.length,
  };
}

/** The plan-mode label for a mode other than the normal one; the caller hides `none`. */
export function planModeLabel(planMode: string): string {
  if (planMode === 'plan') return 'Đang lập kế hoạch';
  return `Chế độ ${planMode}`;
}

/** The insight only applies while the session's OMP process is running. */
export function liveSessionInsight(
  session: Pick<CompanySessionSummary, 'status' | 'insight'>,
): CompanySessionInsight | undefined {
  return LIVE_SESSION_STATUSES[session.status] === true ? session.insight : undefined;
}

/** One line for cards and sidebars, or undefined when there is nothing to show. */
export function sessionProgressLabel(insight: CompanySessionInsight): string | undefined {
  const parts: string[] = [];
  if (insight.todo !== undefined) {
    const progress = todoProgress(insight.todo);
    if (progress.total > 0) parts.push(`Việc ${progress.done}/${progress.total}`);
  }
  const summary = subagentSummary(insight.subagents);
  if (summary.running > 0) parts.push(`${summary.running} subagent đang chạy`);
  return parts.length === 0 ? undefined : parts.join(' · ');
}
