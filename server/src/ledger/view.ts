/**
 * View assembly: pure. Turns ledger rows, git scans and overlap scans into the
 * LedgerView the board renders. The business rules live here: what counts as
 * live, which worktree a session sits in, which notices and main writes show.
 */

import type {
  LedgerDatabaseStatus,
  LedgerMainWrite,
  LedgerOverlapScan,
  LedgerRepo,
  LedgerSession,
  LedgerUnscannedFolder,
  LedgerView,
} from '../../../core/src/messages.js';
import {
  LEDGER_CALLS_LONG_MS,
  LEDGER_CALLS_SHORT_MS,
  LEDGER_DAY_MS,
  LEDGER_DEFAULT_AGENT_KIND,
  LEDGER_MAIN_WRITES_MAX,
  LEDGER_NOTICE_CONTENT_MAX,
  LEDGER_NOTICES_MAX,
  LEDGER_PENDING_MAX,
  LEDGER_SESSION_LIVE_MS,
  LEDGER_SESSIONS_MAX,
  LEDGER_SPAM_RULE,
} from './constants.js';
import type { GitRepoScan } from './git.js';
import type { EventRow, NoticeRow, PendingRow, SessionRow } from './ledgerDb.js';
import { ledgerBasename, ledgerPathKey, normalizeLedgerPath } from './ledgerPath.js';
import { formatLedgerTime, newestFirst, parseLedgerTime } from './ledgerTime.js';
import { evaluateSpam, type SpamCall } from './spam.js';

export interface LedgerRepoInput {
  readonly repo: string;
  readonly scan: GitRepoScan;
}

export interface LedgerViewInput {
  readonly nowMs: number;
  readonly database: LedgerDatabaseStatus;
  readonly sessions: readonly SessionRow[];
  /** Events from the last day, every kind. */
  readonly events: readonly EventRow[];
  readonly pending: readonly PendingRow[];
  readonly notices: readonly NoticeRow[];
  /** Events from the last day that are main-checkout edits or writes. */
  readonly mainWrites: readonly EventRow[];
  readonly repos: readonly LedgerRepoInput[];
  readonly overlaps: readonly LedgerOverlapScan[];
  /** The open Company folder per repo or checkout path (keyed by ledgerPathKey), for the ones inside one. */
  readonly folderOf?: ReadonlyMap<string, string>;
}

export function buildLedgerView(input: LedgerViewInput): LedgerView {
  const eventsBySession = groupBySession(input.events);
  const sessions = input.sessions
    .slice(0, LEDGER_SESSIONS_MAX)
    .map((row) => sessionView(row, eventsBySession.get(row.sessionId) ?? [], input.nowMs));
  const sessionsByCheckout = openSessionsByCheckout(sessions);
  const folderOf = input.folderOf ?? new Map<string, string>();

  const repos: LedgerRepo[] = [];
  const unscannedFolders: LedgerUnscannedFolder[] = [];
  for (const entry of input.repos) {
    const repo = normalizeLedgerPath(entry.repo);
    const repoFolder = inFolder(folderOf, repo);
    if (entry.scan.kind === 'not-repo') {
      unscannedFolders.push({ path: repo, ...repoFolder });
      continue;
    }
    repos.push({
      repo,
      name: ledgerBasename(repo),
      ...repoFolder,
      worktrees: entry.scan.worktrees.map((worktree) => ({
        ...worktree,
        ...inFolder(folderOf, worktree.path),
        sessionIds: sessionsByCheckout.get(ledgerPathKey(worktree.path)) ?? [],
      })),
    });
  }

  return {
    generatedAt: formatLedgerTime(input.nowMs),
    database: input.database,
    repos,
    unscannedFolders,
    sessions,
    pending: input.pending.slice(0, LEDGER_PENDING_MAX).map((row) => ({
      checkout: normalizeLedgerPath(row.checkout),
      sessionId: row.sessionId,
      branch: row.branch,
      dirty: row.dirty,
      unpushed: row.unpushed,
      notInMain: row.notInMain,
      hasRemote: row.hasRemote,
      ts: row.ts,
    })),
    notices: newestFirst(input.notices.filter((row) => row.delivered === 0))
      .slice(0, LEDGER_NOTICES_MAX)
      .map((row) => ({
        id: row.id,
        ts: row.ts,
        toSession: row.toSession,
        fromSession: row.fromSession,
        relKey: row.relKey,
        content: row.content.slice(0, LEDGER_NOTICE_CONTENT_MAX),
      })),
    mainWrites: mainWriteViews(input.mainWrites, input.nowMs),
    overlaps: [...input.overlaps],
    spamRule: { ...LEDGER_SPAM_RULE },
  };
}

/** The open Company folder holding a path, when one does; a path outside every folder gets no tag. */
function inFolder(folderOf: ReadonlyMap<string, string>, raw: string): { workspacePath?: string } {
  const workspacePath = folderOf.get(ledgerPathKey(raw));
  return workspacePath === undefined ? {} : { workspacePath };
}

/** JSON of the view without its timestamp: equal content means nothing changed. */
export function viewContentJson(view: LedgerView): string {
  return JSON.stringify({ ...view, generatedAt: '' });
}

function sessionView(row: SessionRow, events: readonly EventRow[], nowMs: number): LedgerSession {
  const lastCall = latestWhere(events, (event) => event.kind !== 'session');
  const lastIntent = latestWhere(
    events,
    (event) => event.kind !== 'session' && (event.intent ?? '') !== '',
  );
  const checkoutEvent = latestWhere(events, (event) => (event.checkout ?? '') !== '');
  const repoEvent = latestWhere(events, (event) => (event.repo ?? '') !== '');

  let calls5m = 0;
  let calls30m = 0;
  const spamCalls: SpamCall[] = [];
  for (const event of events) {
    if (event.kind === 'session') continue;
    const tMs = parseLedgerTime(event.ts);
    if (tMs === null) continue;
    if (tMs >= nowMs - LEDGER_CALLS_SHORT_MS) calls5m += 1;
    if (tMs >= nowMs - LEDGER_CALLS_LONG_MS) {
      calls30m += 1;
      spamCalls.push({ tMs, intent: event.intent });
    }
  }
  const verdict = evaluateSpam(spamCalls, LEDGER_SPAM_RULE);

  const open = !row.endedAt;
  const heartbeatMs = parseLedgerTime(row.heartbeat);
  const live = open && heartbeatMs !== null && heartbeatMs >= nowMs - LEDGER_SESSION_LIVE_MS;

  return {
    sessionId: row.sessionId,
    agentKind: row.agentKind ?? LEDGER_DEFAULT_AGENT_KIND,
    agentName: row.agentName ?? '',
    parentId: row.parentId,
    open,
    live,
    state: row.state ?? '',
    cwd: row.cwd ?? '',
    repo: repoEvent?.repo ? normalizeLedgerPath(repoEvent.repo) : null,
    checkout: checkoutEvent?.checkout ? normalizeLedgerPath(checkoutEvent.checkout) : null,
    branch: checkoutEvent?.branch ?? null,
    lastIntent: lastIntent?.intent ?? null,
    lastCallAt: lastCall?.ts ?? null,
    calls5m,
    calls30m,
    spamming: verdict.spamming,
    spamReason: verdict.reason,
    pid: row.pid,
  };
}

function latestWhere(
  events: readonly EventRow[],
  keep: (event: EventRow) => boolean,
): EventRow | null {
  let latest: EventRow | null = null;
  for (const event of events) {
    if (!keep(event)) continue;
    if (
      latest === null ||
      event.ts > latest.ts ||
      (event.ts === latest.ts && event.id > latest.id)
    ) {
      latest = event;
    }
  }
  return latest;
}

function groupBySession(events: readonly EventRow[]): Map<string, EventRow[]> {
  const groups = new Map<string, EventRow[]>();
  for (const event of events) {
    const group = groups.get(event.sessionId);
    if (group === undefined) {
      groups.set(event.sessionId, [event]);
    } else {
      group.push(event);
    }
  }
  return groups;
}

function openSessionsByCheckout(sessions: readonly LedgerSession[]): Map<string, string[]> {
  const byCheckout = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session.open || session.checkout === null) continue;
    const key = ledgerPathKey(session.checkout);
    const group = byCheckout.get(key);
    if (group === undefined) {
      byCheckout.set(key, [session.sessionId]);
    } else {
      group.push(session.sessionId);
    }
  }
  return byCheckout;
}

function mainWriteViews(rows: readonly EventRow[], nowMs: number): LedgerMainWrite[] {
  const cutoff = nowMs - LEDGER_DAY_MS;
  const recent = rows.filter((row) => {
    const tMs = parseLedgerTime(row.ts);
    return (
      row.isMainCheckout &&
      (row.kind === 'edit' || row.kind === 'write') &&
      tMs !== null &&
      tMs >= cutoff
    );
  });
  return newestFirst(recent)
    .slice(0, LEDGER_MAIN_WRITES_MAX)
    .map((row) => ({
      sessionId: row.sessionId,
      ts: row.ts,
      tool: row.tool,
      path: row.path,
      intent: row.intent,
    }));
}
