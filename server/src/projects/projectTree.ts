import * as path from 'node:path';

import type { LedgerOverlapScan, ProjectTreeNode } from '../../../core/src/messages.js';
import { listFolderRepos } from '../company/workItems/folderRepos.js';
import {
  LEDGER_DEV_NULL,
  LEDGER_DIFF_MAX_BYTES,
  LEDGER_DIFF_TIMEOUT_MS,
  LEDGER_GIT_MAX_BYTES,
} from '../ledger/constants.js';
import { type GitRunner, type GitRunOptions, readRepo } from '../ledger/git.js';
import type { LedgerSource, SessionRow } from '../ledger/ledgerDb.js';
import { normalizeLedgerPath } from '../ledger/ledgerPath.js';
import type { AgentState } from '../types.js';
import { type Project, type ProjectNode, ProjectStore } from './projectStore.js';

export interface ProjectSessionSnapshot {
  readonly engine: NonNullable<ProjectTreeNode['engine']>;
  readonly agentKind: NonNullable<ProjectTreeNode['agentKind']>;
  readonly id: string;
  readonly status: string;
  readonly title: string;
  readonly cwd: string;
}

export interface HerdrProjectSession {
  readonly id: string;
  readonly cwd: string;
  readonly status: string;
  readonly title: string;
}

export interface ProjectTreeSnapshot {
  readonly nodes: ProjectTreeNode[];
}

export interface ProjectTreeOptions {
  readonly ledger: LedgerSource;
  readonly git: GitRunner;
  readonly agents?: Iterable<AgentState>;
  readonly herdrSessions?: () => readonly HerdrProjectSession[];
  readonly overlapScans?: () => Promise<readonly LedgerOverlapScan[]>;
  readonly listRepos?: typeof listFolderRepos;
}
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

function titleForLedger(row: SessionRow): string {
  return row.agentName ?? '';
}

function ledgerStatus(row: SessionRow): string {
  if (row.endedAt !== null) return 'ended';
  const state = row.state?.toLowerCase();
  if (state === 'waiting' || state === 'waiting_input' || state === 'idle') return state;
  return 'running';
}

function sessionsForCheckout(
  checkout: string,
  ledgerRows: readonly SessionRow[],
  agents: readonly AgentState[],
  herdrSessions: readonly HerdrProjectSession[],
): ProjectSessionSnapshot[] {
  const sessions: ProjectSessionSnapshot[] = [];
  for (const row of ledgerRows) {
    if (row.cwd === null || !pathContains(checkout, row.cwd)) continue;
    sessions.push({
      engine: engineForLedger(row),
      agentKind: agentKindForLedger(row),
      id: row.sessionId,
      status: ledgerStatus(row),
      title: titleForLedger(row),
      cwd: row.cwd,
    });
  }
  for (const agent of agents) {
    if (!pathContains(checkout, agent.projectDir)) continue;
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
    if (!pathContains(checkout, session.cwd)) continue;
    sessions.push({ engine: 'herdr', agentKind: 'herdr', ...session });
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

interface FileChangeCount {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
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
  for (const filePath of untracked.stdout.split('\0')) {
    if (!validRelativeFile(filePath) || files.has(filePath)) continue;
    const stat = await git.run(
      checkout,
      ['diff', '--no-index', '--numstat', '--', LEDGER_DEV_NULL, filePath],
      UNTRACKED_STAT_OPTIONS,
    );
    if (!stat.ok || stat.truncated) continue;
    const [change] = parseNumstat(stat.stdout);
    if (change !== undefined) files.set(filePath, change);
  }
  return [...files.values()];
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
  ledgerRows: readonly SessionRow[],
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
    const repos = await (options.listRepos ?? listFolderRepos)(node.path);
    for (const repoPath of repos) {
      const scan = await readRepo(options.git, repoPath);
      if (scan.kind !== 'repo') continue;
      const mainCheckout = scan.worktrees.find((worktree) => worktree.isMain);
      if (mainCheckout === undefined || canonicalKey(mainCheckout.path) !== canonicalKey(repoPath)) continue;

      const repoId = repoPath;
      output.push({
        id: repoId, parentId: node.id, kind: 'repository', name: path.basename(repoPath), path: repoPath,
      });
      aggregates.set(repoId, emptyAggregate());
      for (const worktree of scan.worktrees) {
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

        const files = await changedFiles(options.git, worktree.path);
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

        for (const session of sessionsForCheckout(worktree.path, ledgerRows, agents, herdrSessions)) {
          output.push({
            id: `${session.agentKind}:${session.id}`,
            parentId: worktree.path,
            kind: 'session',
            name: session.title || session.id,
            engine: session.engine,
            agentKind: session.agentKind,
            sessionId: session.id,
            state: session.status,
            title: session.title,
            path: session.cwd,
          });
        }
      }
    }
  }
}

export async function buildProjectTreeSnapshot(
  store: ProjectStore,
  options: ProjectTreeOptions,
): Promise<ProjectTreeSnapshot> {
  const state = await store.load();
  const ledgerRows = options.ledger.sessionRows();
  const pendingCheckouts = new Set(options.ledger.pendingRows().map((row) => canonicalKey(row.checkout)));
  const overlapScans = await (options.overlapScans?.() ?? Promise.resolve([]));
  const agents = [...(options.agents ?? [])];
  const herdrSessions = options.herdrSessions?.() ?? [];
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
