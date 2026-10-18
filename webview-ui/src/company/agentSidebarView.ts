/**
 * agentSidebarView: the sidebar's rows, the herdr repo groups, the rail's
 * entries and the header counts, as pure data.
 *
 * Every session the server knows appears under its role, and every herdr agent
 * under one repo group. A row that waits on the user sorts first and never sits
 * in the parked group, so nothing waiting for a click is out of sight. The rail
 * is the same model reduced to one badge per agent, so collapsing the sidebar
 * never drops an agent from view.
 */

import {
  COMPANY_HOST_ROLE_BY_ROLE,
  type CompanyRole,
  type CompanySessionLogEntry,
  type CompanySessionSummary,
  type HerdrAgent,
  type RoleProfile,
} from '../../../core/src/company.js';
import type { CompanyViewState, HerdrView } from './companyState.js';
import { HERDR_TONE_LABELS, HERDR_TONE_RANK, type HerdrTone, herdrToneFor } from './herdrView.js';
import { COMPANY_ROLES, ROLE_LABELS, roleProfile } from './roleProfiles.js';
import { type LogTone, logTone, splitCommandText } from './sessionLogView.js';
import { sessionStatusLabel } from './statusLabels.js';

/** How a session row looks, in the terms the sidebar draws. */
export type AgentTone = 'working' | 'needs' | 'idle' | 'error' | 'parked';

const TONE_BY_SESSION_STATUS: Readonly<Record<string, AgentTone>> = {
  starting: 'working',
  busy: 'working',
  waiting_input: 'needs',
  idle: 'idle',
  pausing: 'idle',
  stopping: 'idle',
  crashed: 'error',
  parked: 'parked',
  paused: 'parked',
  stopped: 'parked',
  archived: 'parked',
};

/** The most characters a one-line summary keeps; the row truncates the rest on screen. */
const ONE_LINE_MAX_CHARS = 240;

const MINUTE_MS = 60_000;

/** The glyph a summary line is printed with, by the colour family its log kind reads as. */
const LOG_GLYPH_BY_TONE: Readonly<Record<LogTone, string>> = {
  text: '›',
  tool: '◦',
  command: '$',
  ok: '✓',
  fail: '✗',
  ask: '?',
  state: '·',
};

/** One line of what an agent is doing: an optional glyph, the text, and how old it is. */
export interface SummaryLine {
  /** Printed before the text; empty when the text is plain. */
  glyph: string;
  /** Already collapsed to one line and bounded. */
  text: string;
  /** How long ago a timed entry happened ("2 phút trước"); null when the source has no time. */
  age: string | null;
}

export interface AgentRow {
  sessionId: string;
  role: CompanyRole;
  code: string;
  name: string;
  tone: AgentTone;
  /** True when the row waits on the user: a pending question or waiting_input. */
  needsYou: boolean;
  /** The short status word the row prints beside its dot. */
  label: string;
  /** "CODE · title" of the task the session holds, or null when it holds none. */
  taskLine: string | null;
  /** What the session is doing, in one line; null when nothing is known yet. */
  summary: SummaryLine | null;
}

export interface AgentRoleGroup {
  role: CompanyRole;
  label: string;
  /** The host role that runs this role's agents (plan, advisor, task or default). */
  hostRole: string;
  profile: RoleProfile | null;
  /** Live rows, with the ones waiting on the user first. */
  active: AgentRow[];
  /**
   * Parked, paused, stopped and archived rows, collapsed under "Tạm trữ", plus
   * crashed rows that hold no task: every board restart leaves its previous
   * runs crashed, and listing each of them among the live agents buried the
   * ones actually working. A crash that interrupted a task stays in view.
   */
  parked: AgentRow[];
}

/** Where a herdr agent belongs: its repository, else its workspace, else its folder. */
export interface RepoPlacement {
  /** Stable identity; the source is part of it, so a repo and a workspace of one name stay apart. */
  key: string;
  label: string;
  source: 'repo' | 'workspace' | 'folder' | 'other';
}

export interface HerdrRow {
  paneId: string;
  kind: string;
  name: string;
  tone: HerdrTone;
  label: string;
  /** The git branch, shown as a chip; null when herdr reported none. */
  branch: string | null;
  /** The worktree's root folder, shown in the tooltip; null when unknown. */
  worktreeRoot: string | null;
  /** The pane's terminal title, else its working directory. */
  summary: SummaryLine | null;
  repo: RepoPlacement;
}

export interface HerdrRepoGroup {
  key: string;
  label: string;
  source: RepoPlacement['source'];
  rows: HerdrRow[];
}

export type HerdrGroup =
  | { kind: 'hidden' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'ready'; repos: HerdrRepoGroup[] };

/** One thing the collapsed rail draws, top to bottom. */
export type RailEntry =
  | { kind: 'session'; row: AgentRow }
  | { kind: 'pane'; row: HerdrRow }
  | { kind: 'repo'; key: string; label: string }
  | { kind: 'parked'; count: number }
  | { kind: 'break' };

/** How many agents are in each live state, companies and herdr together. */
export interface ActivityCounts {
  working: number;
  needs: number;
  idle: number;
  error: number;
}

/** The words the header and the rail print beside each count. */
export const ACTIVITY_LABELS: Readonly<Record<keyof ActivityCounts, string>> = {
  working: HERDR_TONE_LABELS.working,
  needs: HERDR_TONE_LABELS.needs,
  idle: HERDR_TONE_LABELS.idle,
  error: 'lỗi',
};

/** Sessions with a pending question: each one is waiting on the user. */
export function pendingQuestionSessionIds(state: CompanyViewState): Set<string> {
  const ids = new Set<string>();
  for (const question of Object.values(state.questions)) {
    if (question.status === 'pending') ids.add(question.sessionId);
  }
  return ids;
}

/** `now` is epoch milliseconds, injected so the relative times are testable. */
export function buildAgentGroups(state: CompanyViewState, now: number): AgentRoleGroup[] {
  const questioning = pendingQuestionSessionIds(state);
  const sessions = Object.values(state.sessions);
  return COMPANY_ROLES.map((role) => {
    const rows = sessions
      .filter((session) => session.role === role)
      .map((session) => agentRow(state, session, questioning.has(session.id), now))
      .sort(compareAgentRows);
    return {
      role,
      label: ROLE_LABELS[role],
      hostRole: COMPANY_HOST_ROLE_BY_ROLE[role],
      profile: roleProfile(state, role),
      active: rows.filter((row) => !isFolded(row)),
      parked: rows.filter(isFolded),
    };
  });
}

function isFolded(row: AgentRow): boolean {
  return row.tone === 'parked' || (row.tone === 'error' && row.taskLine === null);
}

function sessionTone(status: string, questionPending: boolean): AgentTone {
  if (questionPending || status === 'waiting_input') return 'needs';
  return TONE_BY_SESSION_STATUS[status] ?? 'idle';
}

function agentRow(
  state: CompanyViewState,
  session: CompanySessionSummary,
  questionPending: boolean,
  now: number,
): AgentRow {
  const tone = sessionTone(session.status, questionPending);
  const task = session.activeTaskId === undefined ? undefined : state.tasks[session.activeTaskId];
  const taskLine = task === undefined ? null : `${task.code} · ${task.title}`;
  const stream = state.streams[session.id];
  return {
    sessionId: session.id,
    role: session.role,
    code: session.code,
    name: session.name,
    tone,
    needsYou: tone === 'needs',
    label: agentLabel(tone, session.status),
    taskLine,
    summary: companySummary({
      entries: state.sessionLogs[session.id]?.entries ?? [],
      // A live excerpt belongs to the run it streamed in; an older run's text is not news.
      excerpt: stream !== undefined && stream.runEpoch === session.runEpoch ? stream.excerpt : null,
      streaming: tone === 'working',
      taskLine,
      now,
    }),
  };
}

function agentLabel(tone: AgentTone, status: string): string {
  if (tone === 'needs') return 'chờ bạn';
  if (tone === 'error') return 'lỗi';
  if (status === 'idle') return 'rảnh';
  return sessionStatusLabel(status);
}

/** Rows that need the user come first; the rest sort by session code. */
function compareAgentRows(left: AgentRow, right: AgentRow): number {
  if (left.needsYou !== right.needsYou) return left.needsYou ? -1 : 1;
  return left.code.localeCompare(right.code, 'en', { numeric: true });
}

/**
 * Live sessions whose log the board has not received yet. The sidebar asks the
 * server for each of them once, so a row after a reload can show its latest line.
 */
export function sessionIdsNeedingLog(state: CompanyViewState): string[] {
  return Object.values(state.sessions)
    .filter((session) => sessionTone(session.status, false) !== 'parked')
    .filter((session) => state.sessionLogs[session.id] === undefined)
    .map((session) => session.id);
}

/** What a company session row falls back on, in order, when the log has no line. */
export interface CompanySummaryInput {
  /** The session's log, oldest first. */
  entries: readonly CompanySessionLogEntry[];
  /** The live text excerpt of the current run, or null when it has streamed none. */
  excerpt: string | null;
  /** True while the session is working: only then is a live excerpt the freshest word. */
  streaming: boolean;
  taskLine: string | null;
  now: number;
}

/**
 * The one line a company session row shows: its latest log entry that has text;
 * else, while the session is streaming, the live excerpt; else the task it holds.
 * Null when none of those exists yet.
 */
export function companySummary(input: CompanySummaryInput): SummaryLine | null {
  const logged = latestLogLine(input.entries, input.now);
  if (logged !== null) return logged;
  const excerpt = oneLine(input.excerpt ?? '');
  if (input.streaming && excerpt !== '') {
    return { glyph: LOG_GLYPH_BY_TONE.text, text: excerpt, age: null };
  }
  const task = oneLine(input.taskLine ?? '');
  return task === '' ? null : { glyph: '', text: task, age: null };
}

/** The newest log entry that has a line of text, as a summary; null when none does. */
export function latestLogLine(
  entries: readonly CompanySessionLogEntry[],
  now: number,
): SummaryLine | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries.at(index);
    if (entry === undefined) continue;
    const text = oneLine(
      entry.kind === 'command' ? splitCommandText(entry.text).command : entry.text,
    );
    if (text !== '') {
      return { glyph: LOG_GLYPH_BY_TONE[logTone(entry)], text, age: relativeTimeVi(entry.at, now) };
    }
  }
  return null;
}

/**
 * The summary a herdr agent shows: the pane's terminal title, else its working
 * directory. Braille spinner frames are dropped from the title, since a working
 * agent's title carries one; the rest of the title is kept. Null when herdr
 * reported neither.
 */
export function herdrSummary(
  title: string | undefined,
  cwd: string | undefined,
): SummaryLine | null {
  const titleText = oneLine((title ?? '').replace(/[\u2800-\u28FF]/g, ' '));
  if (titleText !== '') return { glyph: '', text: titleText, age: null };
  const folder = oneLine(cwd ?? '');
  return folder === '' ? null : { glyph: '', text: folder, age: null };
}

/**
 * How long ago `at` was, in Vietnamese, measured against `now`. A moment that is
 * not yet past reads as just now. Null when `at` is not a time.
 */
export function relativeTimeVi(at: string, now: number): string | null {
  const then = Date.parse(at);
  if (Number.isNaN(then)) return null;
  const minutes = Math.floor((now - then) / MINUTE_MS);
  if (minutes < 1) return 'vừa xong';
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.floor(hours / 24)} ngày trước`;
}

/** Collapses a text to one bounded line, so a long message costs one row of DOM. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= ONE_LINE_MAX_CHARS) return flat;
  return Array.from(flat).slice(0, ONE_LINE_MAX_CHARS).join('');
}

/** The header and rail counts: company rows and herdr agents, by what they need. */
export function activityCounts(
  groups: readonly AgentRoleGroup[],
  herdr: HerdrGroup,
): ActivityCounts {
  const counts: ActivityCounts = { working: 0, needs: 0, idle: 0, error: 0 };
  for (const group of groups) {
    for (const row of group.active) countTone(counts, row.tone);
  }
  if (herdr.kind === 'ready') {
    for (const repo of herdr.repos) {
      for (const row of repo.rows) countTone(counts, row.tone);
    }
  }
  return counts;
}

/** Only the four live states are counted; parked, done and unknown agents are not. */
function countTone(counts: ActivityCounts, tone: AgentTone | HerdrTone): void {
  if (tone === 'working' || tone === 'needs' || tone === 'idle' || tone === 'error') {
    counts[tone] += 1;
  }
}

/**
 * The rail, top to bottom: sessions that wait on the user first, then each
 * role's other live sessions in role order, then one "+N" badge for every parked
 * session, then the herdr repos. A break separates each block that has entries;
 * a repo tag opens each repo's panes.
 */
export function buildRail(groups: readonly AgentRoleGroup[], herdr: HerdrGroup): RailEntry[] {
  const blocks: RailEntry[][] = [];
  const waiting = groups.flatMap((group) => group.active.filter((row) => row.needsYou));
  if (waiting.length > 0) {
    blocks.push(waiting.map((row): RailEntry => ({ kind: 'session', row })));
  }
  for (const group of groups) {
    const rows = group.active.filter((row) => !row.needsYou);
    if (rows.length > 0) {
      blocks.push(rows.map((row): RailEntry => ({ kind: 'session', row })));
    }
  }
  const parked = groups.reduce((sum, group) => sum + group.parked.length, 0);
  if (parked > 0) blocks.push([{ kind: 'parked', count: parked }]);
  if (herdr.kind === 'ready' && herdr.repos.length > 0) {
    blocks.push(herdr.repos.flatMap(repoEntries));
  }
  const separator: RailEntry = { kind: 'break' };
  return blocks.flatMap((block, index): RailEntry[] =>
    index === 0 ? block : [separator, ...block],
  );
}

function repoEntries(repo: HerdrRepoGroup): RailEntry[] {
  const header: RailEntry = { kind: 'repo', key: repo.key, label: repo.label };
  return [header, ...repo.rows.map((row): RailEntry => ({ kind: 'pane', row }))];
}

/** "PA-S0002" reads as "S2": the session's letter and its number, without zero padding. */
export function sessionShortCode(code: string): string {
  const match = /([A-Za-z])0*(\d+)$/.exec(code);
  return match === null ? code.slice(0, 4) : `${match[1]}${match[2]}`;
}

/** A herdr pane reads as its number; a pane id without one shows its first characters. */
export function paneShortCode(paneId: string): string {
  const match = /(\d+)$/.exec(paneId);
  return match === null ? paneId.slice(0, 4) : String(Number(match[1]));
}

/** A tooltip's parts, joined by middots; empty parts are left out. */
function joinTooltip(parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null && part !== '').join(' · ');
}

/** "text · age" for a timed summary, the text alone otherwise. */
export function summaryText(summary: SummaryLine | null): string | null {
  if (summary === null) return null;
  return summary.age === null ? summary.text : `${summary.text} · ${summary.age}`;
}

/** A company row's tooltip, and the rail badge's: name, status word, task, summary. */
export function agentTooltip(row: AgentRow): string {
  return joinTooltip([row.name, row.label, row.taskLine, summaryText(row.summary)]);
}

/** A herdr row's tooltip: pane, status word, summary, then the worktree it works in. */
export function herdrTooltip(row: HerdrRow): string {
  return joinTooltip([
    `${row.kind} · ${row.paneId}`,
    row.label,
    summaryText(row.summary),
    row.worktreeRoot === null ? null : `worktree: ${row.worktreeRoot}`,
  ]);
}

export function herdrGroup(herdr: HerdrView): HerdrGroup {
  if (!herdr.loaded) return { kind: 'hidden' };
  if (!herdr.available) {
    return {
      kind: 'unavailable',
      message:
        herdr.reason === null ? 'herdr không khả dụng.' : `herdr không khả dụng: ${herdr.reason}`,
    };
  }
  const rows = herdr.agents.map(herdrRowFor).sort(compareHerdrRows);
  return { kind: 'ready', repos: groupByRepo(rows) };
}

/** How many herdr agents the group holds. */
export function herdrRowCount(herdr: HerdrGroup): number {
  return herdr.kind === 'ready' ? herdr.repos.reduce((sum, repo) => sum + repo.rows.length, 0) : 0;
}

/** What needs the user first, then what is moving, then the rest; ties read by name. */
function compareHerdrRows(left: HerdrRow, right: HerdrRow): number {
  return (
    HERDR_TONE_RANK[left.tone] - HERDR_TONE_RANK[right.tone] ||
    left.name.localeCompare(right.name, 'en', { numeric: true })
  );
}

/**
 * Groups rows that are already sorted, so each group sits where its most urgent
 * agent sorts: a repo with an agent that needs the user comes first.
 */
function groupByRepo(rows: readonly HerdrRow[]): HerdrRepoGroup[] {
  const groups = new Map<string, HerdrRepoGroup>();
  for (const row of rows) {
    const existing = groups.get(row.repo.key);
    if (existing !== undefined) {
      existing.rows.push(row);
      continue;
    }
    groups.set(row.repo.key, {
      key: row.repo.key,
      label: row.repo.label,
      source: row.repo.source,
      rows: [row],
    });
  }
  return [...groups.values()];
}

function herdrRowFor(agent: HerdrAgent): HerdrRow {
  const tone = herdrToneFor(agent.status);
  return {
    paneId: agent.paneId,
    kind: agent.kind,
    name: agent.name ?? agent.kind,
    tone,
    label: HERDR_TONE_LABELS[tone],
    branch: nonEmpty(agent.branch),
    worktreeRoot: nonEmpty(agent.worktreeRoot),
    summary: herdrSummary(agent.title, agent.cwd),
    repo: repoPlacement(agent),
  };
}

/**
 * The group an agent sits in: its git repository; an agent without one goes
 * under its workspace; without that, under its folder's name.
 */
export function repoPlacement(
  agent: Pick<HerdrAgent, 'repo' | 'workspaceLabel' | 'cwd'>,
): RepoPlacement {
  const repo = nonEmpty(agent.repo);
  if (repo !== null) return { key: `repo:${repo}`, label: repo, source: 'repo' };
  const workspace = nonEmpty(agent.workspaceLabel);
  if (workspace !== null) {
    return { key: `workspace:${workspace}`, label: workspace, source: 'workspace' };
  }
  const folder = folderName(agent.cwd);
  if (folder !== null) return { key: `folder:${folder}`, label: folder, source: 'folder' };
  return { key: 'other', label: 'khác', source: 'other' };
}

/** The last folder of a path, separators either way; null when there is no path. */
function folderName(cwd: string | undefined): string | null {
  const path = nonEmpty(cwd);
  if (path === null) return null;
  const parts = path.split(/[\\/]+/).filter((part) => part !== '');
  return parts.at(-1) ?? path;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}
