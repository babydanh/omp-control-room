/**
 * Who manages each checkout: the omp sessions and herdr panes working in it, as chips.
 * Pure. A ledger session belongs to the checkout it last touched (its checkout, else its
 * folder). A herdr pane belongs to the checkout that holds its folder, so a pane in a
 * subfolder lands on its worktree. A herdr pane carries no session id, so it cannot be
 * proven to be the same agent as a ledger session: both appear, and neither is hidden.
 */

import type {
  HerdrAgent,
  HerdrSleepingSession,
  LedgerSession,
} from '../../../../core/src/messages.js';
import { paneShortCode } from '../agentSidebarView.js';
import {
  formatRelativeTime,
  parseLedgerTimestamp,
  presenceLabel,
  sessionTitle,
} from './ledgerFormat.js';
import { boardSessionFor, type BoardSessionIndex } from './ledgerMapping.js';
import { normalizeCheckoutPath } from './ledgerSelection.js';

/** Closed sessions and sleeping panes stay listed this long, and at most ENDED_LIMIT per checkout. */
export const ENDED_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ENDED_LIMIT = 2;

/** `waiting` needs the user; `active` runs; `idle` is open and at rest; `ended` is closed or asleep. */
export type ManagerDot = 'waiting' | 'active' | 'idle' | 'ended';

export type ManagerAction =
  | { readonly kind: 'board'; readonly boardKey: string }
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'herdr'; readonly paneId: string }
  | { readonly kind: 'sleeping'; readonly paneId: string };

export interface ManagerChip {
  readonly key: string;
  readonly label: string;
  readonly agentKind: 'omp' | 'sub' | 'claude' | 'agy' | 'herdr' | 'board';
  readonly dot: ManagerDot;
  /** What the dot means, in words, so colour is never the only signal. */
  readonly state: string;
  readonly detail: string | null;
  readonly age: string | null;
  readonly flag: string | null;
  readonly action: ManagerAction;
}

/** A herdr pane, live or asleep, in the shape the chips need. */
export interface PaneInput {
  readonly paneId: string;
  readonly kind: string;
  readonly status: 'working' | 'blocked' | 'idle' | 'done' | 'unknown' | 'sleeping';
  /** The folder the pane runs in: its worktree root when known, else its cwd. */
  readonly location: string | null;
  readonly title: string | null;
  readonly sleptAt: string | null;
}

export interface ManagerInput {
  /** Normalized checkout paths of one repo. */
  readonly checkouts: readonly string[];
  readonly sessions: readonly LedgerSession[];
  readonly panes: readonly PaneInput[];
  readonly boardSessions: BoardSessionIndex;
  readonly generatedAt: string;
}

interface Entry {
  readonly chip: ManagerChip;
  readonly atMs: number;
}

const PANE_STATE: Readonly<Record<PaneInput['status'], string>> = {
  working: 'đang làm',
  blocked: 'đang chờ bạn',
  idle: 'đang rảnh',
  done: 'đã xong',
  unknown: 'chưa rõ',
  sleeping: 'đang ngủ',
};

const PANE_DOT: Readonly<Record<PaneInput['status'], ManagerDot>> = {
  working: 'active',
  blocked: 'waiting',
  idle: 'idle',
  done: 'idle',
  unknown: 'idle',
  sleeping: 'ended',
};

const DOT_RANK: Readonly<Record<ManagerDot, number>> = { waiting: 0, active: 1, idle: 2, ended: 3 };

export function panesOf(
  agents: readonly HerdrAgent[],
  sleeping: readonly HerdrSleepingSession[],
): PaneInput[] {
  return [
    ...agents.map((agent): PaneInput => ({
      paneId: agent.paneId,
      kind: agent.kind,
      status: agent.status,
      location: agent.worktreeRoot ?? agent.cwd ?? null,
      title: agent.title ?? null,
      sleptAt: null,
    })),
    ...sleeping.map((session): PaneInput => ({
      paneId: session.paneId,
      kind: 'Đã ngủ',
      status: 'sleeping',
      location: session.worktreeRoot ?? session.cwd ?? null,
      title: session.title,
      sleptAt: session.sleptAt,
    })),
  ];
}

/** The checkout (one of `keys`, normalized) that holds `location`; the longest match wins. */
export function checkoutOf(location: string, keys: readonly string[]): string | null {
  const here = normalizeCheckoutPath(location).replace(/\/+$/, '');
  let best: string | null = null;
  for (const key of keys) {
    const root = key.replace(/\/+$/, '');
    const inside = here === root || here.startsWith(`${root}/`);
    if (inside && (best === null || key.length > best.length)) best = key;
  }
  return best;
}

/** The latest call in each checkout, across its sessions, ended ones included, in ms. */
export function sessionActivityByCheckout(
  sessions: readonly LedgerSession[],
  keys: readonly string[],
): Map<string, number> {
  const latest = new Map<string, number>();
  for (const session of sessions) {
    const home = checkoutOf(session.checkout ?? session.cwd, keys);
    const at = parseLedgerTimestamp(session.lastCallAt);
    if (home === null || at === null) continue;
    latest.set(home, Math.max(latest.get(home) ?? at, at));
  }
  return latest;
}

export type ManagerAgentKind = ManagerChip['agentKind'];

export function normalizeAgentKind(agentKind: string): ManagerAgentKind {
  const kind = agentKind.toLowerCase();
  if (kind === 'sub') return 'sub';
  if (kind.includes('claude')) return 'claude';
  if (kind.includes('agy')) return 'agy';
  if (kind.includes('herdr')) return 'herdr';
  if (kind.includes('board')) return 'board';
  return 'omp';
}

export function filterManagerChips(
  managers: readonly ManagerChip[],
  agentKind: ManagerAgentKind | 'all',
): ManagerChip[] {
  return agentKind === 'all' ? [...managers] : managers.filter((manager) => manager.agentKind === agentKind);
}
/** The chips of every checkout in `input.checkouts`, most urgent first. */
export function managersByCheckout(input: ManagerInput): Map<string, ManagerChip[]> {
  const nowMs = parseLedgerTimestamp(input.generatedAt);
  const entries = new Map<string, Entry[]>(input.checkouts.map((key) => [key, []]));
  for (const session of input.sessions) {
    const home = checkoutOf(session.checkout ?? session.cwd, input.checkouts);
    if (home === null || !isListed(session.open, session.lastCallAt, nowMs)) continue;
    entries.get(home)?.push(sessionEntry(session, input));
  }
  for (const pane of input.panes) {
    const home = pane.location === null ? null : checkoutOf(pane.location, input.checkouts);
    const live = pane.status !== 'sleeping';
    if (home === null || !isListed(live, pane.sleptAt, nowMs)) continue;
    entries.get(home)?.push(paneEntry(pane, input.generatedAt));
  }
  return new Map(
    Array.from(entries, ([key, list]): [string, ManagerChip[]] => [key, orderChips(list)]),
  );
}

/** Open things always show; closed ones show while they are recent. */
function isListed(open: boolean, ts: string | null, nowMs: number | null): boolean {
  if (open) return true;
  const at = parseLedgerTimestamp(ts);
  if (at === null) return false;
  return nowMs === null || nowMs - at <= ENDED_WINDOW_MS;
}

function orderChips(list: readonly Entry[]): ManagerChip[] {
  const sorted = [...list].sort(
    (left, right) => DOT_RANK[left.chip.dot] - DOT_RANK[right.chip.dot] || right.atMs - left.atMs,
  );
  const chips: ManagerChip[] = [];
  let ended = 0;
  for (const entry of sorted) {
    if (entry.chip.dot === 'ended') {
      ended += 1;
      if (ended > ENDED_LIMIT) continue;
    }
    chips.push(entry.chip);
  }
  return chips;
}

function sessionEntry(session: LedgerSession, input: ManagerInput): Entry {
  const boardKey = boardSessionFor(session.sessionId, input.boardSessions);
  const boardLabel = boardKey === null ? undefined : input.boardSessions[boardKey]?.label;
  const dot: ManagerDot = !session.open
    ? 'ended'
    : session.spamming
      ? 'waiting'
      : session.live
        ? 'active'
        : 'idle';
  return {
    atMs: parseLedgerTimestamp(session.lastCallAt) ?? 0,
    chip: {
      key: `session:${session.sessionId}`,
      label: boardLabel ?? sessionTitle(session),
      agentKind: normalizeAgentKind(session.agentKind),
      dot,
      state: presenceLabel(session),
      detail: session.lastIntent === null ? null : `đang: ${session.lastIntent}`,
      age:
        session.lastCallAt === null
          ? null
          : formatRelativeTime(session.lastCallAt, input.generatedAt),
      flag: session.spamming ? `Spam: ${session.spamReason ?? 'gọi công cụ quá dày'}` : null,
      action:
        boardKey === null
          ? { kind: 'session', sessionId: session.sessionId }
          : { kind: 'board', boardKey },
    },
  };
}

function paneEntry(pane: PaneInput, generatedAt: string): Entry {
  const sleeping = pane.status === 'sleeping';
  const title = (pane.title ?? '')
    .replace(/[\u2800-\u28FF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    atMs: parseLedgerTimestamp(pane.sleptAt) ?? 0,
    chip: {
      key: `pane:${pane.paneId}`,
      label: `${pane.kind} ${paneShortCode(pane.paneId)}`,
      agentKind: 'herdr',
      dot: PANE_DOT[pane.status],
      state: PANE_STATE[pane.status],
      detail: title === '' ? null : title,
      age: pane.sleptAt === null ? null : formatRelativeTime(pane.sleptAt, generatedAt),
      flag: null,
      action: sleeping
        ? { kind: 'sleeping', paneId: pane.paneId }
        : { kind: 'herdr', paneId: pane.paneId },
    },
  };
}
