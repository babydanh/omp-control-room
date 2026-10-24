/**
 * agentBoard: the agents the board shows as cards beside the company's tasks.
 *
 * A herdr pane, or a company session that holds no task, is an agent with work
 * of its own. The board lists the ones that are moving or waiting on the user,
 * each in the lane its status names: working in Đang làm, blocked on the user in
 * Chờ bạn, finished in Xong. An idle agent is not a card, because an idle pane is
 * a place to start work, not work in progress.
 *
 * Two kinds of agent never get a card of their own:
 *  - a session or herdr pane that already holds a task, plans a prompt or runs a
 *    work item: that card speaks for it, and listing it twice would miscount; a
 *    pane whose item is finished is left out only while it reads "done" too;
 *  - a crashed session: every board restart leaves its earlier runs crashed, and
 *    the sidebar folds them for that reason. Herdr has no error status at all,
 *    so no pane reaches Lỗi either.
 *
 * Pure and DOM-free; the board renders these and the tests read them.
 */

import type { CompanySessionSummary, HerdrAgent } from '../../../core/src/company.js';
import type { CompanySessionLogEntry } from '../../../core/src/messages.js';
import type { AgentTone } from './agentSidebarView.js';
import { herdrSummary, pendingQuestionSessionIds, repoPlacement } from './agentSidebarView.js';
import type { CompanyViewState, HerdrScreenView, HerdrView } from './companyState.js';
import type { CompanyLaneId } from './constants.js';
import { HERDR_TONE_LABELS, type HerdrTone, herdrToneFor } from './herdrView.js';
import { companyRoleLabel } from './roleProfiles.js';
import { screenActivityLine } from './screenActivity.js';
import { sessionStatusLabel } from './statusLabels.js';
import { parseAnsiScreen } from './terminalScreen.js';

/** What an agent card stands for: a herdr pane, or a company session. */
export type AgentCardSubject =
  { kind: 'herdr'; paneId: string } | { kind: 'session'; sessionId: string };

export interface AgentBoardCard {
  /** Stable identity across renders: the React key and the flight key. */
  key: string;
  subject: AgentCardSubject;
  lane: CompanyLaneId;
  /** The status dot's tone: a herdr tone for a pane, a session tone for a session. */
  tone: AgentTone | HerdrTone;
  /** The small tag: "herdr" for a pane, the role's label for a session. */
  tag: string;
  /** The repo, workspace or folder a pane works in; the session code for a session. */
  project: string;
  /** One line: the pane's title or folder, or the session's name. */
  title: string;
  /** The status word the card prints. */
  statusLabel: string;
  /** The git branch a pane works on; null when herdr reported none, and for a session. */
  branch: string | null;
  /** The git checkout a pane works in (herdr's worktree root), whose changes the card counts; null when unknown, and for a session. */
  checkout: string | null;
  /** The line the agent is doing now, from its screen or log; null when neither shows one. */
  activity: string | null;
  /** When the agent last changed, as an ISO time; null when none is known. */
  updatedAt: string | null;
}

/**
 * The lane an agent's tone shows in. Idle, error and parked tones have no lane
 * here, so they are not cards.
 */
function laneForTone(tone: AgentTone | HerdrTone): CompanyLaneId | null {
  switch (tone) {
    case 'working':
      return 'running';
    case 'needs':
      return 'needs_input';
    case 'done':
      return 'done';
    default:
      return null;
  }
}

/** The tone a company session shows; null when the session is not live work. */
function sessionTone(
  session: CompanySessionSummary,
  questioning: ReadonlySet<string>,
): AgentTone | null {
  if (questioning.has(session.id)) return 'needs';
  if (session.status === 'starting' || session.status === 'busy') return 'working';
  if (session.status === 'waiting_input') return 'needs';
  return null;
}

/** Collapse a line to single spaces and bound its length for a card. */
function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

/** A pane's activity line from its screen text; null when herdr has sent no screen. */
function paneActivity(text: string | undefined): string | null {
  if (text === undefined) return null;
  const plain = parseAnsiScreen(text).map((line) => line.map((segment) => segment.text).join(''));
  return screenActivityLine(plain);
}

/** A session's newest logged line of text, collapsed; null when no entry has text. */
function latestLogLine(entries: readonly CompanySessionLogEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry: CompanySessionLogEntry | undefined = entries[i];
    const line = collapseSpaces(entry?.text ?? '');
    if (line !== '') return line;
  }
  return null;
}

function herdrCard(agent: HerdrAgent, screen: HerdrScreenView | undefined): AgentBoardCard | null {
  const tone = herdrToneFor(agent.status);
  const lane = laneForTone(tone);
  if (lane === null) return null;
  return {
    key: `herdr:${agent.paneId}`,
    subject: { kind: 'herdr', paneId: agent.paneId },
    lane,
    tone,
    tag: 'herdr',
    project: repoPlacement(agent).label,
    title: herdrSummary(agent.title, agent.cwd)?.text ?? `${agent.kind} · ${agent.paneId}`,
    statusLabel: HERDR_TONE_LABELS[tone],
    branch: agent.branch || null,
    checkout: agent.worktreeRoot || null,
    activity: paneActivity(screen?.text),
    updatedAt: screen?.at ?? null,
  };
}

function sessionCard(
  session: CompanySessionSummary,
  questioning: ReadonlySet<string>,
  entries: readonly CompanySessionLogEntry[],
): AgentBoardCard | null {
  const tone = sessionTone(session, questioning);
  const lane = tone === null ? null : laneForTone(tone);
  if (tone === null || lane === null) return null;
  return {
    key: `session:${session.id}`,
    subject: { kind: 'session', sessionId: session.id },
    lane,
    tone,
    tag: companyRoleLabel(session.role),
    project: session.code,
    title: session.name,
    statusLabel: tone === 'needs' ? HERDR_TONE_LABELS.needs : sessionStatusLabel(session.status),
    branch: null,
    checkout: null,
    activity: latestLogLine(entries),
    updatedAt: session.lastUsedAt,
  };
}

/**
 * Herdr panes first, then company sessions; within each kind, by project and
 * then by identity, so the same board reads the same way on every render.
 */
function compareAgentCards(left: AgentBoardCard, right: AgentBoardCard): number {
  if (left.subject.kind !== right.subject.kind) {
    return left.subject.kind === 'herdr' ? -1 : 1;
  }
  return (
    left.project.localeCompare(right.project, 'en', { numeric: true }) ||
    left.key.localeCompare(right.key, 'en', { numeric: true })
  );
}

function herdrCards(
  herdr: HerdrView,
  carded: ReadonlySet<string>,
  finishedPanes: ReadonlySet<string>,
): AgentBoardCard[] {
  if (!herdr.loaded || !herdr.available) return [];
  const cards: AgentBoardCard[] = [];
  for (const agent of herdr.agents) {
    if (carded.has(agent.paneId)) continue;
    const card = herdrCard(agent, herdr.screens[agent.paneId]);
    if (card === null || (card.lane === 'done' && finishedPanes.has(agent.paneId))) continue;
    cards.push(card);
  }
  return cards;
}

/**
 * The agent cards for the board, sorted. `carded` holds the session ids and pane ids a task, a
 * planning card or a live work item already shows; `finishedPanes` the panes of finished items,
 * left out while they read "done". Both are left out here.
 */
export function buildAgentCards(
  state: CompanyViewState,
  carded: ReadonlySet<string>,
  finishedPanes: ReadonlySet<string> = new Set(),
): AgentBoardCard[] {
  const questioning = pendingQuestionSessionIds(state);
  const cards = herdrCards(state.herdr, carded, finishedPanes);
  for (const session of Object.values(state.sessions)) {
    if (carded.has(session.id)) continue;
    const card = sessionCard(session, questioning, state.sessionLogs[session.id]?.entries ?? []);
    if (card !== null) cards.push(card);
  }
  return cards.sort(compareAgentCards);
}
