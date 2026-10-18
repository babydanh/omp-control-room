/**
 * SessionInsightPanels: what OMP reports about a running session, read-only.
 * The Việc tab lists OMP's todo list, the plan mode and the subagents it has
 * spawned; the progress label is the one-line form for cards and sidebars.
 * Editing stays in the terminal. Once the session stops, nothing here is shown,
 * so a stale insight never reads as current.
 */

import type {
  CompanySessionSubagent,
  CompanySessionSummary,
  CompanySessionTodo,
} from '../../../../core/src/messages.js';
import {
  liveSessionInsight,
  planModeLabel,
  sessionProgressLabel,
  SUBAGENT_STATUS_LABELS,
  subagentSummary,
  TODO_STATUS_LABELS,
  todoProgress,
} from '../sessionInsightView.js';

type InsightSession = Pick<CompanySessionSummary, 'status' | 'insight'>;

export function SessionInsightTab({ session }: { session: InsightSession }) {
  const insight = liveSessionInsight(session);
  if (insight === undefined) {
    return (
      <p className="p-2 text-2xs text-text-muted">Chưa có việc nào từ OMP cho phiên đang chạy.</p>
    );
  }
  return (
    <div className="flex flex-col gap-3 p-2 text-2xs">
      {insight.planMode === 'none' ? null : (
        <p className="text-text-muted">{planModeLabel(insight.planMode)}</p>
      )}
      {insight.todo === undefined ? null : <TodoList todo={insight.todo} />}
      {insight.subagents.length === 0 ? null : <SubagentList subagents={insight.subagents} />}
    </div>
  );
}

export function SessionProgressLabel({ session }: { session: InsightSession }) {
  const insight = liveSessionInsight(session);
  const label = insight === undefined ? undefined : sessionProgressLabel(insight);
  if (label === undefined) return null;
  return <span className="text-2xs text-text-muted">{label}</span>;
}

function TodoList({ todo }: { todo: CompanySessionTodo }) {
  const progress = todoProgress(todo);
  return (
    <section aria-label="Danh sách việc" className="flex flex-col gap-1">
      <h4 className="text-xs font-semibold text-text-muted">
        Việc {progress.done}/{progress.total}
      </h4>
      {progress.active === undefined ? null : (
        <p className="text-text">Đang làm: {progress.active}</p>
      )}
      {todo.phases.map((phase, phaseIndex) => (
        <div key={`phase-${phaseIndex}`} className="flex flex-col gap-0.5">
          <p className="text-text-muted">{phase.name}</p>
          {phase.tasks.map((task, taskIndex) => (
            <p key={`task-${phaseIndex}-${taskIndex}`} className="text-text">
              <span className="text-text-muted">{TODO_STATUS_LABELS[task.status]} · </span>
              {task.content}
              {task.blocker === undefined ? null : (
                <span className="text-text-muted"> ({task.blocker})</span>
              )}
            </p>
          ))}
        </div>
      ))}
    </section>
  );
}

function SubagentList({ subagents }: { subagents: readonly CompanySessionSubagent[] }) {
  const summary = subagentSummary(subagents);
  return (
    <section aria-label="Subagent" className="flex flex-col gap-1">
      <h4 className="text-xs font-semibold text-text-muted">
        Subagent: {summary.running} đang chạy / {summary.total}
      </h4>
      {subagents.map((row) => (
        <p key={row.id} className="text-text">
          {row.agent} ·{' '}
          <span className="text-text-muted">{SUBAGENT_STATUS_LABELS[row.status]}</span>
          {row.currentTool === undefined ? null : (
            <span className="text-text-muted"> · đang dùng {row.currentTool}</span>
          )}
          {row.completionPercent === undefined ? null : (
            <span className="text-text-muted"> · {row.completionPercent}%</span>
          )}
          {row.task === undefined ? null : (
            <span className="block text-text-muted">{row.task}</span>
          )}
        </p>
      ))}
    </section>
  );
}
