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
 * - An explicit assignee (herdr pane, omp session) runs only when it is free and not held. A new
 *   session for an explicit item opens in the item's repo.
 * - An auto item picks a free member inside its repo, preferring a role note that names its role,
 *   then a session the squad opened in that repo with its role, then any other compatible member.
 *   With none free, it opens a new session when the squad session cap and the free-RAM threshold
 *   allow. Otherwise it waits with the reason.
 */

import type {
  CompanyRole,
  WorkItemAssignee,
  WorkItemAssigneeKind,
  WorkItemBlocker,
} from '../../../../core/src/messages.js';
import { blockerReason } from '../../../../core/src/workItemGraph.js';
import { GIB } from './squadSettings.js';

/** One queued or running item, as the scheduler reads it. */
export interface SchedulerItem {
  readonly sequence: number;
  readonly kind: WorkItemAssigneeKind;
  /** Member key of a herdr or session assignee; undefined for auto and new-session items. */
  readonly memberKey: string | undefined;
  /** Canonical repo or checkout the item works in; the folder root when the item names none. */
  readonly repo: string;
  readonly role: CompanyRole | undefined;
  readonly areas: readonly string[];
  readonly readOnly: boolean;
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
  /** Whether the squad opened this session. */
  readonly squadOpened: boolean;
}

/** An item that holds a member right now. */
export interface SchedulerHold {
  readonly memberKey: string;
  readonly sequence: number;
  readonly readOnly: boolean;
  readonly areas: readonly string[];
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
}

/** What the service should do with a ready item. */
export type SchedulerDecision =
  | { readonly kind: 'use'; readonly member: SchedulerMember }
  | { readonly kind: 'open'; readonly cwd: string; readonly role: CompanyRole }
  | { readonly kind: 'wait'; readonly blocker: WorkItemBlocker; readonly reason: string };

/** A running item that blocks this one, and the area this one needs that it holds. */
interface Conflict {
  readonly hold: SchedulerHold;
  readonly area: string;
}

/** Lowercase path key: forward slashes, no trailing slash. Windows paths compare case-insensitively. */
export function checkoutKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
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
  return decideAuto(item, ctx);
}

function decideNamed(item: SchedulerItem, ctx: SchedulerContext): SchedulerDecision {
  const member = ctx.members.find((entry) => entry.key === item.memberKey);
  const held = ctx.holds.some((hold) => hold.memberKey === item.memberKey);
  if (member === undefined || !member.free || held) {
    return waitWith({ kind: 'agent' });
  }
  if (ctx.holds.length >= ctx.maxParallel) return capacityWait(ctx);
  const conflict = conflictWith(item, member.cwd, ctx.holds);
  if (conflict !== undefined) return areaWait(conflict);
  return { kind: 'use', member };
}

function decideOpen(item: SchedulerItem, ctx: SchedulerContext): SchedulerDecision {
  const conflict = conflictWith(item, item.repo, ctx.holds);
  if (conflict !== undefined) return areaWait(conflict);
  return { kind: 'open', cwd: item.repo, role: item.role ?? 'chat' };
}

function decideAuto(item: SchedulerItem, ctx: SchedulerContext): SchedulerDecision {
  const held = new Set(ctx.holds.map((hold) => hold.memberKey));
  const inRepo = ctx.members.filter((member) => isInsideRepo(member.cwd, item.repo));
  const idle = inRepo.filter(
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
  let blocked: Conflict | undefined;
  for (const member of ordered) {
    const conflict = conflictWith(item, member.cwd, ctx.holds);
    if (conflict === undefined) return { kind: 'use', member };
    blocked ??= conflict;
  }
  if (blocked !== undefined) return areaWait(blocked);
  const busy = inRepo.filter((member) => !member.free || held.has(member.key)).length;
  return openOrRefuse(item, ctx, busy);
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

/** Lower tier is preferred: a role note naming the role, then the squad's own session, then the rest. */
function tierOf(member: SchedulerMember, item: SchedulerItem): number {
  if (item.role !== undefined && member.note?.toLowerCase().includes(item.role)) return 0;
  const sameRepo = member.cwd !== undefined && checkoutKey(member.cwd) === checkoutKey(item.repo);
  if (member.squadOpened && sameRepo && (item.role === undefined || member.role === item.role)) {
    return 1;
  }
  return 2;
}

/** The first running editing item that holds this checkout or an overlapping area, or undefined. */
function conflictWith(
  item: SchedulerItem,
  checkout: string | undefined,
  holds: readonly SchedulerHold[],
): Conflict | undefined {
  if (item.readOnly) return undefined;
  for (const hold of holds) {
    if (hold.readOnly) continue;
    if (
      checkout !== undefined &&
      hold.checkout !== undefined &&
      checkoutKey(checkout) === checkoutKey(hold.checkout)
    ) {
      return { hold, area: checkoutName(checkout) };
    }
    const area = item.areas.find((mine) =>
      hold.areas.some((theirs) => areasOverlap(mine, theirs)),
    );
    if (area !== undefined) return { hold, area };
  }
  return undefined;
}

function waitWith(blocker: WorkItemBlocker): SchedulerDecision {
  return { kind: 'wait', blocker, reason: blockerReason(blocker) };
}

function capacityWait(ctx: SchedulerContext): SchedulerDecision {
  return waitWith({ kind: 'capacity', running: ctx.holds.length, limit: ctx.maxParallel });
}

function areaWait(conflict: Conflict): SchedulerDecision {
  return waitWith({ kind: 'area', sequence: conflict.hold.sequence, area: conflict.area });
}
