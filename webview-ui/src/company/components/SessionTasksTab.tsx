/**
 * SessionTasksTab: the work a session holds. When the drawer is about a task, the
 * task's facts sit at the top; then what omp reports it is doing (plan, todo list,
 * subagents), read-only; then the attempts made on the task.
 */

import type { ReactNode } from 'react';

import type { Attempt } from '../../../../core/src/company.js';
import type { CompanyViewState } from '../companyState.js';
import { AttemptRow } from './AttemptRow.js';
import { SessionInsightTab } from './SessionInsightPanels.js';

export interface SessionTasksTabProps {
  state: CompanyViewState;
  sessionId: string;
  /** The task the drawer is about, or null when it shows the session itself. */
  taskId: string | null;
  /** The task's own facts, drawn above its attempts; empty for a session with no task in view. */
  header?: ReactNode;
  onOpenArtifact: (artifactId: string) => void;
}

export function SessionTasksTab({
  state,
  sessionId,
  taskId,
  header,
  onOpenArtifact,
}: SessionTasksTabProps) {
  const attempts: Attempt[] = Object.values(state.attempts).filter((attempt) =>
    taskId === null ? attempt.sessionId === sessionId : attempt.taskId === taskId,
  );
  const session = state.sessions[sessionId];
  return (
    <div className="flex flex-col gap-3 p-3 text-2xs">
      {header}
      {session !== undefined && <SessionInsightTab session={session} />}
      {attempts.length === 0 ? (
        <p className="text-text-muted">Chưa có lượt thử nào.</p>
      ) : (
        <section aria-label="Lượt thử" className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-text-muted">Lượt thử</h3>
          {attempts.map((attempt) => (
            <AttemptRow
              key={attempt.id}
              attempt={attempt}
              evidence={state.evidence}
              onOpenArtifact={onOpenArtifact}
            />
          ))}
        </section>
      )}
    </div>
  );
}
