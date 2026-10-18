/**
 * DetailDrawer: the one thing the user has open, slid in from the right.
 *
 * It shows a board subject (a task, a session) or something opened from the
 * board or the sidebar: the contract to approve, a question, the workspace
 * files, a herdr agent. Closing slides it away. The last subject stays mounted
 * until the slide ends, so the content does not blank mid-motion.
 */

import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { useEffect, useRef, useState } from 'react';

import { workingFolder } from '../agentInfoView.js';
import type { BoardCard, BoardLane } from '../boardView.js';
import { WAIT_REASON_LABELS } from '../boardView.js';
import { copyText } from '../clipboard.js';
import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { COMPANY_DRAWER_MIN_WIDTH_PX, COMPANY_DRAWER_SLIDE_MS } from '../constants.js';
import {
  clampDrawerWidth,
  type DrawerPrefs,
  type DrawerStorage,
  drawerWidthForKey,
  drawerWidthLimit,
  readDrawerPrefs,
  writeDrawerPrefs,
} from '../drawerPrefs.js';
import { shortModelName } from '../drawerView.js';
import { HERDR_TONE_LABELS, type HerdrDrawerTab, herdrToneFor } from '../herdrView.js';
import { questionProvenance } from '../questionProvenance.js';
import {
  type DrawerSubject,
  drawerSubjectKey,
  type OpenedSubject,
  pendingContract,
} from '../selection.js';
import { sessionStatusLabel, taskStatusLabel } from '../statusLabels.js';
import { AttemptRow } from './AttemptRow.js';
import { ContractPanel } from './ContractPanel.js';
import { HerdrPanel } from './HerdrPanel.js';
import { QuestionPanel } from './QuestionPanel.js';
import { SessionActions } from './SessionActions.js';
import { SessionBody } from './SessionBody.js';
import { TaskReport } from './TaskReport.js';
import { WorkspaceFileBrowser } from './WorkspaceFileBrowser.js';

export interface DetailDrawerProps {
  client: CompanyClient;
  state: CompanyViewState;
  /** What the drawer shows; null when nothing is open or selected. */
  subject: DrawerSubject | null;
  /** Every lane, so a task subject can show its board card. */
  lanes: readonly BoardLane[];
  artifactId: string | null;
  onOpen: (subject: OpenedSubject) => void;
  onOpenArtifact: (artifactId: string) => void;
  onClearArtifact: () => void;
  onClose: () => void;
  /** The herdr panel's tab, held by the board so a menu can open it on Thông tin. */
  herdrTab: HerdrDrawerTab;
  onHerdrTab: (tab: HerdrDrawerTab) => void;
}

type ContentProps = Omit<DetailDrawerProps, 'subject' | 'onClose'> & { subject: DrawerSubject };

export function DetailDrawer({ subject, onClose, ...rest }: DetailDrawerProps) {
  const subjectKey = subject === null ? null : drawerSubjectKey(subject);
  const [retained, setRetained] = useState<DrawerSubject | null>(subject);
  if (subject !== null && (retained === null || drawerSubjectKey(retained) !== subjectKey)) {
    setRetained(subject);
  }

  const open = subject !== null;
  useEffect(() => {
    if (open) return undefined;
    const timer = window.setTimeout(() => setRetained(null), COMPANY_DRAWER_SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  const [prefs, setPrefs] = useState<DrawerPrefs>(() => readDrawerPrefs(browserDrawerStorage()));
  const viewportWidth = useViewportWidth();
  const dragStart = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  // Every change is kept, so the width a reader dragged to is there on the next open.
  useEffect(() => {
    writeDrawerPrefs(browserDrawerStorage(), prefs);
  }, [prefs]);

  if (retained === null) return null;
  const heading = headingFor(rest.state, retained, rest.lanes);
  const width = clampDrawerWidth(prefs.width, viewportWidth);
  const limit = drawerWidthLimit(viewportWidth);
  const model = heading.session ? shortModelName(heading.session.model) : '';
  const motion = {
    transitionDuration: `${COMPANY_DRAWER_SLIDE_MS}ms`,
    animationDuration: `${COMPANY_DRAWER_SLIDE_MS}ms`,
  };
  // The drawer's width is a custom property, read by the company-drawer rules in index.css.
  const style = { ...motion, '--company-drawer-width': `${width}px` } as CSSProperties;

  function onGripPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = { pointerId: event.pointerId, x: event.clientX, width };
  }

  function onGripPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const start = dragStart.current;
    if (start === null || start.pointerId !== event.pointerId) return;
    // The handle sits on the drawer's left edge, so dragging left widens the drawer.
    const next = clampDrawerWidth(start.width + (start.x - event.clientX), viewportWidth);
    setPrefs((current) => ({ ...current, width: next }));
  }

  function onGripPointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    if (dragStart.current?.pointerId === event.pointerId) dragStart.current = null;
  }

  function onGripKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const next = drawerWidthForKey(width, event.key, event.shiftKey, viewportWidth);
    if (next === null) return;
    event.preventDefault();
    setPrefs((current) => ({ ...current, width: next }));
  }

  return (
    <aside
      aria-label="Chi tiết"
      aria-hidden={!open}
      data-testid="session-drawer"
      data-subject={retained.kind}
      data-maximized={prefs.maximized}
      style={style}
      className={`company-drawer absolute inset-y-0 right-0 z-30 flex flex-col border-l border-border bg-bg shadow-lg ${open ? 'company-drawer-in' : 'pointer-events-none translate-x-full'}`}
    >
      {!prefs.maximized && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Đổi kích thước khung chi tiết"
          aria-valuemin={COMPANY_DRAWER_MIN_WIDTH_PX}
          aria-valuemax={limit}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={onGripPointerDown}
          onPointerMove={onGripPointerMove}
          onPointerUp={onGripPointerUp}
          onPointerCancel={onGripPointerUp}
          onKeyDown={onGripKeyDown}
          className="company-drawer-grip"
        />
      )}
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="min-w-0 truncate text-lg font-semibold text-text">{heading.title}</h2>
          {heading.status && (
            <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-2xs text-text-muted">
              {heading.status}
            </span>
          )}
          {model !== '' && (
            <span
              className="min-w-0 truncate text-2xs text-text-muted"
              title={heading.session?.model}
            >
              {model}
            </span>
          )}
          {heading.session?.folder && <CopyFolderButton folder={heading.session.folder} />}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {heading.session && (
            <SessionActions
              client={rest.client}
              state={rest.state}
              sessionId={heading.session.id}
            />
          )}
          <button
            type="button"
            onClick={() => setPrefs((current) => ({ ...current, maximized: !current.maximized }))}
            aria-pressed={prefs.maximized}
            className="shrink-0 cursor-pointer rounded-[5px] border border-border px-2.5 py-1 text-2xs text-text-muted hover:border-accent hover:text-text"
          >
            {prefs.maximized ? 'thu nhỏ' : 'phóng to'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 cursor-pointer rounded-[5px] border border-border px-2.5 py-1 text-2xs text-text-muted hover:border-accent hover:text-text"
          >
            đóng
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <DrawerContent {...rest} subject={retained} />
      </div>
    </aside>
  );
}

function DrawerContent(props: ContentProps) {
  const { subject, client, state, lanes, artifactId, onOpen, onOpenArtifact, onClearArtifact } =
    props;
  switch (subject.kind) {
    case 'task':
      return (
        <TaskSubject
          client={client}
          state={state}
          lanes={lanes}
          taskId={subject.taskId}
          onOpenArtifact={onOpenArtifact}
          onOpenQuestion={(questionId) => onOpen({ kind: 'question', questionId })}
        />
      );
    case 'session':
      return (
        <SessionBody
          key={subject.sessionId}
          client={client}
          state={state}
          sessionId={subject.sessionId}
          taskId={null}
          onOpenArtifact={onOpenArtifact}
          onOpenQuestion={(questionId) => onOpen({ kind: 'question', questionId })}
        />
      );
    case 'herdr':
      return (
        <HerdrPanel
          client={client}
          state={state}
          paneId={subject.paneId}
          tab={props.herdrTab}
          onTabChange={props.onHerdrTab}
        />
      );
    case 'contract':
      return <ContractSubject client={client} state={state} />;
    case 'question':
      return <QuestionSubject client={client} state={state} questionId={subject.questionId} />;
    case 'files':
      return (
        <WorkspaceFileBrowser
          client={client}
          workspacePath={state.settings?.workspacePath ?? ''}
          artifactId={artifactId}
          onClearArtifact={onClearArtifact}
        />
      );
  }
}

/** The session a drawer header acts on, and what the header shows of it. */
interface HeaderSession {
  id: string;
  /** The model it runs: the effective one when the provider changed it, else the requested one. */
  model: string;
  /** The folder it works in, or null when nothing reports one. */
  folder: string | null;
}

interface Heading {
  title: string;
  status: string | null;
  /** The session in view, or null when the subject has none. */
  session: HeaderSession | null;
}

function headingFor(
  state: CompanyViewState,
  subject: DrawerSubject,
  lanes: readonly BoardLane[],
): Heading {
  switch (subject.kind) {
    case 'task': {
      const card = findCard(lanes, subject.taskId);
      if (card === undefined) return { title: 'Việc', status: null, session: null };
      return {
        title: `${card.code} · ${card.title}`,
        status: taskStatusLabel(card.status),
        session: headerSession(state, card.session?.id ?? null),
      };
    }
    case 'session': {
      const session = state.sessions[subject.sessionId];
      if (session === undefined) return { title: 'Phiên', status: null, session: null };
      return {
        title: session.name.trim() === '' ? session.code : `${session.code} · ${session.name}`,
        status: sessionStatusLabel(session.status),
        session: headerSession(state, subject.sessionId),
      };
    }
    case 'herdr': {
      const agent = state.herdr.agents.find((entry) => entry.paneId === subject.paneId);
      return {
        title: agent?.name ?? 'herdr',
        status: agent ? HERDR_TONE_LABELS[herdrToneFor(agent.status)] : null,
        session: null,
      };
    }
    case 'contract':
      return { title: 'Kế hoạch chờ duyệt', status: null, session: null };
    case 'question':
      return { title: 'Câu hỏi chờ trả lời', status: null, session: null };
    case 'files':
      return { title: 'Tệp trong workspace', status: null, session: null };
  }
}

/** What a header shows of a session: its model, and the folder it works in. */
function headerSession(state: CompanyViewState, sessionId: string | null): HeaderSession | null {
  if (sessionId === null) return null;
  const session = state.sessions[sessionId];
  if (session === undefined) return null;
  const info = state.sessionInfos[sessionId];
  // Until a session's info is collected, the workspace it was started in stands in for its folder.
  const folder = (info === undefined ? null : workingFolder(info)) ?? state.settings?.workspacePath;
  return {
    id: sessionId,
    model: session.effectiveModel || session.requestedModel,
    folder: folder || null,
  };
}

function findCard(lanes: readonly BoardLane[], taskId: string): BoardCard | undefined {
  return lanes.flatMap((lane) => lane.cards).find((card) => card.taskId === taskId);
}

function TaskSubject({
  client,
  state,
  lanes,
  taskId,
  onOpenArtifact,
  onOpenQuestion,
}: {
  client: CompanyClient;
  state: CompanyViewState;
  lanes: readonly BoardLane[];
  taskId: string;
  onOpenArtifact: (artifactId: string) => void;
  onOpenQuestion: (questionId: string) => void;
}) {
  const task = state.tasks[taskId];
  const card = findCard(lanes, taskId);
  if (task === undefined) {
    return <p className="p-2 text-2xs text-text-muted">Việc này không còn trong công ty nữa.</p>;
  }

  const sessionId = card?.session?.id ?? null;
  if (sessionId !== null) {
    return (
      <>
        {card && <TaskFacts card={card} />}
        <SessionBody
          key={`${sessionId}:${taskId}`}
          client={client}
          state={state}
          sessionId={sessionId}
          taskId={taskId}
          onOpenArtifact={onOpenArtifact}
          onOpenQuestion={onOpenQuestion}
        />
      </>
    );
  }

  const attempts = Object.values(state.attempts).filter((attempt) => attempt.taskId === taskId);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {card && <TaskFacts card={card} />}
      <div className="flex flex-col gap-2 p-2">
        {attempts.map((attempt) => (
          <AttemptRow
            key={attempt.id}
            attempt={attempt}
            evidence={state.evidence}
            onOpenArtifact={onOpenArtifact}
          />
        ))}
      </div>
      <TaskReport state={state} taskId={taskId} onOpenArtifact={onOpenArtifact} />
    </div>
  );
}

function TaskFacts({ card }: { card: BoardCard }) {
  return (
    <section className="m-2.5 flex flex-col gap-2 rounded-[6px] border border-border bg-bg-dark p-2.5 text-2xs">
      <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <dt className="text-text-muted">Trạng thái</dt>
        <dd className="text-text">{taskStatusLabel(card.status)}</dd>
        <dt className="text-text-muted">Hợp đồng</dt>
        <dd className="text-text">
          {card.contractCode} · {card.phaseTitle}
        </dd>
        {card.waitReason && (
          <>
            <dt className="text-text-muted">Đang chờ</dt>
            <dd className="text-warning">
              {card.waitReason === 'blocked_by_dependencies'
                ? `${WAIT_REASON_LABELS[card.waitReason]} (${card.blockedByCodes.join(', ')})`
                : WAIT_REASON_LABELS[card.waitReason]}
            </dd>
          </>
        )}
        {card.routeReason && (
          <>
            <dt className="text-text-muted">Lý do</dt>
            <dd className="italic text-text-muted">{card.routeReason}</dd>
          </>
        )}
      </dl>
      {card.session === null && <p className="text-text-muted">Chưa có phiên nào nhận việc này.</p>}
    </section>
  );
}

function ContractSubject({ client, state }: { client: CompanyClient; state: CompanyViewState }) {
  const contract = pendingContract(state);
  if (contract === null) {
    return <p className="p-3 text-2xs text-text-muted">Không còn kế hoạch nào chờ duyệt.</p>;
  }
  return (
    <ContractPanel
      contract={contract}
      verificationProfiles={state.settings?.verificationProfiles ?? {}}
      evidence={Object.values(state.evidence)}
      onApprove={(revision) => client.decideContract(contract.id, revision, 'approve')}
      onReject={(revision) => client.decideContract(contract.id, revision, 'reject')}
    />
  );
}

function QuestionSubject({
  client,
  state,
  questionId,
}: {
  client: CompanyClient;
  state: CompanyViewState;
  questionId: string;
}) {
  const question = state.questions[questionId];
  if (question === undefined || question.status !== 'pending') {
    return <p className="p-3 text-2xs text-text-muted">Câu hỏi này đã được xử lý.</p>;
  }
  return (
    <div className="p-2">
      <QuestionPanel
        question={question}
        onAnswer={(input) => client.answerQuestion(input)}
        provenance={questionProvenance(state.streams[question.sessionId])}
      />
    </div>
  );
}

/** The window's width, kept current: it bounds how wide the drawer may be. */
function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

/**
 * The webview's localStorage, or null when the host refuses access to it. A
 * refused store means the drawer simply does not remember its shape.
 */
function browserDrawerStorage(): DrawerStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

type CopyOutcome = 'idle' | 'copied' | 'failed';

const COPY_FEEDBACK_MS = 1500;

const COPY_OUTCOME_LABEL: Readonly<Record<CopyOutcome, string>> = {
  idle: 'Chép thư mục',
  copied: 'Đã chép',
  failed: 'Không chép được',
};

/** Copies the folder a session works in. Its full path sits in the title, not the header. */
function CopyFolderButton({ folder }: { folder: string }) {
  const [outcome, setOutcome] = useState<CopyOutcome>('idle');
  useEffect(() => {
    if (outcome === 'idle') return undefined;
    const timer = window.setTimeout(() => setOutcome('idle'), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [outcome]);

  async function copy(): Promise<void> {
    setOutcome((await copyText(folder)) ? 'copied' : 'failed');
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={folder}
      className="shrink-0 cursor-pointer rounded-[5px] border border-border px-2 py-0.5 text-2xs text-text-muted hover:border-accent hover:text-text"
    >
      {COPY_OUTCOME_LABEL[outcome]}
    </button>
  );
}
