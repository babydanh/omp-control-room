/**
 * sessionRemoval: which sessions a bulk cleanup may delete, and how a run of
 * deletes is sent and reported.
 *
 * The planner reads the same folded rows the sidebar draws, so the cleanup never
 * offers a session the sidebar would not show as folded. The runner sends one
 * delete, waits for its verdict, and only then sends the next: the server judges
 * each delete against the state the previous one left, and a refusal does not stop
 * the rest.
 */

import { type AgentRoleGroup, pendingQuestionSessionIds } from './agentSidebarView.js';
import { type CommandResultView, failureNotice } from './commandResults.js';
import type { CompanyClient } from './companyClient.js';
import type { CompanyViewState } from './companyState.js';
import { REFUSED_NOTICE, sessionHoldsWork } from './sessionActions.js';

/**
 * The sessions one role's cleanup may delete: folded in the sidebar, crashed, with no
 * task attached and no work held. A crash that interrupted a task stays in view.
 */
export function removableErroredSessionIds(
  state: CompanyViewState,
  group: AgentRoleGroup,
): string[] {
  const questioning = pendingQuestionSessionIds(state);
  const ids: string[] = [];
  for (const row of group.parked) {
    if (row.tone !== 'error' || row.taskLine !== null) continue;
    const session = state.sessions[row.sessionId];
    if (session === undefined || session.activeTaskId !== undefined) continue;
    if (sessionHoldsWork(session, questioning.has(session.id))) continue;
    ids.push(session.id);
  }
  return ids;
}

/**
 * Delete one session and wait for the server's verdict. A successful delete of the
 * selected session clears the selection, so the drawer does not show a session that
 * is gone.
 */
export async function deleteSession(
  client: CompanyClient,
  sessionId: string,
): Promise<CommandResultView> {
  const verdict = await client.waitForCommand(client.controlSession(sessionId, 'delete'));
  if (verdict.ok && client.getState().selection.sessionId === sessionId) {
    client.select({ sessionId: null });
  }
  return verdict;
}

/** What a run of deletes did: how many went, and the distinct refusals with their reasons. */
export interface RemovalReport {
  deleted: number;
  refused: number;
  messages: string[];
}

/**
 * Delete the sessions one after another. Each delete is sent only once the previous
 * verdict is held. A refusal is counted and the rest still go. A dropped socket fails
 * each remaining send at once, and those are counted the same way.
 */
export async function deleteSessionsInOrder(
  client: CompanyClient,
  sessionIds: readonly string[],
): Promise<RemovalReport> {
  const report: RemovalReport = { deleted: 0, refused: 0, messages: [] };
  for (const sessionId of sessionIds) {
    const verdict = await deleteSession(client, sessionId);
    if (verdict.ok) {
      report.deleted += 1;
      continue;
    }
    report.refused += 1;
    const message = failureNotice(verdict, REFUSED_NOTICE);
    if (message !== null && !report.messages.includes(message)) report.messages.push(message);
  }
  return report;
}

/** The line the sidebar shows after a run: what went, and what was refused and why. */
export function removalNotice(report: RemovalReport): string {
  const head = `Đã xoá ${report.deleted} phiên; ${report.refused} phiên bị từ chối`;
  return report.messages.length === 0 ? `${head}.` : `${head}: ${report.messages.join(' ')}`;
}
