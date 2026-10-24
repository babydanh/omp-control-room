/**
 * DetailDrawer: the one thing the user has open, slid in from the right.
 *
 * It shows a board subject (a task, a session, a herdr agent) or something
 * opened from the board or the sidebar: the contract to decide, a question, the
 * workspace files. Its header keeps the title, the status and a close control;
 * every other action is in the menu the header opens on a right-click or the
 * menu key, and a double-click on the header toggles maximize. Closing slides
 * it away. The last subject stays mounted until the slide ends, so the content
 * does not blank mid-motion.
 */

import {
  type CSSProperties,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from 'react';

import type { WorkItemAssignee } from '../../../../core/src/messages.js';
import {
  type AgentMenuRequest,
  type AgentMenuSubject,
  agentMenuTriggers,
  type DrawerView,
  type WorkItemMenuAction,
} from '../agentMenu.js';
import { sleepingName } from '../agentSidebarView.js';
import type { BoardCard, BoardLane } from '../boardView.js';
import { WAIT_REASON_LABELS } from '../boardView.js';
import type { CompanyClient } from '../companyClient.js';
import type { CompanyDrawerTab, CompanyViewState } from '../companyState.js';
import { COMPANY_DRAWER_MIN_WIDTH_PX, COMPANY_MOTION } from '../constants.js';
import {
  clampDrawerWidth,
  type DrawerPrefs,
  drawerWidthForKey,
  drawerWidthLimit,
  effectiveDrawerWidth,
  rememberedOrChatWidth,
} from '../drawerPrefs.js';
import { HERDR_TONE_LABELS, type HerdrDrawerTab, herdrToneFor } from '../herdrView.js';
import { drawerPresentation, layoutModeFor } from '../layoutMode.js';
import { questionProvenance } from '../questionProvenance.js';
import {
  type DrawerSubject,
  drawerSubjectKey,
  type OpenedSubject,
  pendingContract,
} from '../selection.js';
import { terminalPolicy } from '../sessionActions.js';
import { findSquadRun, squadRunKey, squadStatusLabel } from '../squadView.js';
import { contractStatusLabel, sessionStatusLabel, taskStatusLabel } from '../statusLabels.js';
import { useViewportWidth } from '../useLayoutMode.js';
import { findWorkItem, statusWordVi, workItemCardHead, workItemKey } from '../workItemView.js';
import { WrapLinesContext } from '../wrapLines.js';
import { AttemptRow } from './AttemptRow.js';
import { ContractPanel } from './ContractPanel.js';
import { HerdrPanel } from './HerdrPanel.js';
import { Icon } from './Icon.js';
import { QuestionPanel } from './QuestionPanel.js';
import { SessionBody } from './SessionBody.js';
import { SleepingPanel } from './SleepingPanel.js';
import { SquadRunPanel } from './SquadRunPanel.js';
import { TaskReport } from './TaskReport.js';
import { WorkItemPanel } from './WorkItemPanel.js';
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
  /** Shows a board session in the drawer on one tab, as the agent menu's tab items do. */
  onOpenSessionTab: (sessionId: string, tab: CompanyDrawerTab) => void;
  onOpenArtifact: (artifactId: string) => void;
  onClearArtifact: () => void;
  onClose: () => void;
  /** The herdr panel's tab, held by the board so a menu can open it on Chi tiết. */
  herdrTab: HerdrDrawerTab;
  onHerdrTab: (tab: HerdrDrawerTab) => void;
  /** The tab the reader last picked for a session; null until they pick one. */
  sessionTab: CompanyDrawerTab | null;
  onSessionTab: (tab: CompanyDrawerTab) => void;
  /** The drawer's remembered shape: its width and whether it is maximized. */
  prefs: DrawerPrefs;
  onPrefsChange: Dispatch<SetStateAction<DrawerPrefs>>;
  /** The width the agent sidebar takes beside the board; 0 when it floats over the board. */
  sidebarWidth: number;
  /** Opens the menu the header's subject offers. */
  onMenu: (request: AgentMenuRequest) => void;
  workItemAction: {
    action: Exclude<WorkItemMenuAction, 'open'>;
    token: number;
  } | null;
  onWorkItemActionHandled: (token: number) => void;
}

type ContentProps = Omit<
  DetailDrawerProps,
  'subject' | 'prefs' | 'onPrefsChange' | 'sidebarWidth'
> & {
  subject: DrawerSubject;
};

export function DetailDrawer({
  subject,
  onClose,
  prefs,
  onPrefsChange,
  sidebarWidth,
  ...rest
}: DetailDrawerProps) {
  const subjectKey = subject === null ? null : drawerSubjectKey(subject);
  const [retained, setRetained] = useState<DrawerSubject | null>(subject);
  if (subject !== null && (retained === null || drawerSubjectKey(retained) !== subjectKey)) {
    setRetained(subject);
  }

  const open = subject !== null;
  useEffect(() => {
    if (open) return undefined;
    const timer = window.setTimeout(() => setRetained(null), COMPANY_MOTION.drawerSlideMs);
    return () => window.clearTimeout(timer);
  }, [open]);

  const viewportWidth = useViewportWidth();
  const mode = layoutModeFor(viewportWidth);
  // The board is what the viewport leaves beside the sidebar; the drawer takes its width from that.
  const boardWidth = Math.max(0, viewportWidth - sidebarWidth);
  const dragStart = useRef<{ pointerId: number; x: number; width: number } | null>(null);

  if (retained === null) return null;
  const heading = headingFor(rest.state, retained, rest.lanes);
  const liveSessionId =
    retained.kind === 'session'
      ? retained.sessionId
      : retained.kind === 'task'
        ? (rest.state.tasks[retained.taskId]?.sessionId ?? null)
        : null;
  const liveChat =
    liveSessionId !== null &&
    terminalPolicy(rest.state.sessions[liveSessionId]?.status ?? '').attach;
  const width = effectiveDrawerWidth(
    rememberedOrChatWidth(prefs.width, liveChat, boardWidth),
    boardWidth,
  );
  const limit = drawerWidthLimit(boardWidth);
  const presentation = drawerPresentation(mode, prefs.maximized);
  const wrapToggleShown =
    retained.kind === 'task' || retained.kind === 'session' || retained.kind === 'herdr';
  const menuSubject = drawerMenuSubject(rest.lanes, retained, prefs.maximized);
  const headerTriggers =
    menuSubject === null ? null : agentMenuTriggers<HTMLElement>(menuSubject, rest.onMenu);
  const motion = {
    transitionDuration: `${COMPANY_MOTION.drawerSlideMs}ms`,
    animationDuration: `${COMPANY_MOTION.drawerSlideMs}ms`,
  };
  // The drawer's width and slide easing are custom properties that index.css reads.
  const style = {
    ...motion,
    '--company-drawer-width': `${width}px`,
    '--company-ease': COMPANY_MOTION.easing,
  } as CSSProperties;

  function onGripPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = { pointerId: event.pointerId, x: event.clientX, width };
  }

  function onGripPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const start = dragStart.current;
    if (start === null || start.pointerId !== event.pointerId) return;
    // The handle sits on the drawer's left edge, so dragging left widens the drawer.
    const next = clampDrawerWidth(start.width + (start.x - event.clientX), boardWidth);
    onPrefsChange((current) => ({ ...current, width: next }));
  }

  function onGripPointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    if (dragStart.current?.pointerId === event.pointerId) dragStart.current = null;
  }

  function onGripKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const next = drawerWidthForKey(width, event.key, event.shiftKey, boardWidth);
    if (next === null) return;
    event.preventDefault();
    onPrefsChange((current) => ({ ...current, width: next }));
  }

  return (
    <aside
      aria-label="Chi tiết"
      aria-hidden={!open}
      data-testid="session-drawer"
      data-subject={retained.kind}
      data-maximized={prefs.maximized}
      data-presentation={presentation}
      style={style}
      className={`company-drawer z-30 flex min-w-0 flex-col border-l border-hairline bg-panel ${open ? 'company-drawer-in' : 'pointer-events-none translate-x-full'}`}
    >
      {presentation === 'docked' && (
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
      <header
        data-testid="drawer-header"
        onDoubleClick={() =>
          onPrefsChange((current) => ({ ...current, maximized: !current.maximized }))
        }
        {...(headerTriggers ?? {})}
        className="flex select-none items-center gap-3 px-3.5 py-2.5"
      >
        {presentation === 'fullscreen' && (
          <button
            type="button"
            onClick={onClose}
            onDoubleClick={(event) => event.stopPropagation()}
            aria-label="Quay lại danh sách"
            className="company-btn company-btn-ghost touch-target shrink-0 px-2 text-sm"
          >
            <Icon name="chevron-left" className="mr-1" />
            Quay lại
          </button>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h2 className="min-w-0 truncate text-[15px] font-semibold leading-snug text-text">
            {heading.title}
          </h2>
          {heading.status && (
            <span className="shrink-0 rounded-full bg-raised px-2 py-0.5 text-2xs text-text-muted">
              {heading.status}
            </span>
          )}
        </div>
        {presentation !== 'fullscreen' && (
          <button
            type="button"
            onClick={onClose}
            onDoubleClick={(event) => event.stopPropagation()}
            aria-label="Đóng chi tiết"
            title="Đóng"
            className="company-btn company-btn-ghost touch-target shrink-0 px-1.5 text-sm"
          >
            <Icon name="close" />
          </button>
        )}
      </header>
      {wrapToggleShown && (
        <div className="flex justify-end px-3.5 py-1">
          <button
            type="button"
            aria-pressed={!prefs.wrapLines}
            title="Giữ nguyên chiều rộng dòng và cuộn ngang khi dòng dài"
            onClick={() =>
              onPrefsChange((current) => ({ ...current, wrapLines: !current.wrapLines }))
            }
            className="company-toggle touch-target"
          >
            Không ngắt dòng
          </button>
        </div>
      )}
      <WrapLinesContext.Provider value={prefs.wrapLines}>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <DrawerContent {...rest} subject={retained} onClose={onClose} />
        </div>
      </WrapLinesContext.Provider>
    </aside>
  );
}

function DrawerContent(props: ContentProps) {
  const { subject, client, state, lanes, artifactId, onOpen, onOpenArtifact, onClearArtifact } =
    props;
  // Opens the session an item runs in: a herdr pane's live screen (its log), a sleeping pane's
  // wake panel, or a board session's terminal.
  const openHolder = (assignee: WorkItemAssignee): void => {
    const paneId = assignee.kind === 'herdr' ? (assignee.paneId ?? '') : '';
    if (paneId !== '' && state.herdrRoster.sleeping.some((entry) => entry.paneId === paneId)) {
      onOpen({ kind: 'sleeping', paneId });
    } else if (paneId !== '') {
      onOpen({ kind: 'herdr', paneId });
      props.onHerdrTab('screen');
      client.select({ herdrPaneId: paneId });
    } else if (assignee.kind === 'session' && assignee.sessionId) {
      props.onOpenSessionTab(assignee.sessionId, 'terminal');
    }
  };
  switch (subject.kind) {
    case 'task':
      return (
        <TaskSubject
          client={client}
          state={state}
          lanes={lanes}
          sessionTab={props.sessionTab}
          onSessionTab={props.onSessionTab}
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
          rememberedTab={props.sessionTab}
          onRememberTab={props.onSessionTab}
          onOpenArtifact={onOpenArtifact}
          onOpenQuestion={(questionId) => onOpen({ kind: 'question', questionId })}
        />
      );
    case 'herdr':
      return (
        <HerdrPanel
          key={subject.paneId}
          client={client}
          state={state}
          paneId={subject.paneId}
          tab={props.herdrTab}
          onTabChange={props.onHerdrTab}
        />
      );
    case 'sleeping':
      return (
        <SleepingPanel
          key={subject.paneId}
          client={client}
          state={state}
          paneId={subject.paneId}
          onClose={props.onClose}
        />
      );
    case 'contract':
      return <ContractSubject client={client} state={state} contractId={subject.contractId} />;
    case 'question':
      return <QuestionSubject client={client} state={state} questionId={subject.questionId} />;
    case 'workItem':
      return (
        <WorkItemPanel
          key={workItemKey(subject)}
          client={client}
          state={state}
          workspacePath={subject.workspacePath}
          id={subject.id}
          actionRequest={props.workItemAction}
          onActionHandled={props.onWorkItemActionHandled}
          onOpenHolder={openHolder}
        />
      );
    case 'squad':
      return (
        <SquadRunPanel
          key={squadRunKey(subject)}
          client={client}
          state={state}
          workspacePath={subject.workspacePath}
          runId={subject.runId}
          onRemoved={props.onClose}
          onOpenWorkItem={(id) => onOpen({ kind: 'workItem', id, workspacePath: subject.workspacePath })}
          onOpenHolder={openHolder}
        />
      );
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

/** The title and status a drawer header shows for its subject. */
interface Heading {
  title: string;
  status: string | null;
}

function headingFor(
  state: CompanyViewState,
  subject: DrawerSubject,
  lanes: readonly BoardLane[],
): Heading {
  switch (subject.kind) {
    case 'task': {
      const card = findCard(lanes, subject.taskId);
      if (card === undefined) return { title: 'Việc', status: null };
      return { title: `${card.code} · ${card.title}`, status: taskStatusLabel(card.status) };
    }
    case 'session': {
      const session = state.sessions[subject.sessionId];
      if (session === undefined) return { title: 'Phiên', status: null };
      return {
        title: session.name.trim() === '' ? session.code : `${session.code} · ${session.name}`,
        status: sessionStatusLabel(session.status),
      };
    }
    case 'herdr': {
      const agent = state.herdr.agents.find((entry) => entry.paneId === subject.paneId);
      return {
        title: agent?.name ?? 'herdr',
        status: agent ? HERDR_TONE_LABELS[herdrToneFor(agent.status)] : null,
      };
    }
    case 'sleeping': {
      const session = state.herdr.sleeping.find((entry) => entry.paneId === subject.paneId);
      if (session === undefined) return { title: 'Phiên ngủ đông', status: null };
      return { title: sleepingName(session), status: 'Ngủ đông' };
    }
    case 'contract': {
      if (subject.contractId === null) return { title: 'Kế hoạch chờ duyệt', status: null };
      const contract = state.contracts[subject.contractId];
      if (contract === undefined) return { title: 'Kế hoạch', status: null };
      return { title: `Kế hoạch ${contract.code}`, status: contractStatusLabel(contract.status) };
    }
    case 'question':
      return { title: 'Câu hỏi chờ trả lời', status: null };
    case 'workItem': {
      const item = findWorkItem(state, subject);
      if (item === undefined) return { title: 'Việc', status: null };
      const head = workItemCardHead(item.text);
      return { title: head === '' ? 'Việc' : head, status: statusWordVi(item.status) };
    }
    case 'squad': {
      const run = findSquadRun(state, subject);
      if (run === undefined) return { title: 'Đội', status: null };
      const head = workItemCardHead(run.request);
      return { title: head === '' ? 'Đội' : head, status: squadStatusLabel(run.status) };
    }
    case 'files':
      return { title: 'Tệp trong workspace', status: null };
  }
}

/**
 * The menu a drawer header opens: the subject the drawer shows, carrying the
 * drawer's own state. A contract, a question, the files or a work item have no menu.
 */
function drawerMenuSubject(
  lanes: readonly BoardLane[],
  subject: DrawerSubject,
  maximized: boolean,
): AgentMenuSubject | null {
  const drawer: DrawerView = { maximized };
  switch (subject.kind) {
    case 'task':
      return {
        kind: 'task',
        taskId: subject.taskId,
        sessionId: findCard(lanes, subject.taskId)?.session?.id ?? null,
        drawer,
      };
    case 'session':
      return { kind: 'session', sessionId: subject.sessionId, drawer };
    case 'herdr':
      return { kind: 'herdr', paneId: subject.paneId, drawer };
    case 'sleeping':
      return { kind: 'sleeping', paneId: subject.paneId, drawer };
    case 'contract':
    case 'question':
    case 'files':
    case 'workItem':
    case 'squad':
      return null;
  }
}

function findCard(lanes: readonly BoardLane[], taskId: string): BoardCard | undefined {
  return lanes.flatMap((lane) => lane.cards).find((card) => card.taskId === taskId);
}

function TaskSubject({
  client,
  state,
  lanes,
  taskId,
  sessionTab,
  onSessionTab,
  onOpenArtifact,
  onOpenQuestion,
}: {
  client: CompanyClient;
  state: CompanyViewState;
  lanes: readonly BoardLane[];
  taskId: string;
  sessionTab: CompanyDrawerTab | null;
  onSessionTab: (tab: CompanyDrawerTab) => void;
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
      <SessionBody
        key={`${sessionId}:${taskId}`}
        client={client}
        state={state}
        sessionId={sessionId}
        taskId={taskId}
        tasksHeader={card ? <TaskFacts card={card} /> : undefined}
        rememberedTab={sessionTab}
        onRememberTab={onSessionTab}
        onOpenArtifact={onOpenArtifact}
        onOpenQuestion={onOpenQuestion}
      />
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
    <section className="m-2.5 flex flex-col gap-2 rounded-(--company-radius-md) bg-raised p-2.5 text-2xs">
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

function ContractSubject({
  client,
  state,
  contractId,
}: {
  client: CompanyClient;
  state: CompanyViewState;
  contractId: string | null;
}) {
  const contract =
    contractId === null ? pendingContract(state) : (state.contracts[contractId] ?? null);
  if (contract === null) {
    return (
      <p className="p-3 text-2xs text-text-muted">
        {contractId === null
          ? 'Không còn kế hoạch nào chờ duyệt.'
          : 'Kế hoạch này không còn trên bảng.'}
      </p>
    );
  }
  // Only a plan that awaits the user's decision offers the decision; any other plan reads on its own.
  const decidable = contract.status === 'awaiting_approval';
  return (
    <ContractPanel
      contract={contract}
      verificationProfiles={state.settings?.verificationProfiles ?? {}}
      evidence={Object.values(state.evidence)}
      onApprove={
        decidable
          ? (revision) => client.decideContract(contract.id, revision, 'approve')
          : undefined
      }
      onReject={
        decidable ? (revision) => client.decideContract(contract.id, revision, 'reject') : undefined
      }
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
