import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { LedgerOverlapScan, ProjectTreeNode } from '../../../core/src/messages.js';
import { listFolderRepos } from '../company/workItems/folderRepos.js';
import {
  LEDGER_DIFF_MAX_BYTES,
  LEDGER_DIFF_TIMEOUT_MS,
  LEDGER_GIT_MAX_BYTES,
} from '../ledger/constants.js';
import { type GitRepoScan, type GitRunner, type GitRunOptions, readRepo } from '../ledger/git.js';
import type { LedgerSource, SessionRow } from '../ledger/ledgerDb.js';
import { normalizeLedgerPath } from '../ledger/ledgerPath.js';
import { formatLedgerTime } from '../ledger/ledgerTime.js';
import type { AgentState } from '../types.js';
import { type Project, type ProjectNode, ProjectStore } from './projectStore.js';
import type { SessionProgress } from './sessionProgress.js';

export interface ProjectSessionSnapshot {
  readonly engine: NonNullable<ProjectTreeNode['engine']>;
  readonly agentKind: NonNullable<ProjectTreeNode['agentKind']>;
  readonly id: string;
  readonly status: string;
  readonly title: string;
  readonly cwd: string;
  /** Ledger sessions a board folder runs: that board session's id. */
  readonly boardSessionId?: string;
  /** The session that spawned this one, when the ledger links them. */
  readonly parentSessionId?: string;
  /** The herdr pane the session runs in, when herdr reports the same session. */
  readonly herdrPaneId?: string;
  /** The checkouts the session edited lately, newest first. */
  readonly editCheckouts?: readonly string[];
  /** The agent's own todo list, as its transcript last wrote it. */
  readonly progress?: SessionProgress;
}

export interface HerdrProjectSession {
  readonly id: string;
  readonly cwd: string;
  readonly status: string;
  readonly title: string;
  /** The agent's transcript, when it reported one to herdr; joins the pane to its ledger session. */
  readonly sessionFile?: string;
  /** The agent's session id, when it reported an id instead. */
  readonly sessionId?: string;
}

export interface ProjectTreeSnapshot {
  readonly nodes: ProjectTreeNode[];
}

export interface ProjectTreeOptions {
  readonly ledger: LedgerSource;
  readonly git: GitRunner;
  /** Whether a ledger session's process still runs; a session whose process is gone is left out. Unset keeps every live row. */
  readonly isAlive?: (pid: number) => boolean;
  readonly agents?: Iterable<AgentState>;
  readonly herdrSessions?: () => readonly HerdrProjectSession[];
  readonly overlapScans?: () => Promise<readonly LedgerOverlapScan[]>;
  readonly listRepos?: typeof listFolderRepos;
  /** Repo scan source; the ledger passes its cached scans. Defaults to a fresh read. */
  readonly readRepo?: (repo: string) => Promise<GitRepoScan>;
  /** Folders and their sessions only, no git: answers at once while the full tree builds. */
  readonly sessionsOnly?: boolean;
  /** The board session an open folder runs for an omp (native) session id, if any. */
  readonly boardSessionFor?: (nativeSessionId: string) => string | undefined;
  /** The todo progress a transcript last wrote. Unset leaves rows without progress. */
  readonly sessionProgress?: (sessionFile: string) => Promise<SessionProgress | undefined>;
}
/** How far back a session's latest intent is looked up for its title. */
const SESSION_INTENT_WINDOW_MS = 6 * 60 * 60 * 1000;
function canonicalKey(folder: string): string {
  const resolved = path.resolve(folder);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function pathContains(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

type ProjectAgentKind = NonNullable<ProjectTreeNode['agentKind']>;
type ProjectSessionEngine = NonNullable<ProjectTreeNode['engine']>;

function engineForLedger(row: SessionRow): ProjectSessionEngine {
  const kind = (row.agentKind ?? '').toLowerCase();
  if (kind.includes('claude')) return 'claude';
  if (kind.includes('agy')) return 'agy';
  return 'omp';
}

function agentKindForLedger(row: SessionRow): ProjectAgentKind {
  const kind = (row.agentKind ?? '').toLowerCase();
  if (kind === 'sub') return 'sub';
  if (kind.includes('claude')) return 'claude';
  if (kind.includes('agy')) return 'agy';
  return 'omp';
}

/** A ledger session row with its latest intent, the board session behind it, its spawner, its herdr pane and its last edited checkout, when known. */
type TitledSessionRow = SessionRow & {
  readonly intent?: string;
  readonly boardSessionId?: string;
  readonly parentSessionId?: string;
  readonly herdrPaneId?: string;
  readonly editCheckouts?: readonly string[];
  readonly progress?: SessionProgress;
};

/**
 * A subagent's task name (its transcript's file name, e.g. "ScoutWebAppUi"), else the
 * agent name when it says something, else what the session is doing now, else the
 * short session id.
 */
function titleForLedger(row: TitledSessionRow): string {
  const task = row.agentKind?.toLowerCase() === 'sub' && row.sessionFile
    ? (row.sessionFile.split(/[\\/]/).pop() ?? '').replace(/\.jsonl?$/i, '')
    : '';
  if (task !== '') return task;
  const name = row.agentName?.trim() ?? '';
  if (name !== '' && name !== 'main') return name;
  return row.intent ?? `…${row.sessionId.slice(-8)}`;
}

/** A transcript path compared case- and separator-blind, without its extension. */
function fileStem(file: string): string {
  return file.replace(/\\/g, '/').toLowerCase().replace(/\.jsonl?$/, '');
}

/**
 * Each live session's spawner. A subagent's transcript sits in a folder named after
 * its parent's transcript, so the deepest live transcript whose stem prefixes the
 * file is the parent. A subagent without a file falls back to the live main session
 * of its process, but only when that process has exactly one: two would be a guess,
 * so it stays unlinked. The ledger's `parent_id` is an agent name, so it cannot link them.
 */
export function parentSessions(rows: readonly SessionRow[]): Map<string, string> {
  const live = rows.filter((row) => row.endedAt === null);
  const stems = live.flatMap((row) => (row.sessionFile ? [{ id: row.sessionId, stem: `${fileStem(row.sessionFile)}/` }] : []));
  const parents = new Map<string, string>();
  for (const row of live) {
    const file = row.sessionFile ? fileStem(row.sessionFile) : null;
    const byFile = file === null
      ? undefined
      : stems
        .filter((candidate) => candidate.id !== row.sessionId && file.startsWith(candidate.stem))
        .sort((a, b) => b.stem.length - a.stem.length)[0]?.id;
    const mains = byFile !== undefined || row.agentKind?.toLowerCase() !== 'sub' || row.pid === null
      ? []
      : live.filter((other) => other.pid === row.pid && other.agentKind?.toLowerCase() !== 'sub');
    const parent = byFile ?? (mains.length === 1 ? mains[0]?.sessionId : undefined);
    if (parent !== undefined) parents.set(row.sessionId, parent);
  }
  return parents;
}

/** Adds each session's latest non-empty intent and last edited checkout (last few hours), its board session id and its spawner. */
function annotateLedgerRows(
  rows: readonly SessionRow[],
  ledger: LedgerSource,
  boardSessionFor: ((nativeSessionId: string) => string | undefined) | undefined,
): TitledSessionRow[] {
  const intents = new Map<string, string>();
  // Events come oldest first, so re-adding a checkout moves it to the end; reversed below, newest first.
  const edited = new Map<string, Set<string>>();
  for (const event of ledger.eventRows(formatLedgerTime(Date.now() - SESSION_INTENT_WINDOW_MS))) {
    const intent = event.intent?.trim();
    if (intent) intents.set(event.sessionId, intent);
    if (!event.checkout) continue;
    const checkouts = edited.get(event.sessionId) ?? new Set<string>();
    checkouts.delete(event.checkout);
    checkouts.add(event.checkout);
    edited.set(event.sessionId, checkouts);
  }
  const parents = parentSessions(rows);
  return rows.map((row) => {
    const intent = intents.get(row.sessionId);
    const boardSessionId = row.endedAt === null ? boardSessionFor?.(row.sessionId) : undefined;
    const parentSessionId = parents.get(row.sessionId);
    const editCheckouts = [...(edited.get(row.sessionId) ?? [])].reverse();
    return {
      ...row,
      ...(intent === undefined ? {} : { intent }),
      ...(boardSessionId === undefined ? {} : { boardSessionId }),
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
      ...(editCheckouts.length === 0 ? {} : { editCheckouts }),
    };
  });
}

/**
 * Joins each live ledger session to the herdr pane that reports the same session
 * (by transcript file, else by id). A joined pane is not listed again: its session's
 * row carries the pane id, so a click opens the pane's terminal.
 */
export function linkHerdrPanes(
  rows: readonly TitledSessionRow[],
  panes: readonly HerdrProjectSession[],
): { rows: TitledSessionRow[]; panes: HerdrProjectSession[] } {
  const byFile = new Map<string, string>();
  const byId = new Map<string, string>();
  for (const pane of panes) {
    if (pane.sessionFile !== undefined) byFile.set(fileStem(pane.sessionFile), pane.id);
    if (pane.sessionId !== undefined) byId.set(pane.sessionId, pane.id);
  }
  const joined = new Set<string>();
  const linked = rows.map((row) => {
    if (row.endedAt !== null) return row;
    const paneId = (row.sessionFile ? byFile.get(fileStem(row.sessionFile)) : undefined) ?? byId.get(row.sessionId);
    if (paneId === undefined) return row;
    joined.add(paneId);
    return { ...row, herdrPaneId: paneId };
  });
  return { rows: linked, panes: panes.filter((pane) => !joined.has(pane.id)) };
}

function ledgerStatus(row: SessionRow): string {
  if (row.endedAt !== null) return 'ended';
  const state = row.state?.toLowerCase();
  if (state === 'waiting' || state === 'waiting_input' || state === 'idle') return state;
  return 'running';
}

/**
 * Live sessions working in `checkout`. A cwd inside a nested checkout (a
 * `.worktrees/<name>` under the main one) belongs to that deeper checkout only.
 * Ended ledger sessions are left out: the tree shows who is working, not history.
 */
function sessionsForCheckout(
  checkout: string,
  nestedCheckouts: readonly string[],
  ledgerRows: readonly TitledSessionRow[],
  agents: readonly AgentState[],
  herdrSessions: readonly HerdrProjectSession[],
): ProjectSessionSnapshot[] {
  const owns = (cwd: string): boolean =>
    pathContains(checkout, cwd) && !nestedCheckouts.some((nested) => pathContains(nested, cwd));
  const sessions: ProjectSessionSnapshot[] = [];
  for (const row of ledgerRows) {
    if (row.cwd === null || row.endedAt !== null || !owns(row.cwd)) continue;
    sessions.push({
      engine: engineForLedger(row),
      agentKind: agentKindForLedger(row),
      id: row.sessionId,
      status: ledgerStatus(row),
      title: titleForLedger(row),
      cwd: row.cwd,
      ...(row.boardSessionId === undefined ? {} : { boardSessionId: row.boardSessionId }),
      ...(row.parentSessionId === undefined ? {} : { parentSessionId: row.parentSessionId }),
      ...(row.herdrPaneId === undefined ? {} : { herdrPaneId: row.herdrPaneId }),
      ...(row.editCheckouts === undefined ? {} : { editCheckouts: row.editCheckouts }),
      ...(row.progress === undefined ? {} : { progress: row.progress }),
    });
  }
  for (const agent of agents) {
    if (!owns(agent.projectDir)) continue;
    sessions.push({
      engine: 'board',
      agentKind: 'board',
      id: agent.sessionId,
      status: agent.isWaiting ? 'waiting' : 'running',
      title: agent.agentName ?? agent.teamName ?? '',
      cwd: agent.projectDir,
    });
  }
  for (const session of herdrSessions) {
    if (!owns(session.cwd)) continue;
    sessions.push({ engine: 'herdr', agentKind: 'herdr', id: session.id, cwd: session.cwd, status: session.status, title: session.title });
  }
  return sessions;
}

const NUMSTAT_OPTIONS: GitRunOptions = {
  timeoutMs: LEDGER_DIFF_TIMEOUT_MS,
  okCodes: [0],
  maxBytes: LEDGER_DIFF_MAX_BYTES,
};
const UNTRACKED_STAT_OPTIONS: GitRunOptions = {
  ...NUMSTAT_OPTIONS,
  okCodes: [0, 1],
  maxBytes: LEDGER_GIT_MAX_BYTES,
};
/** New files whose lines are counted per checkout; the rest still list as changed-without-count. */
const UNTRACKED_COUNT_LIMIT = 200;
/** Checkouts of one repo whose change counts are read at once. */
const CHANGED_FILES_CONCURRENCY = 4;

interface FileChangeCount {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

/** Repos under a folder change rarely, and walking a large folder takes seconds. */
const REPO_LIST_REUSE_MS = 60_000;
/** Change counts (2 git calls per dirty checkout) are re-read at most this often, like repo scans. */
const CHANGED_FILES_REUSE_MS = 20_000;
/**
 * A repo's worktree states (6 git calls per worktree) are re-read at most this often. The tree
 * rebuilds on every session status change; without this, many open sessions keep git busy.
 */
const REPO_SCAN_REUSE_MS = 20_000;

interface Reused<T> {
  readonly at: number;
  readonly value: Promise<T>;
}
const repoLists = new Map<string, Reused<string[]>>();
const changeCounts = new Map<string, Reused<FileChangeCount[]>>();
const repoScans = new Map<string, Reused<GitRepoScan>>();

/** After a change the user made (new worktree, moved folder), the next tree reads git afresh. */
export function forgetGitScans(): void {
  changeCounts.clear();
  repoScans.clear();
}

/** `load` result for `key`, reused for `ttlMs`; a failed load is dropped so the next call retries. */
function reuse<T>(cache: Map<string, Reused<T>>, key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit !== undefined && Date.now() - hit.at < ttlMs) return hit.value;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}

interface NodeAggregate {
  additions: number;
  deletions: number;
  overlap: boolean;
  overlappingWorktrees: Set<string>;
  pendingWork: boolean;
}

interface CheckoutOverlap {
  readonly worktrees: Set<string>;
  readonly files: Set<string>;
}

function emptyAggregate(): NodeAggregate {
  return { additions: 0, deletions: 0, overlap: false, overlappingWorktrees: new Set(), pendingWork: false };
}

function validRelativeFile(filePath: string): boolean {
  if (filePath.length === 0 || filePath.includes('\0') || path.isAbsolute(filePath)) return false;
  return !filePath.split(/[\\/]/).some((part) => part === '..');
}

function numberFromNumstat(value: string): number {
  return /^\d+$/.test(value) ? Number(value) : 0;
}

function parseNumstat(stdout: string): FileChangeCount[] {
  const files: FileChangeCount[] = [];
  for (const record of stdout.split('\0')) {
    if (record.length === 0) continue;
    const fields = record.split('\t');
    if (fields.length < 3) continue;
    const filePath = fields.slice(2).join('\t');
    if (!validRelativeFile(filePath)) continue;
    files.push({
      path: filePath,
      additions: numberFromNumstat(fields[0]),
      deletions: numberFromNumstat(fields[1]),
    });
  }
  return files;
}

async function changedFiles(git: GitRunner, checkout: string): Promise<FileChangeCount[]> {
  const tracked = await git.run(checkout, ['diff', '--numstat', '-z', '--no-renames', 'HEAD', '--'], NUMSTAT_OPTIONS);
  if (!tracked.ok || tracked.truncated) return [];
  const files = new Map(parseNumstat(tracked.stdout).map((file) => [file.path, file]));
  const untracked = await git.run(
    checkout,
    ['ls-files', '--others', '--exclude-standard', '-z'],
    { ...UNTRACKED_STAT_OPTIONS, okCodes: [0] },
  );
  if (!untracked.ok || untracked.truncated) return [...files.values()];
  const fresh = untracked.stdout
    .split('\0')
    .filter((filePath) => validRelativeFile(filePath) && !files.has(filePath));
  // Counted in-process: one git spawn per new file made large worktrees take minutes.
  for (const [index, filePath] of fresh.entries()) {
    const additions = index < UNTRACKED_COUNT_LIMIT ? await countFileLines(path.join(checkout, filePath)) : 0;
    files.set(filePath, { path: filePath, additions, deletions: 0 });
  }
  return [...files.values()];
}

/** Lines a new file adds; 0 for binary, unreadable or oversized files. */
async function countFileLines(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > LEDGER_DIFF_MAX_BYTES) return 0;
    const content = await fs.readFile(filePath);
    if (content.includes(0)) return 0;
    let lines = 0;
    for (const byte of content) if (byte === 0x0a) lines += 1;
    return content.length > 0 && content[content.length - 1] !== 0x0a ? lines + 1 : lines;
  } catch {
    return 0;
  }
}

/** Runs `task` over `items` with at most `limit` in flight, keeping input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The main repos behind `paths`: a linked worktree (`.git` file pointing at
 * `<main>/.git/worktrees/<name>`) is replaced by its main repo, so each repo is
 * scanned once; scanning every worktree as its own repo re-read all sibling
 * worktrees each time (quadratic). Other `.git` files (submodules point into
 * `.git/modules/...`) are repos of their own and stay.
 */
async function mainRepos(paths: readonly string[]): Promise<string[]> {
  const mains = new Map<string, string>();
  for (const candidate of paths) {
    let main = candidate;
    try {
      const dotGit = path.join(candidate, '.git');
      if ((await fs.stat(dotGit)).isFile()) {
        const match = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(dotGit, 'utf8'));
        const adminDir = match?.[1] === undefined ? undefined : path.resolve(candidate, match[1].trim());
        const worktreesDir = adminDir === undefined ? undefined : path.dirname(adminDir);
        if (
          worktreesDir !== undefined &&
          path.basename(worktreesDir) === 'worktrees' &&
          path.basename(path.dirname(worktreesDir)) === '.git'
        ) {
          main = path.dirname(path.dirname(worktreesDir));
        }
      }
    } catch {
      // Unreadable .git: keep the path; readRepo decides whether it is a repo.
    }
    mains.set(canonicalKey(main), main);
  }
  return [...mains.values()];
}

function overlapForCheckout(
  checkout: string,
  scans: readonly LedgerOverlapScan[],
): CheckoutOverlap {
  const result: CheckoutOverlap = { worktrees: new Set(), files: new Set() };
  const key = canonicalKey(checkout);
  for (const scan of scans) {
    for (const pair of scan.pairs) {
      if (pair.conflicts.length === 0) continue;
      const a = canonicalKey(pair.a);
      const b = canonicalKey(pair.b);
      if (a !== key && b !== key) continue;
      result.worktrees.add(normalizeLedgerPath(a === key ? pair.b : pair.a));
      for (const conflict of pair.conflicts) {
        result.files.add(conflict.file.replaceAll(path.sep, '/'));
      }
    }
  }
  return result;
}

function applyAggregates(nodes: ProjectTreeNode[], aggregates: Map<string, NodeAggregate>): void {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    const aggregate = aggregates.get(node.id) ?? emptyAggregate();
    if (node.parentId !== undefined) {
      const parent = aggregates.get(node.parentId) ?? emptyAggregate();
      parent.additions += aggregate.additions;
      parent.deletions += aggregate.deletions;
      parent.overlap ||= aggregate.overlap;
      parent.pendingWork ||= aggregate.pendingWork;
      for (const worktree of aggregate.overlappingWorktrees) parent.overlappingWorktrees.add(worktree);
      aggregates.set(node.parentId, parent);
    }
    aggregates.set(node.id, aggregate);
    node.additions = aggregate.additions;
    node.deletions = aggregate.deletions;
    node.overlap = aggregate.overlap;
    node.pendingWork = aggregate.pendingWork;
    if (aggregate.overlappingWorktrees.size > 0) {
      node.overlappingWorktrees = [...aggregate.overlappingWorktrees];
    }
  }
}
async function appendNodes(
  nodes: readonly ProjectNode[],
  parentId: string,
  options: ProjectTreeOptions,
  ledgerRows: readonly TitledSessionRow[],
  agents: readonly AgentState[],
  herdrSessions: readonly HerdrProjectSession[],
  overlapScans: readonly LedgerOverlapScan[],
  pendingCheckouts: ReadonlySet<string>,
  aggregates: Map<string, NodeAggregate>,
  output: ProjectTreeNode[],
): Promise<void> {
  for (const node of nodes) {
    if (node.type === 'group') {
      output.push({ id: node.id, parentId, kind: 'group', name: node.name });
      await appendNodes(
        node.children, node.id, options, ledgerRows, agents, herdrSessions,
        overlapScans, pendingCheckouts, aggregates, output,
      );
      continue;
    }

    output.push({ id: node.id, parentId, kind: 'folder', name: node.name, path: node.path });
    if (options.sessionsOnly === true) {
      pushSessions(output, node.id, sessionsForCheckout(node.path, [], ledgerRows, agents, herdrSessions));
      continue;
    }
    const listed = options.listRepos === undefined
      ? await reuse(repoLists, canonicalKey(node.path), REPO_LIST_REUSE_MS, () => listFolderRepos(node.path))
      : await options.listRepos(node.path);
    const repos = await mainRepos(listed);
    const scanRepo = options.readRepo
      ?? ((repo: string) => reuse(repoScans, canonicalKey(repo), REPO_SCAN_REUSE_MS, () => readRepo(options.git, repo)));
    const scans = await mapLimit(repos, CHANGED_FILES_CONCURRENCY, scanRepo);
    // Sessions in the folder but in no checkout (a plain folder, a non-repo subfolder) belong to the folder.
    const checkoutPaths = scans.flatMap((scan) => (scan.kind === 'repo' ? scan.worktrees.map((worktree) => worktree.path) : []));
    pushSessions(output, node.id, sessionsForCheckout(node.path, checkoutPaths, ledgerRows, agents, herdrSessions));
    for (const [repoIndex, repoPath] of repos.entries()) {
      const scan = scans[repoIndex] ?? { kind: 'not-repo' as const };
      if (scan.kind !== 'repo') continue;
      const mainCheckout = scan.worktrees.find((worktree) => worktree.isMain);
      if (mainCheckout === undefined || canonicalKey(mainCheckout.path) !== canonicalKey(repoPath)) continue;

      const repoId = repoPath;
      output.push({
        id: repoId, parentId: node.id, kind: 'repository', name: path.basename(repoPath), path: repoPath,
      });
      aggregates.set(repoId, emptyAggregate());
      // A clean checkout has nothing to count: skip its two git calls.
      const changes = await mapLimit(scan.worktrees, CHANGED_FILES_CONCURRENCY, (worktree) =>
        worktree.dirtyCount > 0
          ? reuse(changeCounts, canonicalKey(worktree.path), CHANGED_FILES_REUSE_MS, () => changedFiles(options.git, worktree.path))
          : Promise.resolve([]),
      );
      for (const [worktreeIndex, worktree] of scan.worktrees.entries()) {
        const overlap = overlapForCheckout(worktree.path, overlapScans);
        output.push({
          id: worktree.path,
          parentId: repoId,
          kind: 'checkout',
          name: worktree.name,
          path: worktree.path,
          ...(worktree.branch === null ? {} : { branch: worktree.branch }),
          dirty: worktree.dirtyCount > 0,
          ahead: worktree.ahead,
          behind: worktree.behind,
        });
        aggregates.set(worktree.path, {
          additions: 0,
          deletions: 0,
          overlap: overlap.worktrees.size > 0,
          overlappingWorktrees: new Set(overlap.worktrees),
          pendingWork: pendingCheckouts.has(canonicalKey(worktree.path)),
        });

        const files = changes[worktreeIndex] ?? [];
        for (const file of files) {
          const fileId = `file:${worktree.path}:${file.path}`;
          const normalizedFile = file.path.replaceAll(path.sep, '/');
          const fileOverlap = overlap.files.has(normalizedFile);
          output.push({
            id: fileId,
            parentId: worktree.path,
            kind: 'file-agg',
            name: path.basename(file.path),
            path: path.resolve(worktree.path, file.path),
            overlap: fileOverlap,
          });
          aggregates.set(fileId, {
            additions: file.additions,
            deletions: file.deletions,
            overlap: fileOverlap,
            overlappingWorktrees: fileOverlap ? new Set(overlap.worktrees) : new Set(),
            pendingWork: false,
          });
        }

        const nested = scan.worktrees
          .map((other) => other.path)
          .filter((other) => canonicalKey(other) !== canonicalKey(worktree.path) && pathContains(worktree.path, other));
        pushSessions(output, worktree.path, sessionsForCheckout(worktree.path, nested, ledgerRows, agents, herdrSessions));
      }
    }
  }
}

function pushSessions(output: ProjectTreeNode[], parentId: string, sessions: readonly ProjectSessionSnapshot[]): void {
  for (const session of sessions) {
    output.push({
      id: `${session.agentKind}:${session.id}`,
      parentId,
      kind: 'session',
      name: session.title || session.id,
      engine: session.engine,
      agentKind: session.agentKind,
      sessionId: session.id,
      state: session.status,
      title: session.title,
      path: session.cwd,
      ...(session.boardSessionId === undefined ? {} : { boardSessionId: session.boardSessionId }),
      ...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
      ...(session.herdrPaneId === undefined ? {} : { herdrPaneId: session.herdrPaneId }),
      ...(session.editCheckouts === undefined ? {} : { editCheckouts: [...session.editCheckouts] }),
      ...(session.progress === undefined ? {} : { progress: session.progress }),
    });
  }
}

/**
 * Live ledger rows whose process is gone are dropped: a killed agent never records
 * its own end, so the ledger would otherwise list it as working.
 */
function withoutDeadProcesses(rows: readonly SessionRow[], isAlive: ((pid: number) => boolean) | undefined): readonly SessionRow[] {
  if (isAlive === undefined) return rows;
  return rows.filter((row) => row.endedAt !== null || row.pid === null || isAlive(row.pid));
}

/** Live rows with the todo progress their transcript last wrote; an unreadable transcript gives none. */
async function withProgress(
  rows: readonly TitledSessionRow[],
  read: ProjectTreeOptions['sessionProgress'],
): Promise<readonly TitledSessionRow[]> {
  if (read === undefined) return rows;
  return Promise.all(rows.map(async (row) => {
    if (row.endedAt !== null || !row.sessionFile) return row;
    const progress = await read(row.sessionFile).catch(() => undefined);
    return progress === undefined ? row : { ...row, progress };
  }));
}

export async function buildProjectTreeSnapshot(
  store: ProjectStore,
  options: ProjectTreeOptions,
): Promise<ProjectTreeSnapshot> {
  const state = await store.load();
  const linked = linkHerdrPanes(
    annotateLedgerRows(withoutDeadProcesses(options.ledger.sessionRows(), options.isAlive), options.ledger, options.boardSessionFor),
    options.herdrSessions?.() ?? [],
  );
  const ledgerRows = await withProgress(linked.rows, options.sessionProgress);
  const pendingCheckouts = new Set(options.ledger.pendingRows().map((row) => canonicalKey(row.checkout)));
  const overlapScans = options.sessionsOnly === true ? [] : await (options.overlapScans?.() ?? Promise.resolve([]));
  const agents = [...(options.agents ?? [])];
  const herdrSessions = linked.panes;
  const nodes: ProjectTreeNode[] = [];
  const aggregates = new Map<string, NodeAggregate>();
  for (const project of state.projects) {
    nodes.push({
      id: project.id, kind: 'project', name: project.name, color: project.color,
    });
    await appendNodes(
      project.children, project.id, options, ledgerRows, agents, herdrSessions,
      overlapScans, pendingCheckouts, aggregates, nodes,
    );
  }
  applyAggregates(nodes, aggregates);
  return { nodes };
}
export function findProjectForPath(projects: readonly Project[], folderPath: string): Project | undefined {
  const key = canonicalKey(folderPath);
  return projects.find((project) => {
    let found = false;
    const visit = (nodes: readonly ProjectNode[]): void => {
      for (const node of nodes) {
        if (node.type === 'folder' && canonicalKey(node.path) === key) found = true;
        if (node.type === 'group') visit(node.children);
      }
    };
    visit(project.children);
    return found;
  });
}
