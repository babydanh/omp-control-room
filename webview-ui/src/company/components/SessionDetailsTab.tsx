/**
 * SessionDetailsTab: everything about a session that is not its work or its
 * activity. Identity, model and context, cost, the task report, and the info
 * snapshot each appear here once, and nowhere else in the drawer.
 *
 * The header distinguishes what was REQUESTED from what is EFFECTIVE: the two
 * can differ, and blurring them would hide a model the session is not running.
 */

import type { ReactNode } from 'react';

import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { companyRoleLabel } from '../roleProfiles.js';
import { sessionStatusLabel } from '../statusLabels.js';
import { contextOccupancy } from '../usageView.js';
import { SessionInfoTab } from './AgentInfoTab.js';
import { TaskReport } from './TaskReport.js';
import { UsageTab } from './UsageTab.js';

export interface SessionDetailsTabProps {
  client: CompanyClient;
  state: CompanyViewState;
  sessionId: string;
  /** The task the drawer is about, or null when it shows the session itself. */
  taskId: string | null;
  onOpenArtifact: (artifactId: string) => void;
}

export function SessionDetailsTab({
  client,
  state,
  sessionId,
  taskId,
  onOpenArtifact,
}: SessionDetailsTabProps) {
  const session = state.sessions[sessionId];
  if (session === undefined) return null;
  const occupancy = contextOccupancy(session);
  const reportTaskId = taskId ?? session.activeTaskId ?? null;
  return (
    <div className="flex flex-col gap-4 p-3 text-2xs">
      <DetailSection title="Phiên">
        <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-2 gap-y-1">
          <dt className="text-text-muted">Mã</dt>
          <dd className="min-w-0 text-text">{session.code}</dd>
          <dt className="text-text-muted">Trạng thái</dt>
          <dd className="min-w-0 text-text">{sessionStatusLabel(session.status)}</dd>
          <dt className="text-text-muted">Vai trò</dt>
          <dd className="min-w-0 text-text">{companyRoleLabel(session.role)}</dd>
          <dt className="text-text-muted">Kỳ chạy</dt>
          <dd className="min-w-0 tabular-nums text-text">{session.runEpoch}</dd>
          {session.nativeSessionId && (
            <>
              <dt className="text-text-muted">Phiên gốc</dt>
              <dd
                className="min-w-0 truncate text-text"
                title={session.nativeSessionPath ?? session.nativeSessionId}
              >
                {session.nativeSessionId}
              </dd>
            </>
          )}
        </dl>
      </DetailSection>

      <DetailSection title="Mô hình & ngữ cảnh">
        <p className="text-text">
          đã yêu cầu {session.requestedModel}
          {session.effectiveModel && session.effectiveModel !== session.requestedModel && (
            <span className="text-warning"> &middot; đang chạy {session.effectiveModel}</span>
          )}
        </p>
        {occupancy === null ? (
          <p className="text-text-muted">Chưa có số liệu ngữ cảnh.</p>
        ) : (
          <div className="flex items-center gap-2">
            <div
              role="meter"
              aria-label="Ngữ cảnh đã dùng"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(occupancy * 100)}
              className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-well"
            >
              <div
                className="h-full bg-accent"
                style={{ width: `${Math.round(occupancy * 100)}%` }}
              />
            </div>
            <span className="shrink-0 tabular-nums text-text-muted">
              {Math.round(occupancy * 100)}%
            </span>
          </div>
        )}
      </DetailSection>

      <DetailSection title="Chi phí">
        <UsageTab client={client} sessionId={sessionId} />
      </DetailSection>

      <DetailSection title="Báo cáo">
        <TaskReport state={state} taskId={reportTaskId} onOpenArtifact={onOpenArtifact} />
      </DetailSection>

      <DetailSection title="Thông tin">
        <SessionInfoTab client={client} state={state} sessionId={sessionId} hideModel />
      </DetailSection>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="text-xs font-semibold text-text-muted">{title}</h3>
      {children}
    </section>
  );
}
