/**
 * Squad scheduler: decides whether one ready work item may start now, and on which member.
 *
 * Pure: the service gathers the members, the running items, the capacity limits and the free memory,
 * then applies the decision. Nothing here touches the disk, a herdr socket, or a clock.
 *
 * Rules:
 * - Every running item (running or waiting on input) holds one member and counts toward the folder's
 *   parallel limit, read-only items included.
 * - An editing item takes its areas and its checkout (the member's working folder). Two running
 *   editing items may not share an area, nor a checkout. A read-only item takes neither.
 * - A member busy with work the board did not send (a herdr pane working on its own, an omp session
 *   mid-turn) locks its checkout for editing items, as a running item does. Read-only items ignore it.
 * - An explicit assignee (herdr pane, omp session) runs only when it is free and not held. A new
 *   session for an explicit item opens in the item's repo.
 * - An auto item picks a free member that serves its repo: one inside the repo, or a session the
 *   squad opened for it. It prefers a role note that names its role, then a session the squad opened
 *   for this repo with its role, then any other compatible member. With none free, it opens a new
 *   session when the squad session cap and the free-RAM threshold allow. Otherwise it waits with the
 *   reason.
 *   A subagent other than task (e.g. scout, reviewer) runs only in an omp session, which the dispatch
 *   asks to call its task tool with it. An auto item with such an agent never picks a herdr pane.
 * - A new session for an editing item is isolated: it runs in its own worktree, which the service
 *   creates in the item's repo, so it never shares a checkout with another agent. A read-only item
 *   opens in the repo itself.
 */

import { COMPANY_HOST_ROLE_BY_ROLE } from '../../../../core/src/company.js';
import type {
  CompanyRole,
  WorkItemAssignee,
  WorkItemAssigneeKind,
  WorkItemBlocker,
} from '../../../../core/src/messages.js';
import { blockerReason } from '../../../../core/src/workItemGraph.js';
import { DEFAULT_AGENT } from './dispatchPrompt.js';
import { GIB } from './squadSettings.js';

/** One queued or running item, as the scheduler reads it. */
export interface SchedulerItem {
  readonly sequence: number;
  readonly kind: WorkItemAssigneeKind;
  /** Member key of a herdr or session assignee; undefined for auto, new-session and claude items. */
  readonly memberKey: string | undefined;
  /** Canonical repo or checkout the item works in; the folder root when the item names none. */
  readonly repo: string;
  readonly role: CompanyRole | undefined;
  readonly readOnly: boolean;
  readonly areas: readonly string[];
  /** Keeps the selected checkout as the CLI cwd and locks it while the item is live. */
  readonly inPlace?: boolean;
  /** Omp subagent the item runs under. Undefined and the default worker (`task`) take any member. */
  readonly agent?: string;
}

/** One herdr pane or omp session the squad could send an item to. */
export interface SchedulerMember {
  /** `herdr:<paneId>` or `session:<sessionId>`. */
  readonly key: string;
  readonly assignee: WorkItemAssignee;
  /** The checkout the member runs in. Undefined when the member reports none. */
  readonly cwd: string | undefined;
  /** The session's role. Undefined for a herdr pane, which fits any role. */
  readonly role: CompanyRole | undefined;
  /** The user's role note for this member, if any. */
  readonly note: string | undefined;
  /** Whether the member reads as idle this pass. */
  readonly free: boolean;
  /** Whether the member is known to be working or waiting on input this pass. Unknown reads as neither. */
  readonly busy: boolean;
  /** The repo the squad opened this session for; undefined when the board did not open it. */
  readonly squadRepo: string | undefined;
}

/** An item that holds a member right now. */
export interface SchedulerHold {
  readonly memberKey: string;
  readonly sequence: number;
  readonly readOnly: boolean;
  readonly areas: readonly string[];
  /** The repo the holding item works in, as SchedulerItem.repo names it: its areas live there. */
  readonly repo: string;
  /** The holding member's checkout, if known. */
  readonly checkout: string | undefined;
}

/** Everything a decision reads, gathered once per call by the service. */
export interface SchedulerContext {
  readonly members: readonly SchedulerMember[];
  readonly holds: readonly SchedulerHold[];
  readonly maxParallel: number;
  readonly maxSquadSessions: number;
  /** Live sessions the squad opened. */
  readonly squadSessionsOpen: number;
  readonly freeBytes: number;
  readonly minFreeBytes: number;
  /** Claude Code runs in flight. Each also holds a slot in the folder cap. */
  readonly claudeRunsOpen: number;
  readonly maxClaudeRuns: number;
  /** Antigravity runs in flight. */
  readonly agyRunsOpen: number;
  readonly maxAgyRuns: number;
  /** CLI used for auto worker assignments. */
  readonly engineWorker: 'omp' | 'claude' | 'agy';
}

/** What the service should do with a ready item. */
export type SchedulerDecision =
  | { readonly kind: 'use'; readonly member: SchedulerMember }
  /**
   * Open a new session with `role` in `cwd`. When `isolate` is set the service first creates a
   * worktree of `cwd`'s repo and opens the session there instead.
   */
  | {
      readonly kind: 'open';
      readonly cwd: string;
      readonly role: CompanyRole;
      readonly isolate: boolean;
    }
  /**
   * Start one Claude Code run (claude -p) for the item. An editing run gets its own worktree of
   * `cwd`'s repo; a read-only run works in `cwd` itself.
   */
  | { readonly kind: 'claude'; readonly cwd: string; readonly readOnly: boolean }
  /** Start one Antigravity CLI run, in the repo or an editing worktree. */
  | { readonly kind: 'agy'; readonly cwd: string; readonly readOnly: boolean }
  | { readonly kind: 'wait'; readonly blocker: WorkItemBlocker; readonly reason: string };

/** Lowercase path key: forward slashes, no trailing slash. Windows paths compare case-insensitively. */
export function checkoutKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * The workstream a squad session opens under: one per role and checkout. The pool resumes a parked
 * session that has the same key, so a squad gets its parked session back for that checkout.
 */
export function squadWorkstreamKey(role: CompanyRole, cwd: string): string {
  return `squad:${role}:${checkoutKey(cwd)}`;
}

/**
 * The role a squad workstream key names, or undefined for any other workstream. A compact squad runs
 * its work in a chat session (prompted directly, no contract) under its item's role key, and that
 * role picks the session's model: the key is persisted with the session, so park and resume keep it.
 */
export function squadWorkstreamRole(workstreamId: string): CompanyRole | undefined {
  const role = /^squad:([a-z]+):/.exec(workstreamId)?.[1];
  return role !== undefined && Object.hasOwn(COMPANY_HOST_ROLE_BY_ROLE, role) ? (role as CompanyRole) : undefined;
}

/** Whether a checkout is the repo itself or a folder inside it. Undefined is never inside. */
export function isInsideRepo(checkout: string | undefined, repo: string): boolean {
  if (checkout === undefined) return false;
  const path = checkoutKey(checkout);
  const root = checkoutKey(repo);
  return path === root || path.startsWith(`${root}/`);
}

/** Whether two code areas overlap: the same area, or one is a folder of the other. */
export function areasOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** The last segment of a checkout path, as the board names it. */
export function checkoutName(checkout: string): string {
  return checkout.split(/[\\/]/).filter((part) => part !== '').pop() ?? checkout;
}

/** Decides one ready item. Callers check dependencies first; this only looks at agents and limits. */
export function decideStart(item: SchedulerItem, ctx: SchedulerContext): SchedulerDecision {
  if (item.kind === 'herdr' || item.kind === 'session') return decideNamed(item, ctx);
  if (ctx.holds.length >= ctx.maxParallel) return capacityWait(ctx);
  if (item.kind === 'new-session') return decideOpen(item, ctx);
  if (item.kind === 'claude') return decideClaude(item, ctx);
  if (item.kind === 'agy') return decideAgy(item, ctx);
  return decideAuto(item, ctx);
}

function decideNamed(item: SchedulerItem, ctx: SchedulerContext): SchedulerDecision {
  const member = ctx.members.find((entry) => entry.key === item.memberKey);
  const held = ctx.holds.some((hold) => hold.memberKey === item.memberKey);
  if (member === undefined || !member.free || held) {
    return waitWith({ kind: 'agent' });
  }
  if (ctx.holds.length >= ctx.maxParallel) return capacityWait(ctx);
  const blocker = conflictWith(item, member.cwd, ctx);
  if (blocker !== undefined) return waitWith(blocker);
  return { kind: 'use', member };
}

function decideOpen(item: SchedulerItem, ctx: SchedulerContext): SchedulerDecision {
  // An editing item runs in its own worktree, so no checkout is shared; its areas still apply.
  const blocker = conflictWith(item, undefined, ctx);
  if (blocker !== undefined) return waitWith(blocker);
  return {
    kind: 'open',
    cwd: item.repo,
    role: item.role ?? 'chat',
    isolate: !item.readOnly,
  };
}

/**
 * Starts one Claude Code run when the claude run cap has room and no area conflicts. An editing run
 * works in its own worktree, so only the areas can conflict.
 */
function decideClaude(item: SchedulerItem, ctx: SchedulerContext): SchedulerDecision {
  if (ctx.claudeRunsOpen >= ctx.maxClaudeRuns) {
    return waitWith({ kind: 'capacity', running: ctx.claudeRunsOpen, limit: ctx.maxClaudeRuns });
  }
  const blocker = conflictWith(item, item.inPlace ? item.repo : undefined, ctx);
  if (blocker !== undefined) return waitWith(blocker);
  return { kind: 'claude', cwd: item.repo, readOnly: item.readOnly };
}

function decideAuto(item: SchedulerItem, ctx: SchedulerContext): SchedulerDecision {
  const held = new Set(ctx.holds.map((hold) => hold.memberKey));
  // A subagent runs only in an omp session, where the dispatch asks for its task tool; a pane cannot.
  const subagent = item.agent !== undefined && item.agent !== DEFAULT_AGENT;
  const serving = ctx.members.filter(
    (member) =>
      servesRepo(member, item.repo) && (!subagent || member.assignee.kind === 'session'),
  );
  const idle = serving.filter(
    (member) =>
      member.free &&
      !held.has(member.key) &&
      (item.role === undefined ||
        member.role === undefined ||
        member.role === item.role ||
        member.role === 'chat'),
  );
  const ordered = [...idle].sort(
    (a, b) => tierOf(a, item) - tierOf(b, item) || a.key.localeCompare(b.key),
  );
  let blocked: WorkItemBlocker | undefined;
  for (const member of ordered) {
    const blocker = conflictWith(item, member.cwd, ctx);
    if (blocker === undefined) return { kind: 'use', member };
    blocked ??= blocker;
  }
  if (blocked !== undefined) return waitWith(blocked);
  if (ctx.engineWorker === 'claude' && ctx.claudeRunsOpen < ctx.maxClaudeRuns)
    return decideClaude(item, ctx);
  if (ctx.engineWorker === 'agy' && ctx.agyRunsOpen < ctx.maxAgyRuns)
    return decideAgy(item, ctx);
  const busy = serving.filter((member) => !member.free || held.has(member.key)).length;
  return openOrRefuse(item, ctx, busy);
}

/** Starts an agy run when its cap has room and no area conflicts. */
function decideAgy(item: SchedulerItem, ctx: SchedulerContext): SchedulerDecision {
  if (ctx.agyRunsOpen >= ctx.maxAgyRuns) {
    return waitWith({ kind: 'capacity', running: ctx.agyRunsOpen, limit: ctx.maxAgyRuns });
  }
  const blocker = conflictWith(item, item.inPlace ? item.repo : undefined, ctx);
  if (blocker !== undefined) return waitWith(blocker);
  return { kind: 'agy', cwd: item.repo, readOnly: item.readOnly };
}

/**
 * Opens a new session when the squad's caps and free memory allow it. Otherwise it says why
 * nothing can take the item; busy agents in the repo are named too, but never block by themselves.
 */
function openOrRefuse(item: SchedulerItem, ctx: SchedulerContext, busy: number): SchedulerDecision {
  const reasons: string[] = [];
  if (ctx.squadSessionsOpen >= ctx.maxSquadSessions) {
    reasons.push(`đội đã mở ${ctx.squadSessionsOpen}/${ctx.maxSquadSessions} phiên`);
  }
  if (ctx.freeBytes < ctx.minFreeBytes) {
    reasons.push(
      `RAM trống ${(ctx.freeBytes / GIB).toFixed(1)} GB, cần ${(ctx.minFreeBytes / GIB).toFixed(1)} GB`,
    );
  }
  if (reasons.length === 0) return decideOpen(item, ctx);
  if (busy > 0) reasons.unshift(`${busy} phiên trong repo đang bận`);
  return {
    kind: 'wait',
    blocker: { kind: 'no_member' },
    reason: `Chưa có agent trong repo ${checkoutName(item.repo)}, không mở thêm phiên được: ${reasons.join('; ')}.`,
  };
}

/**
 * Whether a member serves a repo: it works inside the repo, or the squad opened it for the repo.
 * A squad worktree may sit outside the repo folder, so the second test is what keeps it in reach.
 */
function servesRepo(member: SchedulerMember, repo: string): boolean {
  if (isInsideRepo(member.cwd, repo)) return true;
  return member.squadRepo !== undefined && checkoutKey(member.squadRepo) === checkoutKey(repo);
}

/** Lower tier is preferred: a role note naming the role, then the squad's own session, then the rest. */
function tierOf(member: SchedulerMember, item: SchedulerItem): number {
  if (item.role !== undefined && member.note?.toLowerCase().includes(item.role)) return 0;
  const ownSession =
    member.squadRepo !== undefined && checkoutKey(member.squadRepo) === checkoutKey(item.repo);
  if (ownSession && (item.role === undefined || member.role === item.role)) return 1;
  return 2;
}

/**
 * Why an editing item may not run in this checkout now, or undefined. A running editing item holds
 * the checkout or an overlapping area; a busy member outside the work items locks its checkout.
 * Read-only items are never blocked.
 */
function conflictWith(
  item: SchedulerItem,
  checkout: string | undefined,
  ctx: SchedulerContext,
): WorkItemBlocker | undefined {
  if (item.readOnly) return undefined;
  for (const hold of ctx.holds) {
    if (hold.readOnly) continue;
    if (
      checkout !== undefined &&
      hold.checkout !== undefined &&
      checkoutKey(checkout) === checkoutKey(hold.checkout)
    ) {
      return { kind: 'area', sequence: hold.sequence, area: checkoutName(checkout) };
    }
    // Areas are paths inside a repo: the same path in another repo is another file.
    const sameRepo = checkoutKey(hold.repo) === checkoutKey(item.repo);
    const area = sameRepo
      ? item.areas.find((mine) => hold.areas.some((theirs) => areasOverlap(mine, theirs)))
      : undefined;
    if (area !== undefined) return { kind: 'area', sequence: hold.sequence, area };
  }
  if (checkout !== undefined && isLockedByBusyMember(checkout, ctx)) {
    return { kind: 'busy_checkout', area: checkoutName(checkout) };
  }
  return undefined;
}

/**
 * Whether a member busy in this checkout runs no work item the board holds. A member with a hold is
 * judged by that hold alone, so a read-only item leaves its checkout open.
 */
function isLockedByBusyMember(checkout: string, ctx: SchedulerContext): boolean {
  const key = checkoutKey(checkout);
  return ctx.members.some(
    (member) =>
      member.busy &&
      member.cwd !== undefined &&
      checkoutKey(member.cwd) === key &&
      !ctx.holds.some((hold) => hold.memberKey === member.key),
  );
}

function waitWith(blocker: WorkItemBlocker): SchedulerDecision {
  return { kind: 'wait', blocker, reason: blockerReason(blocker) };
}

function capacityWait(ctx: SchedulerContext): SchedulerDecision {
  return waitWith({ kind: 'capacity', running: ctx.holds.length, limit: ctx.maxParallel });
}
