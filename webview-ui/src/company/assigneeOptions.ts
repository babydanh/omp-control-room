/**
 * assigneeOptions: who a work item can be given to, as the picker lists them. Pure data.
 *
 * A folder's options are, in order: the herdr agents tagged with that folder, its omp sessions
 * that can still take work, then the option that opens a new omp session. A herdr agent is listed
 * whatever its status: the server queues work for a busy agent rather than refusing it.
 */

import type {
  CompanySessionSummary,
  HerdrAgent,
  WorkItemAssignee,
} from '../../../core/src/messages.js';
import type { CompanyViewState } from './companyState.js';
import { samePath } from './folderView.js';

export interface AssigneeOption {
  /** Stable for one assignee: herdr/session ids, new-session, auto, claude, or agy. */
  key: string;
  assignee: WorkItemAssignee;
  /** The name the picker shows. */
  label: string;
  /** A second line the picker may show: a repo and branch, a folder, or a session code. */
  detail?: string;
  group: 'auto' | 'herdr' | 'session' | 'new' | 'claude' | 'agy';
}

/** The label of the option that opens a new omp session. */
export const NEW_SESSION_LABEL = 'Phiên omp mới';

/** The assignee that leaves the agent to be picked when the item runs. The picker offers it first. */
export const AUTO_ASSIGNEE: WorkItemAssignee = { kind: 'auto' };

/** The assignee that hands the item to Claude Code, which runs it with `claude -p`. */
export const CLAUDE_ASSIGNEE: WorkItemAssignee = { kind: 'claude' };

/** The picker row for Claude Code. The assign dialog lists it beside the auto row. */
export const CLAUDE_OPTION: AssigneeOption = {
  key: assigneeKeyOf(CLAUDE_ASSIGNEE),
  assignee: CLAUDE_ASSIGNEE,
  label: 'Claude Code (claude -p)',
  group: 'claude',
};

/** The assignee that runs the item with Antigravity CLI. */
export const AGY_ASSIGNEE: WorkItemAssignee = { kind: 'agy' };

/** The picker row for Antigravity CLI. */
export const AGY_OPTION: AssigneeOption = {
  key: assigneeKeyOf(AGY_ASSIGNEE),
  assignee: AGY_ASSIGNEE,
  label: 'agy (Antigravity)',
  group: 'agy',
};

/** Session states that cannot take work: the session is archived, stopped or has crashed. */
const CLOSED_SESSION_STATUSES: Record<string, true> = {
  archived: true,
  stopped: true,
  crashed: true,
};

/** Whether a session in `status` can be given work. */
export function sessionAcceptsWork(status: string): boolean {
  return CLOSED_SESSION_STATUSES[status] !== true;
}

/** The key an assignee is listed under, and matched by when a picker preselects one. */
export function assigneeKeyOf(assignee: WorkItemAssignee): string {
  switch (assignee.kind) {
    case 'herdr':
      return `herdr:${assignee.paneId ?? ''}`;
    case 'session':
      return `session:${assignee.sessionId ?? ''}`;
    case 'new-session':
      return 'new-session';
    case 'auto':
      return 'auto';
    case 'claude':
      return 'claude';
    case 'agy':
      return 'agy';
  }
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** A herdr agent's name on the board: its name, else its terminal title, else its pane id. */
export function herdrAgentLabel(agent: Pick<HerdrAgent, 'paneId' | 'name' | 'title'>): string {
  return nonEmpty(agent.name) ?? nonEmpty(agent.title) ?? agent.paneId;
}

/** An omp session's name on the board, else its code. */
export function sessionLabelOf(session: Pick<CompanySessionSummary, 'name' | 'code'>): string {
  return nonEmpty(session.name) ?? session.code;
}

/** A herdr agent's second line: its repo and branch when it has one, else its folder. */
function herdrDetail(agent: HerdrAgent): string | undefined {
  const repo = nonEmpty(agent.repo);
  if (repo !== null) {
    const branch = nonEmpty(agent.branch);
    return branch === null ? repo : `${repo} · ${branch}`;
  }
  return nonEmpty(agent.cwd) ?? undefined;
}

/** Herdr agents the server tags with `workspacePath`. An agent tagged with no folder is in none. */
function herdrOptions(state: CompanyViewState, workspacePath: string): AssigneeOption[] {
  return state.herdrRoster.agents
    .filter(
      (agent) => agent.workspacePath !== undefined && samePath(agent.workspacePath, workspacePath),
    )
    .map((agent): AssigneeOption => {
      const assignee: WorkItemAssignee = { kind: 'herdr', paneId: agent.paneId };
      const detail = herdrDetail(agent);
      return {
        key: assigneeKeyOf(assignee),
        assignee,
        label: herdrAgentLabel(agent),
        group: 'herdr',
        ...(detail === undefined ? {} : { detail }),
      };
    });
}

/** The omp sessions of `workspacePath` that can take work, by code. */
function sessionOptions(state: CompanyViewState, workspacePath: string): AssigneeOption[] {
  return Object.entries(state.folders)
    .filter(([path]) => samePath(path, workspacePath))
    .flatMap(([, scope]) => Object.values(scope.sessions))
    .filter((session) => sessionAcceptsWork(session.status))
    .sort((left, right) => left.code.localeCompare(right.code))
    .map((session): AssigneeOption => {
      const assignee: WorkItemAssignee = { kind: 'session', sessionId: session.id };
      return {
        key: assigneeKeyOf(assignee),
        assignee,
        label: sessionLabelOf(session),
        detail: session.code,
        group: 'session',
      };
    });
}

/**
 * Who work can be given to in `workspacePath`, in picker order. The new-session option is always
 * last.
 */
export function assigneeOptionsFor(
  state: CompanyViewState,
  workspacePath: string,
): AssigneeOption[] {
  const newSession: WorkItemAssignee = { kind: 'new-session' };
  return [
    ...herdrOptions(state, workspacePath),
    ...sessionOptions(state, workspacePath),
    {
      key: assigneeKeyOf(newSession),
      assignee: newSession,
      label: NEW_SESSION_LABEL,
      group: 'new',
    },
  ];
}
