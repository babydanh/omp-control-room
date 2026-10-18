/**
 * SessionBody: one managed session in detail, as four tabs: its activity timeline,
 * its live terminal, the work it holds, and its details. A pending question sits
 * above the tabs as a banner, because it blocks the work whatever tab is open.
 *
 * Only the selected tab is mounted, so ten parked sessions do not mean ten terminals.
 */

import { type ReactNode, useEffect, useRef, useState } from 'react';

import type { CompanyClient } from '../companyClient.js';
import type { CompanyDrawerTab, CompanyViewState } from '../companyState.js';
import { SESSION_DRAWER_TABS } from '../drawerTabPrefs.js';
import { defaultDrawerTab } from '../drawerView.js';
import { terminalPolicy } from '../sessionActions.js';
import { DRAWER_TAB_LABELS } from '../statusLabels.js';
import { SessionDetailsTab } from './SessionDetailsTab.js';
import { SessionActivityTab } from './SessionLog.js';
import { SessionTasksTab } from './SessionTasksTab.js';
import type { TerminalJump } from './TerminalConsole.js';
import { TerminalTab } from './TerminalTab.js';

/** The drawer tab in use for one session: the reader's pick, or a request from the shared selection. */
interface TabChoice {
  sessionId: string;
  /** The selection the tab was read from, so a newer request is noticed. */
  selection: CompanyViewState['selection'];
  /** The tab the reader or a request chose; null means the drawer's default. */
  tab: CompanyDrawerTab | null;
}

export interface SessionBodyProps {
  client: CompanyClient;
  state: CompanyViewState;
  sessionId: string;
  /** The task the drawer is about, or null when it shows the session itself. */
  taskId: string | null;
  /** The task's own facts, drawn at the top of the Việc tab when the drawer is about a task. */
  tasksHeader?: ReactNode;
  /** The tab the reader last picked for a session; null until they pick one. */
  rememberedTab: CompanyDrawerTab | null;
  onRememberTab: (tab: CompanyDrawerTab) => void;
  onOpenArtifact: (artifactId: string) => void;
  onOpenQuestion: (questionId: string) => void;
}

export function SessionBody({
  client,
  state,
  sessionId,
  taskId,
  tasksHeader,
  rememberedTab,
  onRememberTab,
  onOpenArtifact,
  onOpenQuestion,
}: SessionBodyProps) {
  // The reader's tab for this session. A tab a card or bubble asked for, carried in the
  // shared selection, overrides a pick; a new session starts on the remembered tab.
  const [stored, setStored] = useState<TabChoice>(() => ({
    sessionId,
    selection: state.selection,
    tab: state.selection.tab,
  }));
  let choice = stored;
  if (stored.sessionId !== sessionId) {
    choice = { sessionId, selection: state.selection, tab: state.selection.tab };
  } else if (stored.selection !== state.selection) {
    choice = { sessionId, selection: state.selection, tab: state.selection.tab ?? stored.tab };
  }
  if (choice !== stored) setStored(choice);

  // The server keeps the log on disk; live entries only cover what happened
  // since this page connected, so opening a session asks for its history.
  useEffect(() => {
    client.requestSessionLog(sessionId);
  }, [client, sessionId]);

  // The command an activity row asked the terminal to find. It is keyed to the session,
  // so a jump made for one session never lands in another.
  const [jumpState, setJumpState] = useState<{ sessionId: string; jump: TerminalJump } | null>(
    null,
  );
  const jumpCounter = useRef(0);

  const session = state.sessions[sessionId];
  if (session === undefined) {
    return <p className="p-2 text-2xs text-text-muted">Phiên đó không còn thuộc công ty nữa.</p>;
  }

  const tab = choice.tab ?? defaultDrawerTab(session.status, rememberedTab);
  const live = terminalPolicy(session.status).attach;
  const jump = jumpState?.sessionId === sessionId ? jumpState.jump : null;
  const onJump = (command: string, output: string | null) => {
    jumpCounter.current += 1;
    setJumpState({ sessionId, jump: { seq: jumpCounter.current, command, output } });
    setStored({ ...choice, tab: 'terminal' });
  };
  const pending = Object.values(state.questions).filter(
    (question) => question.sessionId === sessionId && question.status === 'pending',
  );
  const pickTab = (entry: CompanyDrawerTab) => {
    setStored({ ...choice, tab: entry });
    onRememberTab(entry);
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="session-body">
      {pending.length > 0 && (
        <div
          role="status"
          className="mx-2 mt-2 flex items-center justify-between gap-2 rounded-(--company-radius-md) bg-warning/12 p-2 text-2xs"
        >
          <span className="min-w-0 truncate text-text">
            {pending.length === 1
              ? `Đang chờ bạn trả lời: ${pending[0].title}`
              : `Đang chờ bạn trả lời ${pending.length} câu hỏi`}
          </span>
          <button
            type="button"
            onClick={() => onOpenQuestion(pending[0].id)}
            className="shrink-0 cursor-pointer text-accent-bright"
          >
            Trả lời
          </button>
        </div>
      )}

      <nav aria-label="Phần của phiên" className="flex flex-wrap gap-1 px-2 pt-2">
        {SESSION_DRAWER_TABS.map((entry) => (
          <button
            key={entry}
            type="button"
            onClick={() => pickTab(entry)}
            aria-current={tab === entry}
            className={`relative cursor-pointer px-2 py-1.5 text-2xs ${
              tab === entry
                ? 'text-text after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-accent'
                : 'text-text-muted hover:text-text'
            }`}
          >
            {DRAWER_TAB_LABELS[entry]}
          </button>
        ))}
      </nav>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {tab === 'activity' && (
          <SessionActivityTab
            state={state}
            sessionId={sessionId}
            taskId={taskId}
            live={live}
            onJump={onJump}
          />
        )}
        {tab === 'terminal' && (
          <TerminalTab client={client} state={state} sessionId={sessionId} jump={jump} />
        )}
        {tab === 'tasks' && (
          <SessionTasksTab
            state={state}
            sessionId={sessionId}
            taskId={taskId}
            header={tasksHeader}
            onOpenArtifact={onOpenArtifact}
          />
        )}
        {tab === 'details' && (
          <SessionDetailsTab
            client={client}
            state={state}
            sessionId={sessionId}
            taskId={taskId}
            onOpenArtifact={onOpenArtifact}
          />
        )}
      </div>
    </section>
  );
}
