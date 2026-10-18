/**
 * agentSidebarView: the sidebar's rows, grouped by role, as pure data.
 *
 * Every session the server knows appears under its role, and every herdr agent
 * under one herdr group. A row that waits on the user sorts first and never
 * sits in the parked group, so nothing waiting for a click is out of sight.
 */

import {
  COMPANY_HOST_ROLE_BY_ROLE,
  type CompanyRole,
  type CompanySessionSummary,
  type HerdrAgent,
  type RoleProfile,
} from '../../../core/src/company.js';
import type { CompanyViewState, HerdrView } from './companyState.js';
import { HERDR_TONE_LABELS, HERDR_TONE_RANK, type HerdrTone, herdrToneFor } from './herdrView.js';
import { COMPANY_ROLES, ROLE_LABELS, roleProfile } from './roleProfiles.js';
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

export interface AgentRow {
  sessionId: string;
  code: string;
  name: string;
  tone: AgentTone;
  /** True when the row waits on the user: a pending question or waiting_input. */
  needsYou: boolean;
  /** The short status word the row prints beside its dot. */
  label: string;
  /** "CODE · title" of the task the session holds, or null when it holds none. */
  taskLine: string | null;
}

export interface AgentRoleGroup {
  role: CompanyRole;
  label: string;
  /** The host role that runs this role's agents (plan, advisor, task or default). */
  hostRole: string;
  profile: RoleProfile | null;
  /** Live rows, with the ones waiting on the user first. */
  active: AgentRow[];
  /** Parked, paused, stopped and archived rows, collapsed under "Tạm trữ". */
  parked: AgentRow[];
}

export interface HerdrRow {
  paneId: string;
  kind: string;
  name: string;
  tone: HerdrTone;
  label: string;
  /** The agent's title, or its working directory, whichever is known. */
  detail: string | null;
}

export type HerdrGroup =
  | { kind: 'hidden' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'ready'; rows: HerdrRow[] };

/** Sessions with a pending question: each one is waiting on the user. */
export function pendingQuestionSessionIds(state: CompanyViewState): Set<string> {
  const ids = new Set<string>();
  for (const question of Object.values(state.questions)) {
    if (question.status === 'pending') ids.add(question.sessionId);
  }
  return ids;
}

export function buildAgentGroups(state: CompanyViewState): AgentRoleGroup[] {
  const questioning = pendingQuestionSessionIds(state);
  const sessions = Object.values(state.sessions);
  return COMPANY_ROLES.map((role) => {
    const rows = sessions
      .filter((session) => session.role === role)
      .map((session) => agentRow(state, session, questioning.has(session.id)))
      .sort(compareAgentRows);
    return {
      role,
      label: ROLE_LABELS[role],
      hostRole: COMPANY_HOST_ROLE_BY_ROLE[role],
      profile: roleProfile(state, role),
      active: rows.filter((row) => row.tone !== 'parked'),
      parked: rows.filter((row) => row.tone === 'parked'),
    };
  });
}

function agentRow(
  state: CompanyViewState,
  session: CompanySessionSummary,
  questionPending: boolean,
): AgentRow {
  const tone: AgentTone =
    questionPending || session.status === 'waiting_input'
      ? 'needs'
      : (TONE_BY_SESSION_STATUS[session.status] ?? 'idle');
  const task = session.activeTaskId === undefined ? undefined : state.tasks[session.activeTaskId];
  return {
    sessionId: session.id,
    code: session.code,
    name: session.name,
    tone,
    needsYou: tone === 'needs',
    label: agentLabel(tone, session.status),
    taskLine: task === undefined ? null : `${task.code} · ${task.title}`,
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

export function herdrGroup(herdr: HerdrView): HerdrGroup {
  if (!herdr.loaded) return { kind: 'hidden' };
  if (!herdr.available) {
    return {
      kind: 'unavailable',
      message:
        herdr.reason === null ? 'herdr không khả dụng.' : `herdr không khả dụng: ${herdr.reason}`,
    };
  }
  const rows = herdr.agents
    .map(herdrRowFor)
    .sort(
      (left, right) =>
        HERDR_TONE_RANK[left.tone] - HERDR_TONE_RANK[right.tone] ||
        left.name.localeCompare(right.name, 'en', { numeric: true }),
    );
  return { kind: 'ready', rows };
}

function herdrRowFor(agent: HerdrAgent): HerdrRow {
  const tone = herdrToneFor(agent.status);
  return {
    paneId: agent.paneId,
    kind: agent.kind,
    name: agent.name ?? agent.kind,
    tone,
    label: HERDR_TONE_LABELS[tone],
    detail: agent.title ?? agent.cwd ?? null,
  };
}
