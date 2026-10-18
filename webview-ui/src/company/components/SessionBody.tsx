/**
 * SessionBody: one managed session in detail -- its identity and controls, then
 * a tab per kind of thing the user checks: the log, the commands it ran, the
 * live terminal, the questions it raised, what it cost, and what it produced.
 *
 * The header distinguishes what was REQUESTED from what is EFFECTIVE, and
 * "parked" from "paused": those are different states with different recovery
 * costs, and blurring them would send the user restarting a session that was
 * only waiting to be collected.
 *
 * Controls are the server's to accept, so the row is derived from the session's
 * reported status (sessionActions.ts) rather than always shown. Only the
 * selected tab is mounted, so ten parked sessions do not mean ten terminals.
 */

import { useEffect, useState } from 'react';

import type { Attempt } from '../../../../core/src/company.js';
import type { CompanyClient } from '../companyClient.js';
import type { CompanyDrawerTab, CompanyViewState } from '../companyState.js';
import { questionProvenance } from '../questionProvenance.js';
import { companyRoleLabel } from '../roleProfiles.js';
import { sessionControls } from '../sessionActions.js';
import { DRAWER_TAB_LABELS, sessionStatusLabel } from '../statusLabels.js';
import { contextOccupancy } from '../usageView.js';
import { SessionInfoTab } from './AgentInfoTab.js';
import { CompanyButton } from './CompanyButton.js';
import { QuestionPanel } from './QuestionPanel.js';
import { CommandsTab, SessionLogTab } from './SessionLog.js';
import { TaskReport } from './TaskReport.js';
import { TerminalTab } from './TerminalTab.js';
import { UsageTab } from './UsageTab.js';

const TABS = [
  'log',
  'commands',
  'terminal',
  'questions',
  'usage',
  'report',
  'info',
] as const satisfies readonly CompanyDrawerTab[];

export interface SessionBodyProps {
  client: CompanyClient;
  state: CompanyViewState;
  sessionId: string;
  /** The task the drawer is about, or null when it shows the session itself. */
  taskId: string | null;
  onOpenArtifact: (artifactId: string) => void;
  onOpenQuestion: (questionId: string) => void;
}

export function SessionBody({
  client,
  state,
  sessionId,
  taskId,
  onOpenArtifact,
  onOpenQuestion,
}: SessionBodyProps) {
  const [tab, setTab] = useState<CompanyDrawerTab>('log');

  // A card or a bubble can ask for a specific tab ("show me the question it is
  // blocked on"). The request is part of the shared selection, so it outlives a
  // re-render of this body.
  useEffect(() => {
    if (state.selection.tab) setTab(state.selection.tab);
  }, [state.selection]);

  // The server keeps the log on disk; live entries only cover what happened
  // since this page connected, so opening a session asks for its history.
  useEffect(() => {
    client.requestSessionLog(sessionId);
  }, [client, sessionId]);

  const session = state.sessions[sessionId];
  if (session === undefined) {
    return <p className="p-2 text-2xs text-text-muted">Phiên đó không còn thuộc công ty nữa.</p>;
  }

  const controls = sessionControls(session.status);
  const attempts: Attempt[] = Object.values(state.attempts).filter((attempt) =>
    taskId === null ? attempt.sessionId === sessionId : attempt.taskId === taskId,
  );
  const pendingCount = Object.values(state.questions).filter(
    (question) => question.sessionId === sessionId && question.status === 'pending',
  ).length;
  const occupancy = contextOccupancy(session);
  const reportTaskId = taskId ?? session.activeTaskId ?? null;

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="session-body">
      <div className="border-b border-border px-3 py-2.5">
        <p className="text-2xs text-text-muted">
          {session.code} &middot; {sessionStatusLabel(session.status)} &middot;{' '}
          {companyRoleLabel(session.role)} &middot; kỳ {session.runEpoch}
        </p>
        <p className="text-2xs text-text-muted">
          đã yêu cầu {session.requestedModel}
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
            <CompanyButton size="sm" onClick={() => client.controlSession(sessionId, 'pause')}>
              Tạm dừng
            </CompanyButton>
          )}
          {controls.resume && (
            <CompanyButton size="sm" onClick={() => client.controlSession(sessionId, 'resume')}>
              Tiếp tục
            </CompanyButton>
          )}
          {controls.restart && (
            <CompanyButton size="sm" onClick={() => client.controlSession(sessionId, 'restart')}>
              Khởi động lại
            </CompanyButton>
          )}
          {controls.kill && (
            <CompanyButton size="sm" onClick={() => client.controlSession(sessionId, 'kill')}>
              Dừng
            </CompanyButton>
          )}
          {controls.archive && (
            <CompanyButton size="sm" onClick={() => client.controlSession(sessionId, 'archive')}>
              Lưu trữ
            </CompanyButton>
          )}
        </div>
      </div>

      <nav aria-label="Phần của phiên" className="flex flex-wrap gap-1 border-b border-border px-2">
        {TABS.map((entry) => (
          <button
            key={entry}
            type="button"
            onClick={() => setTab(entry)}
            aria-current={tab === entry}
            className={`-mb-px cursor-pointer border-b-2 px-2 py-1.5 text-2xs ${
              tab === entry
                ? 'border-accent text-text'
                : 'border-transparent text-text-muted hover:text-text'
            }`}
          >
            {DRAWER_TAB_LABELS[entry]}
            {entry === 'questions' && pendingCount > 0 ? ` (${pendingCount})` : ''}
          </button>
        ))}
      </nav>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {tab === 'log' && (
          <SessionLogTab
            state={state}
            sessionId={sessionId}
            taskId={taskId}
            attempts={attempts}
            onOpenArtifact={onOpenArtifact}
          />
        )}
        {tab === 'commands' && <CommandsTab state={state} sessionId={sessionId} taskId={taskId} />}
        {tab === 'terminal' && <TerminalTab client={client} state={state} sessionId={sessionId} />}
        {tab === 'questions' && (
          <SessionQuestions
            client={client}
            state={state}
            sessionId={sessionId}
            onOpenQuestion={onOpenQuestion}
          />
        )}
        {tab === 'usage' && <UsageTab client={client} sessionId={sessionId} />}
        {tab === 'report' && (
          <TaskReport state={state} taskId={reportTaskId} onOpenArtifact={onOpenArtifact} />
        )}
        {tab === 'info' && <SessionInfoTab client={client} state={state} sessionId={sessionId} />}
      </div>
    </section>
  );
}

/**
 * The session's questions. A pending one is answered in its own drawer, opened
 * from here, so the answer box exists once on screen; resolved ones stay here
 * as history.
 */
function SessionQuestions({
  client,
  state,
  sessionId,
  onOpenQuestion,
}: {
  client: CompanyClient;
  state: CompanyViewState;
  sessionId: string;
  onOpenQuestion: (questionId: string) => void;
}) {
  const questions = Object.values(state.questions).filter(
    (question) => question.sessionId === sessionId,
  );
  if (questions.length === 0) {
    return <p className="p-2 text-2xs text-text-muted">Không có câu hỏi nào từ phiên này.</p>;
  }
  return (
    <div className="flex flex-col gap-2 p-2">
      {questions
        .filter((question) => question.status === 'pending')
        .map((question) => (
          <div
            key={question.id}
            className="flex items-center justify-between gap-2 rounded-[6px] border border-warning p-2 text-2xs"
          >
            <span className="min-w-0 truncate text-text">{question.title}</span>
            <button
              type="button"
              onClick={() => onOpenQuestion(question.id)}
              className="shrink-0 cursor-pointer text-accent-bright"
            >
              Trả lời
            </button>
          </div>
        ))}
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
  );
}
