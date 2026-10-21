/**
 * The ledger board's live state. Polls the activity database every 10 s while a
 * privileged subscriber or a recent request exists, keeps git scans cached per
 * repo, runs overlap scans in the background, and broadcasts a snapshot only
 * when the view content changes. Nothing here writes to activity.db.
 */

import { createHash } from 'node:crypto';

import type {
  LedgerOverlapScan,
  LedgerSnapshotMessage,
  LedgerTimeline,
  LedgerView,
} from '../../../core/src/messages.js';
import * as commands from './commands.js';
import {
  LEDGER_ACTIVITY_WINDOW_MS,
  LEDGER_DAY_MS,
  LEDGER_GIT_REFRESH_MS,
  LEDGER_POLL_INTERVAL_MS,
  LEDGER_REPO_CAP,
  LEDGER_SPAM_RULE,
} from './constants.js';
import { type GitRepoScan, type GitRunner, readRepo } from './git.js';
import type { EventRow, LedgerFileTouch, LedgerSource } from './ledgerDb.js';
import { ledgerPathKey, normalizeLedgerPath } from './ledgerPath.js';
import { formatLedgerTime } from './ledgerTime.js';
import { MergeBlockCache } from './mergeBlocks.js';
import { OverlapScanner } from './overlap.js';
import type { ScriptRunner } from './processRunner.js';
import { buildTimeline, type TimelineEvent, timelineEventOf } from './timeline.js';
import { buildLedgerView, type LedgerRepoInput, viewContentJson } from './view.js';

export interface LedgerFileHistoryOutcome {
  readonly entries: LedgerFileTouch[];
  readonly reason?: string;
}

export type LedgerSnapshotListener = (message: LedgerSnapshotMessage) => void;

/** Handle of a running interval timer (Node's global setInterval returns this). */
export type LedgerTimerHandle = NodeJS.Timeout;

export interface LedgerScheduler {
  setInterval(callback: () => void, ms: number): LedgerTimerHandle;
  clearInterval(handle: LedgerTimerHandle): void;
}

export interface LedgerServiceOptions {
  readonly source: LedgerSource;
  readonly git: GitRunner;
  /** Runs overlap.py with the given argv (the runtime supplies interpreter and script). */
  readonly overlap: ScriptRunner;
  /** Runs who.py with the given argv (the runtime supplies interpreter and script). */
  readonly who: ScriptRunner;
  readonly now: () => number;
  readonly schedule: LedgerScheduler;
  /** Extra repo folders to scan besides the repos seen in recent activity. */
  readonly extraRepoPaths?: () => readonly string[];
  /** The open Company folder that holds a path (deepest match), or undefined. Never rejects. */
  readonly workspaceFor?: (path: string) => Promise<string | undefined>;
}

interface GitEntry {
  readonly repo: string;
  scan: GitRepoScan | null;
  readAt: number | null;
  inFlight: Promise<void> | null;
  /** Set when a forced refresh arrives during a read: the read runs again afterwards. */
  rerun: boolean;
}

export class LedgerService {
  private readonly listeners = new Set<LedgerSnapshotListener>();
  private readonly gitEntries = new Map<string, GitEntry>();
  private readonly mergeBlocks = new MergeBlockCache();
  private readonly overlap: OverlapScanner;
  private lastHash: string | null = null;
  private lastRequestAt: number | null = null;
  private timer: LedgerTimerHandle | null = null;
  private refreshCount = 0;
  private appliedCount = 0;
  private disposed = false;

  constructor(private readonly options: LedgerServiceOptions) {
    this.overlap = new OverlapScanner({
      run: options.overlap,
      now: options.now,
      onSettled: () => {
        if (this.isActive()) this.refreshInBackground();
      },
    });
  }

  /** Read-only project-tree seam: shares the source instance owned by the ledger. */
  get projectTreeSource(): LedgerSource {
    return this.options.source;
  }

  /** Read-only project-tree seam: shares the configured git runner. */
  get projectTreeGit(): GitRunner {
    return this.options.git;
  }

  /** Latest view. Waits only for repos that have never been read; cached scans are reused. */
  async getView(): Promise<LedgerView> {
    this.touch();
    return this.refresh(true);
  }

  /** Overlap scans of the open repos. Reads without marking the ledger watched, so it never keeps itself polling. */
  async overlapScans(): Promise<readonly LedgerOverlapScan[]> {
    return (await this.refresh(true)).overlaps;
  }

  /** Overlap scans as currently known, without waiting for unread repos. For the Project tree. */
  async currentOverlapScans(): Promise<readonly LedgerOverlapScan[]> {
    return (await this.refresh(false)).overlaps;
  }

  /**
   * One repo's git scan from the shared cache: a stale scan is returned at once
   * while a refresh runs; only a never-read repo waits for its first read.
   */
  async repoScan(repo: string): Promise<GitRepoScan> {
    const entry = this.entryFor(repo);
    const pending = this.refreshGit(repo, false);
    if (entry.scan === null) await pending;
    return entry.scan ?? { kind: 'not-repo' };
  }

  /** Whether a board is looking at the ledger: a subscriber, or a view request within the activity window. */
  watched(): boolean {
    return this.isActive();
  }

  /** Registers a snapshot listener and starts the poll. Returns the unsubscribe function. */
  subscribe(listener: LedgerSnapshotListener): () => void {
    this.listeners.add(listener);
    this.ensureTimer();
    return () => {
      this.listeners.delete(listener);
      if (!this.isActive()) this.stopTimer();
    };
  }

  async timeline(windowMinutes: number): Promise<LedgerTimeline> {
    this.touch();
    const nowMs = this.options.now();
    const events: TimelineEvent[] = this.options.source
      .eventRows(formatLedgerTime(nowMs - windowMinutes * 60_000))
      .map(timelineEventOf)
      .filter((event): event is TimelineEvent => event !== null);
    const sessions = this.options.source.sessionRows().map((row) => ({
      sessionId: row.sessionId,
      agentKind: row.agentKind,
      agentName: row.agentName,
    }));
    return buildTimeline({ windowMinutes, nowMs, events, sessions, rule: LEDGER_SPAM_RULE });
  }

  /** Re-tags the view against the open folders as they now stand; a snapshot goes out only if a tag changed. */
  rescope(): void {
    if (this.isActive()) this.refreshInBackground();
  }

  async fileDiff(worktree: string, path: string): Promise<commands.FileDiffOutcome> {
    this.touch();
    const view = await this.refresh(true);
    const known = view.repos.flatMap((repo) => repo.worktrees);
    return commands.fileDiff(this.options.git, worktree, path, known);
  }
  async fileHistory(path: string): Promise<LedgerFileHistoryOutcome> {
    this.touch();
    const entries = this.options.source.fileHistory(
      ledgerPathKey(path),
      formatLedgerTime(this.options.now() - LEDGER_DAY_MS * 7),
    );
    const database = this.options.source.status();
    if (database.state !== 'ok') {
      return {
        entries,
        reason:
          database.state === 'missing'
            ? 'Không tìm thấy cơ sở dữ liệu hoạt động.'
            : 'Không đọc được cơ sở dữ liệu hoạt động.',
      };
    }
    return { entries };
  }

  async sendMessage(sessionId: string, text: string): Promise<commands.SendOutcome> {
    this.touch();
    const outcome = await commands.sendMessage(this.options.who, sessionId, text);
    this.forceGitRefresh();
    this.refreshInBackground();
    return outcome;
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
    this.listeners.clear();
    this.overlap.dispose();
    this.options.source.close();
  }

  /** Builds the view, broadcasts it when its content changed, and returns it. */
  private async refresh(awaitMissingGit: boolean): Promise<LedgerView> {
    if (this.disposed) throw new Error('ledger service is disposed');
    const sequence = ++this.refreshCount;
    const view = await this.assemble(this.options.now(), awaitMissingGit);
    // A slower refresh that started earlier must not overwrite a newer snapshot.
    if (sequence < this.appliedCount) return view;
    this.appliedCount = sequence;
    const hash = createHash('sha256').update(viewContentJson(view)).digest('hex');
    if (hash !== this.lastHash) {
      this.lastHash = hash;
      this.broadcast({ type: 'ledgerSnapshot', view });
    }
    return view;
  }

  private async assemble(nowMs: number, awaitMissingGit: boolean): Promise<LedgerView> {
    const source = this.options.source;
    const dayStart = formatLedgerTime(nowMs - LEDGER_DAY_MS);
    const events = source.eventRows(dayStart);
    const entries = this.recentRepos(events).map((repo) => this.entryFor(repo));

    const reads: Promise<void>[] = [];
    for (const entry of entries) {
      const pending = this.refreshGit(entry.repo, false);
      if (awaitMissingGit && entry.scan === null) reads.push(pending);
    }
    await Promise.all(reads);

    const repos = entries.flatMap((entry) =>
      entry.scan === null ? [] : [{ repo: entry.repo, scan: entry.scan }],
    );
    const overlaps: LedgerOverlapScan[] = [];
    for (const repo of repos) {
      if (repo.scan.kind === 'repo' && repo.scan.worktrees.length >= 2) {
        this.overlap.enqueueIfDue(repo.repo, repo.scan.worktrees.length);
        overlaps.push(this.overlap.snapshot(repo.repo));
      }
    }

    const mergeBlocks = (
      await Promise.all(
        repos.map(async ({ repo }) => {
          try {
            return await this.mergeBlocks.read(this.options.git, repo, nowMs);
          } catch (error) {
            console.warn('[ledger] merge-lane read failed', repo, error);
            return [];
          }
        }),
      )
    ).flat();

    return buildLedgerView({
      nowMs,
      database: source.status(),
      sessions: source.sessionRows(),
      events,
      pending: source.pendingRows(),
      notices: source.noticeRows(),
      mainWrites: source.mainWriteRows(dayStart),
      repos,
      overlaps,
      mergeBlocks,
      folderOf: await this.folderTags(repos),
    });
  }

  /** The open folder of every repo and checkout in view, keyed by ledgerPathKey; empty without a resolver. */
  private async folderTags(
    repos: readonly LedgerRepoInput[],
  ): Promise<ReadonlyMap<string, string>> {
    const tags = new Map<string, string>();
    const workspaceFor = this.options.workspaceFor;
    if (workspaceFor === undefined) return tags;
    const paths = new Set<string>();
    for (const repo of repos) {
      paths.add(repo.repo);
      if (repo.scan.kind === 'repo') {
        for (const worktree of repo.scan.worktrees) paths.add(worktree.path);
      }
    }
    await Promise.all(
      [...paths].map(async (target) => {
        const folder = await workspaceFor(target);
        if (folder !== undefined) tags.set(ledgerPathKey(target), folder);
      }),
    );
    return tags;
  }

  /** Repos from the last day's events, newest first and capped, then the extra folders. */
  private recentRepos(events: readonly EventRow[]): string[] {
    const repos = new Map<string, string>();
    for (let index = events.length - 1; index >= 0 && repos.size < LEDGER_REPO_CAP; index--) {
      const repo = events[index].repo;
      if (repo !== null && repo !== '') addRepo(repos, repo);
    }
    for (const extra of this.options.extraRepoPaths?.() ?? []) addRepo(repos, extra);
    return [...repos.values()];
  }

  private entryFor(repo: string): GitEntry {
    const key = ledgerPathKey(repo);
    let entry = this.gitEntries.get(key);
    if (entry === undefined) {
      entry = {
        repo: normalizeLedgerPath(repo),
        scan: null,
        readAt: null,
        inFlight: null,
        rerun: false,
      };
      this.gitEntries.set(key, entry);
    }
    return entry;
  }

  /** Starts a git read unless one is in flight or the cached scan is fresh. Never rejects. */
  private refreshGit(repo: string, force: boolean): Promise<void> {
    const entry = this.entryFor(repo);
    if (entry.inFlight !== null) {
      if (force) entry.rerun = true;
      return entry.inFlight;
    }
    const fresh =
      entry.readAt !== null && this.options.now() - entry.readAt < LEDGER_GIT_REFRESH_MS;
    if (!force && fresh) return Promise.resolve();
    entry.inFlight = this.readGitEntry(entry).finally(() => {
      entry.inFlight = null;
      // Failed reads count as read, so a broken repo waits a full interval before retrying.
      entry.readAt = this.options.now();
      if (this.isActive()) this.refreshInBackground();
    });
    return entry.inFlight;
  }

  private async readGitEntry(entry: GitEntry): Promise<void> {
    do {
      entry.rerun = false;
      try {
        entry.scan = await readRepo(this.options.git, entry.repo);
      } catch (error) {
        // Keep the last good scan; the next interval tries again.
        console.warn('[ledger] git read failed', entry.repo, error);
      }
    } while (entry.rerun);
  }

  private forceGitRefresh(): void {
    for (const entry of this.gitEntries.values()) void this.refreshGit(entry.repo, true);
  }

  private refreshInBackground(): void {
    this.refresh(false).catch((error: unknown) => {
      console.error('[ledger] refresh failed', error);
    });
  }

  private broadcast(message: LedgerSnapshotMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (error) {
        console.warn('[ledger] snapshot listener failed', error);
      }
    }
  }

  private isActive(): boolean {
    if (this.disposed) return false;
    if (this.listeners.size > 0) return true;
    if (this.lastRequestAt === null) return false;
    return this.options.now() - this.lastRequestAt < LEDGER_ACTIVITY_WINDOW_MS;
  }

  private touch(): void {
    this.lastRequestAt = this.options.now();
    this.ensureTimer();
  }

  private ensureTimer(): void {
    if (this.timer !== null || this.disposed) return;
    this.timer = this.options.schedule.setInterval(() => this.tick(), LEDGER_POLL_INTERVAL_MS);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    this.options.schedule.clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (!this.isActive()) {
      this.stopTimer();
      return;
    }
    this.refreshInBackground();
  }
}

function addRepo(repos: Map<string, string>, path: string): void {
  const normalized = normalizeLedgerPath(path);
  const key = ledgerPathKey(normalized);
  if (!repos.has(key)) repos.set(key, normalized);
}
