import type {
  LedgerMergeBlock,
  LedgerOverlapHunk,
  LedgerOverlapScan,
  LedgerRepo,
  LedgerView,
  LedgerWorktree,
} from '../../../../core/src/messages.js';
import { checkoutHealth } from './ledgerHealth.js';
import { normalizeCheckoutPath } from './ledgerSelection.js';

export type BranchStatus = 'collide' | 'rebase' | 'working' | 'ready' | 'merged' | 'trunk';

export interface BranchRow {
  repo: string;
  path: string;
  name: string;
  branch: string | null;
  status: BranchStatus;
  behind: number;
  ahead: number;
  unpushed: number;
  dirty: number;
  collideFiles: number;
  sessionIds: readonly string[];
  cleanable: boolean;
  lastCommitAt: string | null;
  lastCommitSubject: string | null;
}

export interface RepoChips {
  collide: number;
  rebase: number;
  unpushed: number;
  dirty: number;
  cleanable: number;
}

export type ActionKind = 'resolve' | 'rebase' | 'push' | 'merge' | 'train' | 'clean' | 'notify';

export interface TodoItem {
  id: string;
  repo: string;
  kind: ActionKind;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  branches: readonly string[];
  files: readonly string[];
}

export type Touch = 'conflict' | 'auto';

export interface CollisionHunk {
  a: string;
  b: string;
  aLabel: string;
  bLabel: string;
  file: string;
  line: number;
  symbol: string | null;
  ours: string;
  theirs: string;
}

export interface CollisionRow {
  file: string;
  cells: Readonly<Record<string, Touch>>;
  hunks: readonly CollisionHunk[];
}

export interface CollisionMatrix {
  columns: readonly { path: string; label: string }[];
  rows: readonly CollisionRow[];
}

export interface MergeStep {
  path: string;
  label: string;
  reason: string;
}

export interface LiveEditOverlap {
  file: string;
  checkouts: readonly { path: string; label: string; sessionIds: readonly string[] }[];
}

export interface RepoInsight {
  repo: string;
  name: string;
  chips: RepoChips;
  rows: readonly BranchRow[];
  todos: readonly TodoItem[];
  matrix: CollisionMatrix;
  mergeOrder: readonly MergeStep[];
  liveEdits: readonly LiveEditOverlap[];
  scanComplete: boolean;
  mergeBlocks: readonly LedgerMergeBlock[];
}

export interface ActionPlan {
  message: string;
  command: string;
}

interface ClashData {
  readonly branchFiles: Map<string, Set<string>>;
  readonly branchPairs: Map<string, Set<string>>;
  readonly mainBranches: Set<string>;
  readonly matrixRows: Map<string, { cells: Record<string, Touch>; hunks: CollisionHunk[] }>;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MERGE_LANE_SCRIPT = 'C:\\Users\\GIGABYTE\\.omp\\scripts\\merge-lane.py';

export function buildInsights(view: LedgerView, nowMs: number): RepoInsight[] {
  return view.repos.map((repo) => buildRepoInsight(repo, view, nowMs));
}

function buildRepoInsight(repo: LedgerRepo, view: LedgerView, nowMs: number): RepoInsight {
  const scan = view.overlaps.find((candidate) => candidate.repo === repo.repo) ?? null;
  const mergedPaths = new Set(
    repo.worktrees.filter((worktree) => worktree.merged).map((worktree) => normalizeCheckoutPath(worktree.path)),
  );
  const relevantBlocks = view.mergeBlocks.filter((block) => block.repo === repo.repo);
  const recentBlocks = relevantBlocks.filter((block) => isRecentBlock(block, nowMs));
  const latestBlocks = latestBlockByBranch(recentBlocks);
  const clashes = collectClashes(repo.worktrees, scan, mergedPaths);
  const rows = repo.worktrees.map((worktree) => makeBranchRow(
    repo,
    worktree,
    view,
    scan,
    mergedPaths,
    clashes.branchFiles,
    latestBlocks,
  ));
  const todos = makeTodos(repo, rows, clashes, latestBlocks);
  const chips = makeChips(rows, repo.worktrees);
  const matrix = makeMatrix(repo.worktrees, clashes.matrixRows);

  return {
    repo: repo.repo,
    name: repo.name,
    chips,
    rows,
    todos,
    matrix,
    mergeOrder: makeMergeOrder(repo.worktrees, rows, clashes.branchPairs, clashes.mainBranches),
    liveEdits: findLiveEdits(repo.worktrees),
    scanComplete: scan !== null && scan.state === 'done' && scan.complete,
    mergeBlocks: relevantBlocks,
  };
}

function makeBranchRow(
  repo: LedgerRepo,
  worktree: LedgerWorktree,
  view: LedgerView,
  scan: LedgerOverlapScan | null,
  mergedPaths: ReadonlySet<string>,
  branchFiles: ReadonlyMap<string, Set<string>>,
  latestBlocks: ReadonlyMap<string, LedgerMergeBlock>,
): BranchRow {
  const checkout = normalizeCheckoutPath(worktree.path);
  const cleanable = checkoutHealth({
    worktree,
    scan,
    pending: view.pending,
    mergedPaths,
    nowMs: Date.parse(view.generatedAt),
    sessionActivityMs: null,
  }).cleanable;
  const block = worktree.branch === null ? undefined : latestBlocks.get(worktree.branch);
  const hasRecentMergeBlock = block !== undefined && blockIsNewer(block, worktree.lastCommitAt);
  const collideFiles = new Set(branchFiles.get(checkout) ?? []);
  if (hasRecentMergeBlock) for (const file of block.files) collideFiles.add(file);
  let status: BranchStatus;

  if (worktree.isMain) status = 'trunk';
  else if (worktree.merged) status = 'merged';
  else if (collideFiles.size > 0 || hasRecentMergeBlock) status = 'collide';
  else if (worktree.behind > 0) status = 'rebase';
  else if (worktree.sessionIds.length > 0 || worktree.dirtyCount > 0) status = 'working';
  else if (worktree.ahead > 0) status = 'ready';
  else status = 'working';

  return {
    repo: repo.repo,
    path: worktree.path,
    name: worktree.name,
    branch: worktree.branch,
    status,
    behind: worktree.behind,
    ahead: worktree.ahead,
    unpushed: worktree.unpushed ?? 0,
    dirty: worktree.dirtyCount,
    collideFiles: collideFiles.size,
    sessionIds: worktree.sessionIds,
    cleanable,
    lastCommitAt: worktree.lastCommitAt,
    lastCommitSubject: worktree.lastCommitSubject,
  };
}

function makeChips(rows: readonly BranchRow[], worktrees: readonly LedgerWorktree[]): RepoChips {
  const branches = rows.filter((row) => row.status !== 'trunk');
  const worktreeByPath = new Map(worktrees.map((worktree) => [normalizeCheckoutPath(worktree.path), worktree]));
  return {
    collide: branches.filter((row) => row.status === 'collide').length,
    rebase: branches.filter((row) => row.status === 'rebase').length,
    unpushed: branches.filter((row) => {
      const worktree = worktreeByPath.get(normalizeCheckoutPath(row.path));
      return row.unpushed > 0 || (row.ahead > 0 && worktree?.hasUpstream === false);
    }).length,
    dirty: branches.filter((row) => row.dirty > 0).length,
    cleanable: branches.filter((row) => row.cleanable).length,
  };
}

function collectClashes(
  worktrees: readonly LedgerWorktree[],
  scan: LedgerOverlapScan | null,
  mergedPaths: ReadonlySet<string>,
): ClashData {
  const livePaths = new Set(
    worktrees.filter((worktree) => !worktree.isMain && !worktree.merged).map((worktree) => normalizeCheckoutPath(worktree.path)),
  );
  const pathByKey = new Map(worktrees.map((worktree) => [normalizeCheckoutPath(worktree.path), worktree.path]));
  const labelByKey = new Map(worktrees.map((worktree) => [normalizeCheckoutPath(worktree.path), worktree.branch ?? worktree.name]));
  const branchFiles = new Map<string, Set<string>>();
  const branchPairs = new Map<string, Set<string>>();
  const mainBranches = new Set<string>();
  const matrixRows = new Map<string, { cells: Record<string, Touch>; hunks: CollisionHunk[] }>();

  if (scan === null) return { branchFiles, branchPairs, mainBranches, matrixRows };

  for (const pair of scan.pairs) {
    const aKey = normalizeCheckoutPath(pair.a);
    const bKey = normalizeCheckoutPath(pair.b);
    if (!livePaths.has(aKey) || !livePaths.has(bKey) || mergedPaths.has(aKey) || mergedPaths.has(bKey)) continue;
    for (const file of pair.auto) addMatrixTouch(matrixRows, file, pathByKey.get(aKey), 'auto', pathByKey.get(bKey));
    if (pair.conflicts.length === 0) continue;
    const aLabel = pair.aLabel || labelByKey.get(aKey) || pair.a;
    const bLabel = pair.bLabel || labelByKey.get(bKey) || pair.b;
    const aFiles = branchFiles.get(aKey) ?? new Set<string>();
    const bFiles = branchFiles.get(bKey) ?? new Set<string>();
    const aCollisions = branchPairs.get(aKey) ?? new Set<string>();
    const bCollisions = branchPairs.get(bKey) ?? new Set<string>();
    aCollisions.add(bKey);
    bCollisions.add(aKey);
    branchFiles.set(aKey, aFiles);
    branchFiles.set(bKey, bFiles);
    branchPairs.set(aKey, aCollisions);
    branchPairs.set(bKey, bCollisions);
    for (const conflict of pair.conflicts) {
      aFiles.add(conflict.file);
      bFiles.add(conflict.file);
      const row = matrixRow(matrixRows, conflict.file);
      row.cells[pathByKey.get(aKey) ?? pair.a] = 'conflict';
      row.cells[pathByKey.get(bKey) ?? pair.b] = 'conflict';
      for (const hunk of conflict.hunks) {
        row.hunks.push(toCollisionHunk(pair.a, pair.b, aLabel, bLabel, conflict.file, hunk));
      }
    }
  }

  const main = worktrees.find((worktree) => worktree.isMain);
  const mainPath = main?.path;
  for (const item of scan.main) {
    const laneKey = normalizeCheckoutPath(item.lane);
    if (!livePaths.has(laneKey) || mergedPaths.has(laneKey)) continue;
    const laneFiles = branchFiles.get(laneKey) ?? new Set<string>();
    branchFiles.set(laneKey, laneFiles);
    for (const conflict of item.conflicts) {
      laneFiles.add(conflict.file);
      mainBranches.add(laneKey);
      const row = matrixRow(matrixRows, conflict.file);
      row.cells[mainPath ?? item.lane] = 'conflict';
      row.cells[pathByKey.get(laneKey) ?? item.lane] = 'conflict';
      for (const hunk of conflict.hunks) {
        row.hunks.push(toCollisionHunk(mainPath ?? item.lane, item.lane, 'main', item.label, conflict.file, hunk));
      }
    }
  }
  return { branchFiles, branchPairs, mainBranches, matrixRows };
}

function addMatrixTouch(
  rows: Map<string, { cells: Record<string, Touch>; hunks: CollisionHunk[] }>,
  file: string,
  aPath: string | undefined,
  touch: Touch,
  bPath: string | undefined,
): void {
  const row = matrixRow(rows, file);
  if (aPath !== undefined && row.cells[aPath] !== 'conflict') row.cells[aPath] = touch;
  if (bPath !== undefined && row.cells[bPath] !== 'conflict') row.cells[bPath] = touch;
}

function matrixRow(
  rows: Map<string, { cells: Record<string, Touch>; hunks: CollisionHunk[] }>,
  file: string,
): { cells: Record<string, Touch>; hunks: CollisionHunk[] } {
  let row = rows.get(file);
  if (row === undefined) {
    row = { cells: {}, hunks: [] };
    rows.set(file, row);
  }
  return row;
}

function toCollisionHunk(
  a: string,
  b: string,
  aLabel: string,
  bLabel: string,
  file: string,
  hunk: LedgerOverlapHunk,
): CollisionHunk {
  return {
    a,
    b,
    aLabel,
    bLabel,
    file,
    line: hunk.line,
    symbol: hunk.symbol || null,
    ours: hunk.ours.join('\n'),
    theirs: hunk.theirs.join('\n'),
  };
}

function makeMatrix(
  worktrees: readonly LedgerWorktree[],
  sourceRows: ReadonlyMap<string, { cells: Record<string, Touch>; hunks: CollisionHunk[] }>,
): CollisionMatrix {
  const main = worktrees.find((worktree) => worktree.isMain);
  const columns = [
    ...(main === undefined ? [] : [{ path: main.path, label: 'main' }]),
    ...worktrees
      .filter((worktree) => !worktree.isMain && !worktree.merged)
      .map((worktree) => ({ path: worktree.path, label: worktree.branch ?? worktree.name })),
  ];
  const rows = Array.from(sourceRows, ([file, value]) => ({ file, cells: value.cells, hunks: value.hunks }));
  rows.sort((a, b) => Number(!hasConflictCell(a.cells)) - Number(!hasConflictCell(b.cells)) || a.file.localeCompare(b.file));
  return { columns, rows };
}
function hasConflictCell(cells: Readonly<Record<string, Touch>>): boolean {
  return Object.values(cells).some((touch) => touch === 'conflict');
}

function makeTodos(
  repo: LedgerRepo,
  rows: readonly BranchRow[],
  clashes: ClashData,
  latestBlocks: ReadonlyMap<string, LedgerMergeBlock>,
): TodoItem[] {
  const todos: TodoItem[] = [];
  const rowsByPath = new Map(rows.map((row) => [normalizeCheckoutPath(row.path), row]));
  const resolveBranches = new Map<string, Set<string>>();
  for (const path of clashes.mainBranches) {
    const row = rowsByPath.get(path);
    if (row?.branch !== null && row !== undefined && row.status !== 'merged') {
      resolveBranches.set(row.branch, new Set(clashes.branchFiles.get(path) ?? []));
    }
  }
  for (const [branch, block] of latestBlocks) {
    const row = rows.find((candidate) => candidate.branch === branch);
    if (row === undefined || row.status === 'merged' || !blockIsNewer(block, row.lastCommitAt)) continue;
    const files = resolveBranches.get(branch) ?? new Set<string>();
    for (const file of block.files) files.add(file);
    resolveBranches.set(branch, files);
  }
  for (const [branch, files] of resolveBranches) {
    const row = rows.find((candidate) => candidate.branch === branch);
    if (row === undefined) continue;
    const fileList = [...files].sort();
    todos.push(todo(repo.repo, 'resolve', 'high', `Gỡ đụng ở ${branch}`, `${branch} đụng ${fileList.length} tệp; xem kỹ các thay đổi trước khi gộp.`, [branch], fileList));
  }

  for (const [path, others] of clashes.branchPairs) {
    const row = rowsByPath.get(path);
    if (row === undefined || row.branch === null) continue;
    for (const otherPath of others) {
      if (path.localeCompare(otherPath) >= 0) continue;
      const other = rowsByPath.get(otherPath);
      if (other?.branch === null || other === undefined) continue;
      const files = clashes.branchFiles.get(path) ?? new Set<string>();
      const sharedFiles = [...files].filter((file) => (clashes.branchFiles.get(otherPath) ?? new Set()).has(file)).sort();
      todos.push(todo(repo.repo, 'notify', 'high', `Báo hai nhánh đụng`, `${row.branch} và ${other.branch} cùng sửa ${sharedFiles.length} tệp; báo agent xử lý trước khi gộp.`, [row.branch, other.branch], sharedFiles));
    }
  }

  const behindRows = rows.filter((row) => row.status === 'rebase').sort((a, b) => b.behind - a.behind);
  if (behindRows.length === 1) {
    const row = behindRows[0]!;
    todos.push(todo(repo.repo, 'rebase', 'medium', `Rebase ${row.branch ?? row.name}`, `${row.branch ?? row.name} tụt sau main ${row.behind} commit.`, [row.branch ?? row.name], []));
  } else if (behindRows.length > 1) {
    const branches = behindRows.map((row) => row.branch ?? row.name);
    const leaders = behindRows.slice(0, 2).map((row) => `${row.branch ?? row.name} (${row.behind})`).join(', ');
    todos.push(todo(repo.repo, 'rebase', 'medium', `Rebase ${behindRows.length} nhánh`, `Tụt nhiều nhất: ${leaders} commit; rebase nhánh tụt nhiều trước.`, branches, []));
  }

  const pushRows = rows.filter((row) => {
    if (row.status === 'trunk' || row.status === 'merged') return false;
    const worktree = repo.worktrees.find((candidate) => normalizeCheckoutPath(candidate.path) === normalizeCheckoutPath(row.path));
    const missingUpstream = worktree !== undefined && !worktree.hasUpstream && worktree.ahead > 0;
    return row.unpushed > 0 || missingUpstream;
  });
  if (pushRows.length === 1) {
    const row = pushRows[0]!;
    const branch = row.branch ?? row.name;
    todos.push(todo(repo.repo, 'push', 'medium', `Đẩy ${branch}`, `${branch} có ${row.unpushed > 0 ? `${row.unpushed} commit chưa đẩy` : 'commit chưa có trên GitHub'}.`, [branch], []));
  } else if (pushRows.length > 1) {
    const branches = pushRows.map((row) => row.branch ?? row.name);
    todos.push(todo(repo.repo, 'push', 'medium', `Đẩy ${pushRows.length} nhánh`, `Commit chỉ nằm trên máy: ${branches.slice(0, 3).join(', ')}${branches.length > 3 ? '…' : ''}.`, branches, []));
  }

  const ready = rows.filter((row) => row.status === 'ready');
  if (ready.length === 1) {
    const row = ready[0]!;
    const branch = row.branch ?? row.name;
    todos.push(todo(repo.repo, 'merge', 'low', `Gộp ${branch}`, `${branch} sạch và sẵn sàng gộp vào main.`, [branch], []));
  } else if (ready.length > 1) {
    const branches = ready.map((row) => row.branch ?? row.name);
    todos.push(todo(repo.repo, 'train', 'low', `Gộp lượt ${ready.length} nhánh`, `${branches.join(', ')} đều sạch và không đụng nhau; có thể gộp cùng lượt.`, branches, []));
  }

  const cleanRows = rows.filter((row) => row.cleanable);
  if (cleanRows.length === 1) {
    const row = cleanRows[0]!;
    todos.push(todo(repo.repo, 'clean', 'low', `Dọn ${row.name}`, `${row.name} đã gộp, không còn phiên hay thay đổi chưa lưu.`, [row.branch ?? row.name], []));
  } else if (cleanRows.length > 1) {
    todos.push(todo(repo.repo, 'clean', 'low', `Dọn ${cleanRows.length} worktree`, `Đã gộp, không còn phiên hay thay đổi chưa lưu: ${cleanRows.slice(0, 3).map((row) => row.name).join(', ')}${cleanRows.length > 3 ? '…' : ''}.`, cleanRows.map((row) => row.branch ?? row.name), []));
  }
  return todos;
}

function todo(
  repo: string,
  kind: ActionKind,
  severity: TodoItem['severity'],
  title: string,
  detail: string,
  branches: readonly string[],
  files: readonly string[],
): TodoItem {
  return { id: `${kind}:${branches.join(',')}:${files.join(',')}`, repo, kind, severity, title, detail, branches, files };
}

function makeMergeOrder(
  worktrees: readonly LedgerWorktree[],
  rows: readonly BranchRow[],
  branchPairs: ReadonlyMap<string, Set<string>>,
  mainBranches: ReadonlySet<string>,
): MergeStep[] {
  const candidates = worktrees.filter((worktree) => !worktree.isMain && !worktree.merged);
  const ranked = [...candidates].sort((a, b) => {
    const aKey = normalizeCheckoutPath(a.path);
    const bKey = normalizeCheckoutPath(b.path);
    const aDegree = (branchPairs.get(aKey)?.size ?? 0) + Number(mainBranches.has(aKey));
    const bDegree = (branchPairs.get(bKey)?.size ?? 0) + Number(mainBranches.has(bKey));
    if ((aDegree === 0) !== (bDegree === 0)) return aDegree === 0 ? -1 : 1;
    if (aDegree === 0) return a.behind - b.behind || a.ahead - b.ahead;
    return a.ahead - b.ahead || a.behind - b.behind;
  });
  return ranked.map((worktree) => {
    const row = rows.find((candidate) => normalizeCheckoutPath(candidate.path) === normalizeCheckoutPath(worktree.path));
    const path = normalizeCheckoutPath(worktree.path);
    const conflicts = branchPairs.get(path) ?? new Set<string>();
    const hasMainConflict = mainBranches.has(path);
    const reason = conflicts.size === 0 && !hasMainConflict
      ? `${worktree.name} không đụng nhánh sống khác; tụt ${worktree.behind} commit.`
      : `${worktree.name} gộp trước để nhánh sau rebase; ahead ${worktree.ahead}, tụt ${worktree.behind}.`;
    return { path: worktree.path, label: row?.branch ?? worktree.name, reason };
  });
}

function findLiveEdits(worktrees: readonly LedgerWorktree[]): LiveEditOverlap[] {
  const files = new Map<string, Map<string, LedgerWorktree>>();
  for (const worktree of worktrees) {
    for (const dirtyFile of worktree.dirtyFiles) {
      const checkouts = files.get(dirtyFile.path) ?? new Map<string, LedgerWorktree>();
      checkouts.set(normalizeCheckoutPath(worktree.path), worktree);
      files.set(dirtyFile.path, checkouts);
    }
  }
  return [...files]
    .filter(([, checkouts]) => checkouts.size >= 2)
    .map(([file, checkouts]) => ({
      file,
      checkouts: [...checkouts.values()].map((worktree) => ({
        path: worktree.path,
        label: worktree.branch ?? worktree.name,
        sessionIds: worktree.sessionIds,
      })),
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

function isRecentBlock(block: LedgerMergeBlock, nowMs: number): boolean {
  const time = Date.parse(block.at);
  return Number.isFinite(time) && time <= nowMs && nowMs - time <= SEVEN_DAYS_MS;
}

function latestBlockByBranch(blocks: readonly LedgerMergeBlock[]): Map<string, LedgerMergeBlock> {
  const latest = new Map<string, LedgerMergeBlock>();
  for (const block of blocks) {
    const current = latest.get(block.branch);
    if (current === undefined || Date.parse(block.at) > Date.parse(current.at)) latest.set(block.branch, block);
  }
  return latest;
}

function blockIsNewer(block: LedgerMergeBlock, lastCommitAt: string | null): boolean {
  const blockTime = Date.parse(block.at);
  const commitTime = lastCommitAt === null ? Number.NEGATIVE_INFINITY : Date.parse(lastCommitAt);
  return Number.isFinite(blockTime) && (!Number.isFinite(commitTime) || blockTime > commitTime);
}

function actionRow(item: TodoItem, insight: RepoInsight): BranchRow | undefined {
  return insight.rows.find((row) => item.branches.includes(row.branch ?? row.name));
}

/**
 * The message for the agents and the command to copy. A todo over several branches
 * (rebase, push, clean) gets one command line per branch; `actionPlan` of a one-branch
 * copy of the todo is what each branch's own agent receives.
 */
export function actionPlan(item: TodoItem, insight: RepoInsight): ActionPlan {
  if (item.branches.length > 1 && (item.kind === 'rebase' || item.kind === 'push' || item.kind === 'clean')) {
    const plans = item.branches.map((branch) => actionPlan({ ...item, branches: [branch] }, insight));
    return {
      message: `Việc cần làm cho ${item.branches.length} nhánh, mỗi nhánh một lệnh: ${plans.map((plan) => plan.command).join(' ; ')}. Không tự chạy lệnh trên board.`,
      command: plans.map((plan) => plan.command).join('\n'),
    };
  }
  const row = actionRow(item, insight);
  const path = row?.path ?? insight.repo;
  const branch = item.branches[0] ?? row?.branch ?? row?.name ?? insight.name;
  const files = item.files.length > 0 ? item.files.join(', ') : 'các thay đổi của nhánh';
  const hunk = insight.matrix.rows
    .filter((matrixRow) => item.files.includes(matrixRow.file))
    .flatMap((matrixRow) => matrixRow.hunks)
    .find((candidate) => candidate.b === row?.path || candidate.a === row?.path);
  const location = hunk === undefined ? '' : ` tại dòng ${hunk.line}${hunk.symbol === null ? '' : `, hàm ${hunk.symbol}`}`;
  let command: string;
  let instruction: string;

  switch (item.kind) {
    case 'resolve':
    case 'rebase':
      command = `git -C ${path} rebase origin/main`;
      instruction = `${branch}: rebase lên origin/main rồi xử lý ${files}${location}`;
      break;
    case 'push':
      command = `git -C ${path} push -u origin HEAD`;
      instruction = `${branch}: đẩy commit lên remote bằng lệnh ${command}`;
      break;
    case 'merge':
      command = `python ${MERGE_LANE_SCRIPT} ${path} --push`;
      instruction = `${branch}: kiểm tra rồi gộp qua merge-lane bằng lệnh ${command}`;
      break;
    case 'train':
      command = `python ${MERGE_LANE_SCRIPT} ${insight.repo} --train "${item.branches.join(' ')}" --push`;
      instruction = `Gộp các nhánh ${item.branches.join(', ')} theo lượt bằng lệnh ${command}`;
      break;
    case 'clean':
      command = `git-wt remove ${row?.name ?? branch} -y`;
      instruction = `Dọn worktree ${row?.name ?? branch} bằng lệnh ${command}`;
      break;
    case 'notify':
      command = `git -C ${path} diff origin/main...HEAD -- ${files}`;
      instruction = `${branch}: xem ${files}${location}, kiểm tra thay đổi của nhánh ${item.branches[1] ?? 'còn lại'} trước khi gộp`;
      break;
  }

  return {
    message: `Việc cần làm: ${instruction}. Lệnh gợi ý: ${command}. Khi gỡ xung đột, hãy giữ ý định cả hai bên theo AGENTS §6; không tự chạy lệnh trên board.`,
    command,
  };
}
