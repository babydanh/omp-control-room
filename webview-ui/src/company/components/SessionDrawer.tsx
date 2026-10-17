/**
 * SessionDrawer: one managed session, in detail.
 *
 * Tabs, because the five things a user checks are different kinds of thing:
 * the live terminal, what it said, what it is blocked on, what it cost, and what
 * it produced. Only the selected tab is mounted, so ten parked sessions do not
 * mean ten xterm instances.
 *
 * The header distinguishes what was REQUESTED from what is EFFECTIVE, and
 * "parked" from "paused": those are different states with different recovery
 * costs, and a panel that blurred them would send the user restarting a session
 * that was only waiting to be collected.
 *
 * Controls are the server's to accept, so the row is derived from the session's
 * reported status (`sessionActions.ts`) rather than being always-on.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Attempt, VerificationEvidence } from '../../../../core/src/company.js';
import { Button } from '../../components/ui/Button.js';
import { companyRoleLabel } from '../companyCharacters.js';
import type { CompanyClient } from '../companyClient.js';
import type { CompanyDrawerTab } from '../companyState.js';
import { questionProvenance } from '../questionProvenance.js';
import { sessionControls } from '../sessionActions.js';
import {
  attemptStatusLabel,
  changeKindLabel,
  DRAWER_TAB_LABELS,
  quotaStatusLabel,
  sessionStatusLabel,
} from '../statusLabels.js';
import {
  cacheHitRate,
  contextOccupancy,
  quotaRows,
  summarizeUsage,
  usageByModel,
  usageForSession,
} from '../usageView.js';
import { useCompanyState } from '../useCompanyState.js';
import { QuestionPanel } from './QuestionPanel.js';
import { ReportPanel } from './ReportPanel.js';
import { TerminalConsole } from './TerminalConsole.js';

export interface SessionDrawerProps {
  client: CompanyClient;
  sessionId: string;
  onOpenArtifact: (artifactId: string) => void;
}

const TABS = [
  'terminal',
  'activity',
  'questions',
  'usage',
  'report',
] as const satisfies readonly CompanyDrawerTab[];
type DrawerTab = CompanyDrawerTab;

export function SessionDrawer({ client, sessionId, onOpenArtifact }: SessionDrawerProps) {
  const state = useCompanyState(client);
  const [tab, setTab] = useState<DrawerTab>('terminal');

  // A bubble or a board card can ask for a specific tab ("show me the question
  // it is blocked on"). The request is part of the shared selection, so it
  // outlives a re-render of this drawer.
  useEffect(() => {
    if (state.selection.tab) setTab(state.selection.tab);
  }, [state.selection.tab]);
  const session = state.sessions[sessionId];

  const questions = useMemo(
    () =>
      Object.values(state.questions).filter(
        (question) => question.sessionId === sessionId && question.status === 'pending',
      ),
    [state.questions, sessionId],
  );

  const runEpoch = session?.runEpoch;
  // Attach on mount, release on unmount or epoch change. A terminal that stays
  // attached to a session nobody is looking at keeps its PTY lease for nothing.
  useEffect(() => {
    if (runEpoch === undefined) return undefined;
    client.attachTerminal(sessionId);
    return () => {
      client.detachTerminal(sessionId);
    };
  }, [client, sessionId, runEpoch]);

  const onInput = useCallback(
    (data: string) => {
      if (runEpoch !== undefined) client.writeTerminal(sessionId, runEpoch, data);
    },
    [client, sessionId, runEpoch],
  );
  const onResize = useCallback(
    (cols: number, rows: number) => {
      if (runEpoch !== undefined) client.resizeTerminal(sessionId, runEpoch, cols, rows);
    },
    [client, sessionId, runEpoch],
  );
  const onOverflow = useCallback(() => client.attachTerminal(sessionId), [client, sessionId]);

  if (!session) {
    return (
      <p className="p-2 text-2xs text-text-muted" data-testid="session-drawer">
        Phiên đó không còn thuộc công ty nữa.
      </p>
    );
  }

  const controls = sessionControls(session.status);
  const terminal = state.terminals[sessionId];
  const task = state.selection.taskId ? state.tasks[state.selection.taskId] : undefined;
  const contract = task ? state.contracts[task.contractId] : undefined;
  const report = Object.values(state.reports).find(
    (entry) => entry.contractId === contract?.id && entry.revision === contract?.revision,
  );
  const attempts = Object.values(state.attempts).filter(
    (attempt) => attempt.sessionId === sessionId,
  );
  const stream = state.streams[sessionId];
  const occupancy = contextOccupancy(session);

  return (
    <section className="flex min-h-0 flex-col" data-testid="session-drawer">
      <header className="border-b-2 border-border p-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm text-text">
            {session.code} &middot; {session.name}
          </h3>
          <span className="text-2xs uppercase tracking-wide text-text-muted">
            {sessionStatusLabel(session.status)}
          </span>
        </div>
        <p className="text-2xs text-text-muted">
          {companyRoleLabel(session.role)} &middot; kỳ {session.runEpoch} &middot; đã yêu cầu{' '}
          {session.requestedModel}
          {session.effectiveModel && session.effectiveModel !== session.requestedModel && (
            <span className="text-warning"> &middot; đang chạy {session.effectiveModel}</span>
          )}
          {occupancy !== null && <> &middot; ngữ cảnh {Math.round(occupancy * 100)}%</>}
        </p>
        {session.nativeSessionId && (
          <p className="truncate text-2xs text-text-muted" title={session.nativeSessionPath ?? ''}>
            phiên gốc {session.nativeSessionId}
            {session.nativeSessionPath ? ` (${session.nativeSessionPath})` : ''}
          </p>
        )}
        <div className="mt-1 flex flex-wrap gap-1">
          {controls.pause && (
            <Button size="sm" onClick={() => client.controlSession(sessionId, 'pause')}>
              Tạm dừng
            </Button>
          )}
          {controls.resume && (
            <Button size="sm" onClick={() => client.controlSession(sessionId, 'resume')}>
              Tiếp tục
            </Button>
          )}
          {controls.restart && (
            <Button size="sm" onClick={() => client.controlSession(sessionId, 'restart')}>
              Khởi động lại
            </Button>
          )}
          {controls.kill && (
            <Button size="sm" onClick={() => client.controlSession(sessionId, 'kill')}>
              Dừng
            </Button>
          )}
          {controls.archive && (
            <Button size="sm" onClick={() => client.controlSession(sessionId, 'archive')}>
              Lưu trữ
            </Button>
          )}
        </div>
      </header>

      <nav className="flex gap-1 border-b-2 border-border p-1">
        {TABS.map((entry) => (
          <button
            key={entry}
            type="button"
            onClick={() => setTab(entry)}
            aria-current={tab === entry}
            className={
              tab === entry
                ? 'cursor-pointer border-2 border-accent px-2 text-2xs text-text'
                : 'cursor-pointer border-2 border-transparent px-2 text-2xs text-text-muted'
            }
          >
            {DRAWER_TAB_LABELS[entry]}
            {entry === 'questions' && questions.length > 0 ? ` (${questions.length})` : ''}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'terminal' &&
          (session.status === 'parked' || session.status === 'archived' ? (
            <p className="p-2 text-2xs text-text-muted">
              Phiên này đang {sessionStatusLabel(session.status)}: không có tiến trình đang chạy.
              Hãy tiếp tục phiên để gắn bảng điều khiển.
            </p>
          ) : (
            <TerminalConsole
              sessionId={sessionId}
              attached={terminal?.attached ?? false}
              runEpoch={session.runEpoch}
              frames={terminal?.frames ?? []}
              overflow={terminal?.overflow ?? false}
              closedReason={terminal?.closedReason ?? null}
              onInput={onInput}
              onResize={onResize}
              onOverflow={onOverflow}
            />
          ))}

        {tab === 'activity' && (
          <div className="flex flex-col gap-2 p-2">
            {stream?.excerpt ? (
              <p className="text-2xs text-text">{stream.excerpt}</p>
            ) : (
              <p className="text-2xs text-text-muted">Chưa có đầu ra công khai nào.</p>
            )}
            {attempts.length === 0 && (
              <p className="text-2xs text-text-muted">Chưa ghi nhận lượt chạy nào.</p>
            )}
            {attempts.map((attempt: Attempt) => (
              <AttemptRow
                key={attempt.id}
                attempt={attempt}
                evidence={state.evidence}
                onOpenArtifact={onOpenArtifact}
              />
            ))}
          </div>
        )}

        {/* Pending questions are answered in the workspace, which lists every
            one at once. Rendering them here as well gave each one two identical
            answer boxes with the same aria-label — so this tab carries the
            resolved history only. */}
        {tab === 'questions' &&
          (questions.filter((question) => question.status !== 'pending').length === 0 ? (
            <p className="p-2 text-2xs text-text-muted">Không có gì đang chờ bạn ở đây.</p>
          ) : (
            <div className="flex flex-col gap-2 p-2">
              {questions
                .filter((question) => question.status !== 'pending')
                .map((question) => (
                  <QuestionPanel
                    key={question.id}
                    question={question}
                    onAnswer={(input) => client.answerQuestion(input)}
                    provenance={questionProvenance(state.streams[question.sessionId])}
                  />
                ))}
            </div>
          ))}

        {tab === 'usage' && <UsageTab client={client} sessionId={sessionId} />}

        {tab === 'report' &&
          (report ? (
            <ReportPanel
              report={report}
              contract={contract}
              evidence={state.evidence}
              onOpenArtifact={onOpenArtifact}
            />
          ) : (
            <p className="p-2 text-2xs text-text-muted">
              Chưa có báo cáo cho bản sửa hợp đồng này.
            </p>
          ))}
      </div>
    </section>
  );
}

function AttemptRow({
  attempt,
  evidence,
  onOpenArtifact,
}: {
  attempt: Attempt;
  evidence: Record<string, VerificationEvidence>;
  onOpenArtifact: (artifactId: string) => void;
}) {
  return (
    <div className="border-2 border-border p-2">
      <p className="text-2xs text-text">
        lượt chạy {attempt.id.slice(0, 8)} &middot; {attemptStatusLabel(attempt.status)}
        {attempt.error ? ` · ${attempt.error}` : ''}
      </p>
      {attempt.changes.map((change) => (
        <p key={change.path} className="text-2xs text-text-muted">
          {changeKindLabel(change.kind)} {change.path} — {change.summary}
          {change.diffArtifactId && (
            <button
              type="button"
              className="ml-2 cursor-pointer text-accent-bright"
              onClick={() => onOpenArtifact(change.diffArtifactId ?? '')}
            >
              khác biệt
            </button>
          )}
        </p>
      ))}
      {attempt.evidenceIds.map((evidenceId) => {
        const record = evidence[evidenceId];
        if (!record) {
          return (
            <p key={evidenceId} className="text-2xs text-text-muted">
              bằng chứng {evidenceId.slice(0, 8)} chưa tới
            </p>
          );
        }
        return (
          <p key={evidenceId} className="text-2xs text-text-muted">
            {record.command.executable} {record.command.argv.join(' ')} →{' '}
            {record.signal ? `tín hiệu ${record.signal}` : `mã thoát ${record.exitCode}`}
            {record.stdoutArtifactId && (
              <button
                type="button"
                className="ml-2 cursor-pointer text-accent-bright"
                onClick={() => onOpenArtifact(record.stdoutArtifactId ?? '')}
              >
                đầu ra
              </button>
            )}
            {record.stderrArtifactId && (
              <button
                type="button"
                className="ml-2 cursor-pointer text-accent-bright"
                onClick={() => onOpenArtifact(record.stderrArtifactId ?? '')}
              >
                đầu lỗi
              </button>
            )}
          </p>
        );
      })}
    </div>
  );
}

function UsageTab({ client, sessionId }: { client: CompanyClient; sessionId: string }) {
  const state = useCompanyState(client);
  const records = Object.values(state.usage);
  const sessionRecords = records.filter((record) => record.sessionId === sessionId);
  const totals = usageForSession(records, sessionId);
  const hit = cacheHitRate(sessionRecords);
  const company = summarizeUsage(records);

  return (
    <div className="flex flex-col gap-3 p-2 text-2xs">
      <section aria-label="Phiên này">
        <h4 className="mb-1 text-xs uppercase tracking-wide text-text-muted">Phiên này</h4>
        <p className="text-text">
          vào {totals.input} · ra {totals.output} · đọc bộ nhớ đệm {totals.cacheRead} · ghi bộ
          nhớ đệm {totals.cacheWrite}
        </p>
        <p className="text-text-muted">
          chi phí {totals.costUsd === null ? 'không có' : `$${totals.costUsd.toFixed(4)}`} &middot;
          {' '}trúng bộ nhớ đệm{' '}
          {hit.rate === null
            ? 'không có (không có dữ liệu nào để chia)'
            : `${Math.round(hit.rate * 100)}% trong ${hit.denominator} token`}
        </p>
        {usageByModel(sessionRecords).map((row) => (
          <p key={`${row.provider}/${row.model}`} className="text-text-muted">
            {row.provider}/{row.model}: {row.totals.input} vào / {row.totals.output} ra
            {row.totals.costUsd === null
              ? ' · chi phí không có'
              : ` · $${row.totals.costUsd.toFixed(4)}`}
          </p>
        ))}
      </section>

      <section aria-label="Tổng công ty">
        <h4 className="mb-1 text-xs uppercase tracking-wide text-text-muted">
          Công ty tính đến giờ ({records.length} bản ghi đã nhận)
        </h4>
        <p className="text-text">
          vào {company.input} · ra {company.output} · đọc bộ nhớ đệm {company.cacheRead}
        </p>
      </section>

      <section aria-label="Hạn mức nhà cung cấp">
        <h4 className="mb-1 text-xs uppercase tracking-wide text-text-muted">
          Hạn mức nhà cung cấp (theo tài khoản, không phải theo phiên)
        </h4>
        {quotaRows(Object.values(state.quotas)).map((row) => (
          <p key={row.provider} className="text-text-muted">
            {row.provider} / {row.accountLabel} · {quotaStatusLabel(row.status)}
            {row.windows.map(
              (window) =>
                ` — ${window.label}: ${window.remaining ?? '?'} ${window.reportedUnit} còn lại`,
            )}
          </p>
        ))}
      </section>
    </div>
  );
}
