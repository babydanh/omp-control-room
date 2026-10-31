import type { CompanySessionSummary, ProjectTreeNode } from '../../../../core/src/messages.js';
import { contextOccupancy } from '../usageView.js';

export type ContextTone = 'calm' | 'warn' | 'error';

const WARN_FROM = 0.7;
const ERROR_FROM = 0.9;

/** The "ctx 62%" chip on an agent row; null when the session reports no context. */
export function contextChip(occupancy: number | null): { readonly text: string; readonly tone: ContextTone } | null {
  if (occupancy === null || !Number.isFinite(occupancy)) return null;
  const share = Math.min(1, Math.max(0, occupancy));
  const tone = share >= ERROR_FROM ? 'error' : share >= WARN_FROM ? 'warn' : 'calm';
  return { text: `ctx ${Math.round(share * 100)}%`, tone };
}

/** The context share of the board session behind a tree node; null for a node with none (a herdr pane, a cloud row). */
export function contextOfNode(
  node: Pick<ProjectTreeNode, 'boardSessionId' | 'sessionId'>,
  sessions: Readonly<Record<string, CompanySessionSummary>>,
): number | null {
  // A node that names its board session reads only that one: its own session id may be a herdr pane's.
  const id = node.boardSessionId ?? node.sessionId;
  const session = id === undefined ? undefined : sessions[id];
  return session === undefined ? null : contextOccupancy(session);
}
