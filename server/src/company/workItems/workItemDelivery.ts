/**
 * workItemDelivery: how far an item's branch has travelled toward production, and what is missing.
 *
 * The board answers one question per item, for the user and for a CLI agent alike: is the work only
 * in the worktree, committed on its branch, on origin/staging, or in origin/main, and what is the next
 * command. "In" is a content test, not ancestry: merge-lane squashes a branch into one commit, so the
 * branch is never an ancestor of main. A branch is in a target when merging it into the target changes
 * nothing (`git merge-tree --write-tree` yields the target's own tree), the test worktree-prune uses.
 */

import type { WorkItemDelivery, WorkItemDeliveryStage } from '../../../../core/src/messages.js';
import type { CommandRunner, SquadWorktree } from './squadWorktree.js';

const GIT_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 120_000;
/** Tool output the agents must not commit; counting it would keep every item "uncommitted". */
const IGNORED_DIRTY = /(^|\/)\.ripwire_quality_baseline$/;
const SCRIPTS = 'C:\\Users\\GIGABYTE\\.omp\\scripts';

/** What git said about one branch, before it is turned into a stage and a next step. */
export interface DeliveryFacts {
  readonly branch: string;
  /** The worktree path, or undefined when its directory is gone. */
  readonly worktreePath: string | undefined;
  readonly dirtyFiles: number;
  readonly commitsAhead: number;
  readonly inMain: boolean;
  /** Null when the repo has no origin/staging. */
  readonly inStaging: boolean | null;
}

/** The stage a branch has reached; uncommitted work comes first, whatever else is true. */
export function deliveryStage(facts: DeliveryFacts): WorkItemDeliveryStage {
  if (facts.dirtyFiles > 0) return 'uncommitted';
  if (facts.inMain) return 'main';
  if (facts.commitsAhead === 0) return 'no_commits';
  if (facts.inStaging === true) return 'staging';
  return 'branch';
}

/** One line naming what is missing and the command that fixes it, with the real path and branch. */
export function deliveryNextStep(facts: DeliveryFacts, stage: WorkItemDeliveryStage): string {
  const where = facts.worktreePath ?? `nhánh ${facts.branch} (worktree đã dọn: mở lại bằng git worktree add <đường dẫn> ${facts.branch})`;
  const checkout = facts.worktreePath ?? '<worktree mở lại từ nhánh>';
  switch (stage) {
    case 'uncommitted':
      return `Còn ${facts.dirtyFiles} file chưa commit trong ${where}. Commit hẹp trên nhánh ${facts.branch} (git add đúng file, không git add .), rồi mới lên staging.`;
    case 'no_commits':
      return `Nhánh ${facts.branch} chưa có commit nào ngoài origin/main: chưa có gì để gộp. Agent cần làm và commit trên ${where}.`;
    case 'branch':
      return facts.inStaging === null
        ? `Đã commit ${facts.commitsAhead} commit, repo không có nhánh staging. Lên main (deploy production): python ${SCRIPTS}\\merge-lane.py ${checkout} --check "<test liên quan>" --push`
        : `Đã commit ${facts.commitsAhead} commit, chưa lên staging. Lên staging: python ${SCRIPTS}\\staging-sync.py với worktree ${checkout} --branch ${facts.branch} (người dùng nói "lên staging").`;
    case 'staging':
      return `Đã lên staging, chưa vào main. Kiểm trên staging.sporto.asia rồi lên main (deploy production): python ${SCRIPTS}\\merge-lane.py ${checkout} --check "<test liên quan>" --push`;
    case 'main':
      return facts.worktreePath === undefined
        ? 'Đã vào origin/main. Xong hẳn.'
        : `Đã vào origin/main. Có thể bấm Dọn worktree (${facts.worktreePath}); nhánh vẫn giữ.`;
  }
}

/** The wire value for a set of facts, stamped with when they were read. */
export function toDelivery(facts: DeliveryFacts, checkedAt: string): WorkItemDelivery {
  const stage = deliveryStage(facts);
  return {
    checkedAt,
    branch: facts.branch,
    stage,
    dirtyFiles: facts.dirtyFiles,
    commitsAhead: facts.commitsAhead,
    inStaging: facts.inStaging,
    inMain: facts.inMain,
    nextStep: deliveryNextStep(facts, stage),
  };
}

const STAGES: readonly WorkItemDeliveryStage[] = ['uncommitted', 'no_commits', 'branch', 'staging', 'main'];

/** A stored delivery read back from the file; anything malformed is dropped and checked again. */
export function parseDelivery(value: unknown): WorkItemDelivery | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
  if (typeof v.checkedAt !== 'string' || typeof v.branch !== 'string' || v.branch === '') return undefined;
  if (!STAGES.includes(v.stage as WorkItemDeliveryStage)) return undefined;
  if (!count(v.dirtyFiles) || !count(v.commitsAhead) || typeof v.inMain !== 'boolean') return undefined;
  if (v.inStaging !== null && typeof v.inStaging !== 'boolean') return undefined;
  if (typeof v.nextStep !== 'string') return undefined;
  return {
    checkedAt: v.checkedAt,
    branch: v.branch,
    stage: v.stage as WorkItemDeliveryStage,
    dirtyFiles: v.dirtyFiles,
    commitsAhead: v.commitsAhead,
    inStaging: v.inStaging,
    inMain: v.inMain,
    nextStep: v.nextStep.slice(0, 600),
  };
}

/** Whether two deliveries say the same thing, origin fetch time included. */
export function sameDelivery(left: WorkItemDelivery | undefined, right: WorkItemDelivery | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.checkedAt === right.checkedAt &&
    left.branch === right.branch &&
    left.stage === right.stage &&
    left.dirtyFiles === right.dirtyFiles &&
    left.commitsAhead === right.commitsAhead &&
    left.inStaging === right.inStaging &&
    left.inMain === right.inMain &&
    left.nextStep === right.nextStep
  );
}

/** Brings origin's refs up to date. False when git failed (network, auth): the refs stay as last fetched. */
export async function fetchOrigin(repo: string, run: CommandRunner): Promise<boolean> {
  const result = await run('git', ['fetch', 'origin', '--quiet', '--prune'], repo, FETCH_TIMEOUT_MS);
  return result.code === 0;
}

async function git(repo: string, run: CommandRunner, ...args: string[]): Promise<string | undefined> {
  const result = await run('git', args, repo, GIT_TIMEOUT_MS);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** Whether merging `branch` into `target` leaves `target`'s tree unchanged: its content is already there. */
async function contentIn(repo: string, run: CommandRunner, target: string, branch: string): Promise<boolean> {
  const targetTree = await git(repo, run, 'rev-parse', `${target}^{tree}`);
  const merged = await git(repo, run, 'merge-tree', '--write-tree', target, branch);
  return targetTree !== undefined && merged !== undefined && merged.split(/\r?\n/)[0] === targetTree;
}

/**
 * Reads the facts for one item's branch from the repo (origin refs as last fetched) and its worktree.
 * Undefined when the branch no longer exists or origin/main is unknown.
 */
export async function probeDelivery(
  repo: string,
  worktree: SquadWorktree,
  worktreePresent: boolean,
  run: CommandRunner,
): Promise<DeliveryFacts | undefined> {
  if ((await git(repo, run, 'rev-parse', '--verify', '--quiet', `refs/heads/${worktree.branch}`)) === undefined) return undefined;
  if ((await git(repo, run, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main')) === undefined) return undefined;
  const ahead = Number(await git(repo, run, 'rev-list', '--count', `origin/main..${worktree.branch}`));
  const hasStaging = (await git(repo, run, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/staging')) !== undefined;
  const status = worktreePresent ? await git(worktree.path, run, 'status', '--porcelain') : '';
  const dirtyFiles = (status ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !IGNORED_DIRTY.test(line.slice(3).trim().replace(/\\/g, '/')))
    .length;
  return {
    branch: worktree.branch,
    worktreePath: worktreePresent ? worktree.path : undefined,
    dirtyFiles,
    commitsAhead: Number.isFinite(ahead) ? ahead : 0,
    inMain: await contentIn(repo, run, 'origin/main', worktree.branch),
    inStaging: hasStaging ? await contentIn(repo, run, 'origin/staging', worktree.branch) : null,
  };
}
