/**
 * Pure rules for work item priority, dependencies, and what a queued item waits for. The server
 * applies them when it saves or sends an item, and the board applies the same checks before it
 * asks, so both sides agree. No I/O here.
 */

import type { WorkItemBlocker, WorkItemStatus } from './messages.js';

/** Priority of an item that names none: P2. */
export const WORK_ITEM_PRIORITY_DEFAULT = 2;
/** Most urgent priority (P0). */
export const WORK_ITEM_PRIORITY_MIN = 0;
/** Least urgent priority (P3). */
export const WORK_ITEM_PRIORITY_MAX = 3;
/** Most items one item may wait for. */
export const WORK_ITEM_DEPENDS_MAX = 10;
/** Longest acceptance text, in characters. */
export const WORK_ITEM_ACCEPTANCE_MAX_CHARS = 1000;

/** Why a dependency list is refused. */
export type DependsOnRefusal = 'too_many' | 'duplicate' | 'self' | 'unknown' | 'cycle';

/** What the queue needs to know about an item it may wait for. */
export interface DependencyState {
  readonly status: WorkItemStatus;
  readonly sequence: number;
}

/** Whether a value is a priority the contract allows (0–3). */
export function isWorkItemPriority(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= WORK_ITEM_PRIORITY_MIN &&
    value <= WORK_ITEM_PRIORITY_MAX
  );
}

/** The label the board shows for a priority, such as "P0". */
export function priorityLabel(priority: number): string {
  return `P${priority}`;
}

/**
 * Whether following `edgesOf` from `nodes` ever returns to a node on the current path. Iterative,
 * so a long chain cannot overflow the stack, and each node is visited once.
 */
export function graphHasCycle<K>(nodes: readonly K[], edgesOf: (node: K) => readonly K[]): boolean {
  const state = new Map<K, 'open' | 'done'>();
  for (const start of nodes) {
    if (state.has(start)) continue;
    const stack: { node: K; next: number; edges: readonly K[] }[] = [
      { node: start, next: 0, edges: edgesOf(start) },
    ];
    state.set(start, 'open');
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) break;
      if (top.next >= top.edges.length) {
        state.set(top.node, 'done');
        stack.pop();
        continue;
      }
      const target = top.edges[top.next];
      top.next += 1;
      if (target === undefined) continue;
      const seen = state.get(target);
      if (seen === 'open') return true;
      if (seen === 'done') continue;
      state.set(target, 'open');
      stack.push({ node: target, next: 0, edges: edgesOf(target) });
    }
  }
  return false;
}

/**
 * Whether `selfId` is reachable from its own `dependsOn` through stored dependencies, which means
 * saving `dependsOn` for it would close a loop. `dependencyOf` returns the stored dependencies of
 * an existing item, or undefined when no such item exists.
 */
export function closesLoop(
  selfId: string,
  dependsOn: readonly string[],
  dependencyOf: (id: string) => readonly string[] | undefined,
): boolean {
  const seen = new Set<string>();
  const pending = [...dependsOn];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (id === selfId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(dependencyOf(id) ?? []));
  }
  return false;
}

/**
 * Checks a dependency list for one item before it is saved. `selfId` is null for an item that does
 * not exist yet, which cannot close a loop. `dependencyOf` returns the stored dependencies of an
 * existing item, or undefined when no such item exists. Returns the first refusal, or null.
 */
export function checkDependsOn(
  selfId: string | null,
  dependsOn: readonly string[],
  dependencyOf: (id: string) => readonly string[] | undefined,
): DependsOnRefusal | null {
  if (dependsOn.length > WORK_ITEM_DEPENDS_MAX) return 'too_many';
  if (new Set(dependsOn).size !== dependsOn.length) return 'duplicate';
  if (selfId !== null && dependsOn.includes(selfId)) return 'self';
  for (const id of dependsOn) {
    if (dependencyOf(id) === undefined) return 'unknown';
  }
  if (selfId !== null && closesLoop(selfId, dependsOn, dependencyOf)) return 'cycle';
  return null;
}

/** Whether every item in `dependsOn` is done. An empty list is trivially done. */
export function dependenciesDone(
  dependsOn: readonly string[],
  stateOf: (id: string) => DependencyState,
): boolean {
  return dependsOn.every((id) => stateOf(id).status === 'done');
}

/**
 * Why a queued item is not sent yet, or null when nothing holds it. A failed dependency wins over
 * a pending one, and among several the lowest #n is named. `agentBusy` is true when another item
 * holds the same agent. The caller reports a removed dependency as `failed` with its old sequence.
 */
export function blockerOf(
  dependsOn: readonly string[],
  stateOf: (id: string) => DependencyState,
  agentBusy: boolean,
): WorkItemBlocker | null {
  let failed: DependencyState | null = null;
  let pending: DependencyState | null = null;
  for (const id of dependsOn) {
    const dependency = stateOf(id);
    if (dependency.status === 'failed') {
      if (failed === null || dependency.sequence < failed.sequence) failed = dependency;
    } else if (dependency.status !== 'done') {
      if (pending === null || dependency.sequence < pending.sequence) pending = dependency;
    }
  }
  if (failed !== null) return { kind: 'failed', sequence: failed.sequence };
  if (pending !== null) return { kind: 'dependency', sequence: pending.sequence };
  return agentBusy ? { kind: 'agent' } : null;
}

/** Vietnamese sentence the board shows for a blocker. The server owns the wording. */
export function blockerReason(blocker: WorkItemBlocker): string {
  if (blocker.kind === 'agent') return 'Chờ agent rảnh để nhận việc.';
  if (blocker.kind === 'dependency') return `Chờ việc #${blocker.sequence ?? 0} xong.`;
  if (blocker.kind === 'capacity') {
    return `Đầy chỗ (${blocker.running ?? 0}/${blocker.limit ?? 0}), chờ chỗ trống.`;
  }
  if (blocker.kind === 'area') return `Chờ việc #${blocker.sequence ?? 0} trả vùng ${blocker.area ?? ''}.`;
  if (blocker.kind === 'no_member') return 'Chưa có agent rảnh trong repo này.';
  if (blocker.kind === 'busy_checkout') {
    return `Chờ agent khác rảnh, đang làm trong ${blocker.area ?? ''}.`;
  }
  if (blocker.kind === 'pool_full') return 'Đã đủ phiên omp đang chạy, chờ chỗ trống rồi thử lại.';
  if (blocker.kind === 'repo_full') {
    return `Repo ${blocker.area ?? ''} đang chạy ${blocker.running ?? 0}/${blocker.limit ?? 0} việc, chờ có chỗ trống.`;
  }
  if (blocker.kind === 'worktree') {
    return `Chưa tạo được worktree riêng cho việc này: ${blocker.detail ?? 'lỗi không rõ'}.`;
  }
  if (blocker.kind === 'disk_full') {
    return blocker.detail ?? 'Ổ đĩa trống chưa đủ để tạo worktree, việc vẫn đang chờ.';
  }
  return `Việc #${blocker.sequence ?? 0} bị lỗi, gỡ chờ hoặc giao lại.`;
}

/** Queue order for one agent: higher priority (smaller number) first, then creation order. */
export function compareQueue(
  a: { readonly priority: number; readonly sequence: number },
  b: { readonly priority: number; readonly sequence: number },
): number {
  return a.priority - b.priority || a.sequence - b.sequence;
}

/**
 * The prompt an agent receives: the text, then a blank line and "Xong khi: …" when the item has
 * acceptance. The acceptance is never part of the item's own text.
 */
export function composePrompt(text: string, acceptance: string | undefined): string {
  if (acceptance === undefined || acceptance.trim() === '') return text;
  return `${text}\n\nXong khi: ${acceptance.trim()}`;
}
