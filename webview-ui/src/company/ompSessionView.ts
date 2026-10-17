/**
 * ompSessionView: what OMP's session listing actually says about a session,
 * and what it does not say at all.
 *
 * Every field below is OMP's. Citations are to
 * `@oh-my-pi/pi-coding-agent` v18.4.9, read from the installed package.
 *
 *  - `status` is OMP's `SessionStatus` (`src/session/session-listing.ts:16`),
 *    derived by `deriveSessionStatus()` (`:162-182`) from the LAST PERSISTED
 *    MESSAGE in the session's JSONL tail, then dispatched by
 *    `statusFromTailMessage()` (`:194-221`) on that record's `role` and
 *    `stopReason`. It is a reading of what was last written to disk. It is not
 *    a statement about a process.
 *
 *  - There is NO liveness field to project. `SessionInfo`
 *    (`src/session/session-listing.ts:17-39`) carries no pid, no heartbeat, no
 *    start time and no last-tool. So "is this agent still inside its task"
 *    cannot be answered from this API and nothing in this module guesses at it.
 *    Note especially that `pending` means "a trailing user message with no
 *    assistant reply persisted after it" (`:215-217`) -- that is a fact about
 *    the tail of a file, and rendering it as "running" would be a lie about a
 *    process that may not exist.
 *
 *  - `status` is OPTIONAL upstream (`:38` -- synthesized infos leave it unset)
 *    and `'unknown'` is itself a real value (`:13-14` -- empty or header-only
 *    session, or a final message larger than the tail window that was read).
 *    To a reader both mean the same thing: we do not know. Both collapse to
 *    `unknown`, flagged `observed: false` when OMP said nothing at all, and are
 *    never rounded to `complete`, `idle`, or anything else.
 *
 *  - Timestamps are kept verbatim and rendered ABSOLUTE by the panel. A
 *    relative label ("3m ago") invites the reader to read movement as work, and
 *    a session file's mtime moves for reasons that have nothing to do with an
 *    agent running.
 *
 * `created` and `parentSessionPath` are optional here for a concrete reason,
 * not defensively. OMP's in-process `SessionInfo` carries them (`:24-25`), but
 * the one listing surface that IS reachable across a process boundary --
 * `AcpAgent`'s `session/list`, spoken to `omp acp` over stdio -- projects them
 * away in `#toSessionInfo` (`src/modes/acp/acp-agent.ts:2044-2055`) and keeps
 * only `sessionId`, `cwd`, `title`, `updatedAt`, `_meta.messageCount` and
 * `_meta.size`. A record arriving over that surface genuinely has no `created`
 * and no `parentSessionPath`, and this module reads that as absent rather than
 * filling it in.
 *
 * On reachability, for the next reader: this package cannot be imported from
 * the Node process that hosts the webview. Its export map exposes only an
 * `import` condition pointing at `./src/*.ts` (uncompiled TypeScript source),
 * so `require()` cannot resolve it and `import()` of a path under
 * `node_modules` fails with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.
 * Separately, `listAllSessions()` globs with `Bun.Glob`
 * (`session-listing.ts:656`), a Bun-only API. Both were verified against the
 * installed v18.4.9. This module therefore takes records as input; it never
 * fetches them.
 */

/** OMP's `SessionStatus`, verbatim (`src/session/session-listing.ts:16`). */
export const OMP_SESSION_STATUSES = [
  'complete',
  'interrupted',
  'aborted',
  'error',
  'pending',
  'unknown',
] as const;

export type OmpSessionStatus = (typeof OMP_SESSION_STATUSES)[number];

/**
 * The one status this module may produce on its own. It is also a value OMP
 * itself emits (`:13-14`), so it is a real reading rather than a placeholder --
 * but nothing in this module is allowed to move a session INTO it from any
 * other status.
 */
export const OMP_SESSION_STATUS_UNOBSERVED = 'unknown' as const;

/**
 * A session as some OMP surface reported it. Optional fields are optional
 * because the reachable surfaces disagree on which fields they carry; see the
 * module comment. `path` is the session file, and is what
 * `parentSessionPath` is matched against.
 */
export interface OmpSessionRecord {
  readonly id: string;
  readonly path?: string | null;
  /** Empty string upstream means "old session, no cwd recorded" (`:21`). */
  readonly cwd: string;
  readonly title?: string | null;
  readonly parentSessionPath?: string | null;
  /** ISO-8601. OMP's own value is a `Date` (`:25-26`); the ACP wire sends a string. */
  readonly created?: string | null;
  readonly modified?: string | null;
  readonly messageCount?: number | null;
  readonly status?: OmpSessionStatus | null;
}

/**
 * One row as the panel draws it. `status` is never undefined, and no field here
 * was derived from a clock, a file's mtime, or any other session's data.
 */
export interface OmpSessionRow {
  readonly id: string;
  /** `null` when OMP reported no title. Never synthesised from the id. */
  readonly title: string | null;
  /** `null` when OMP reported an empty cwd. Never guessed from the id. */
  readonly cwd: string | null;
  readonly created: string | null;
  readonly modified: string | null;
  readonly messageCount: number | null;
  /** OMP's status, or `unknown` when OMP reported none. */
  readonly status: OmpSessionStatus;
  /** True only when `status` is OMP's own value, including its own `unknown`. */
  readonly statusObserved: boolean;
  /** Resolved by exact path equality against the listing; `null` if unresolved. */
  readonly parentId: string | null;
  /** True when OMP recorded a parent path, whether or not it resolved. */
  readonly parentReferenced: boolean;
  /** 0 for a session with no recorded parent. */
  readonly depth: number;
}

export interface OmpStatusLabel {
  readonly status: OmpSessionStatus;
  readonly label: string;
  /**
   * What OMP inferred, in OMP's own terms (`:5-14`). Carried so a panel can
   * show the reading's basis instead of a bare word.
   */
  readonly basis: string;
  /** False only when this view produced the value by collapse, not by OMP. */
  readonly observed: boolean;
}

/**
 * The drawn word for each status OMP emits. `status` stays the raw enum — it
 * is what `data-omp-status` reports and what the panel's own tests compare —
 * and only this label is translated, so a reader never sees an English wire
 * value standing in for product copy.
 */
const STATUS_LABELS: Record<OmpSessionStatus, string> = {
  complete: 'Hoàn tất',
  interrupted: 'Bị gián đoạn',
  aborted: 'Đã hủy giữa chừng',
  error: 'Lỗi',
  pending: 'Đang chờ trả lời',
  unknown: 'Không rõ',
};

const STATUS_BASIS: Readonly<Record<OmpSessionStatus, string>> = {
  complete: 'lượt trả lời cuối cùng kết thúc mà không còn lệnh công cụ nào chưa được trả lời',
  interrupted: 'công việc bị cắt giữa chừng trong lượt đã lưu gần nhất',
  aborted: 'lượt trả lời cuối cùng đã bị hủy',
  error: 'lượt trả lời cuối cùng kết thúc vì lỗi',
  pending: 'còn một tin nhắn của người dùng chưa có câu trả lời nào được lưu sau nó',
  unknown: 'phần cuối của tệp phiên không xác định được trạng thái',
};

const UNOBSERVED_BASIS = 'OMP không báo trạng thái nào cho phiên này';

/**
 * Normalize whatever a source handed us into a label. `null`/`undefined` are
 * the absence cases and collapse to `unknown` with `observed: false`; a value
 * OMP emitted -- including its own `'unknown'` -- passes through untouched.
 * Anything unrecognized also collapses, because an unrecognised status is by
 * definition not a status this view understands and must not be rendered as if
 * it were.
 */
export function describeOmpStatus(status: OmpSessionStatus | null | undefined): OmpStatusLabel {
  if (status === null || status === undefined || !OMP_SESSION_STATUSES.includes(status)) {
    return {
      status: OMP_SESSION_STATUS_UNOBSERVED,
      label: STATUS_LABELS[OMP_SESSION_STATUS_UNOBSERVED],
      basis: UNOBSERVED_BASIS,
      observed: false,
    };
  }
  return { status, label: STATUS_LABELS[status], basis: STATUS_BASIS[status], observed: true };
}

function optionalString(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Join `parentSessionPath` (a path, `session-listing.ts:24`) to the listing by
 * exact path equality. A parent outside the listing, a parent with no recorded
 * path, and a parent naming the session itself all resolve to `null` -- a
 * self-reference is malformed data, and treating it as a parent would make the
 * tree non-terminating.
 */
function resolveParent(
  record: OmpSessionRecord,
  byPath: ReadonlyMap<string, string>,
): string | null {
  const parentPath = optionalString(record.parentSessionPath);
  if (parentPath === null) return null;
  const parentId = byPath.get(parentPath);
  if (parentId === undefined || parentId === record.id) return null;
  return parentId;
}

/**
 * Project records into ordered rows. Input order is preserved -- OMP sorts
 * newest-first upstream (`session-listing.ts:63`; the sort at `:541-547`), and
 * `modified` is absent on the one cross-process surface that exists, so
 * re-sorting here would mean inventing an order from a field we may not have.
 */
export function buildOmpSessionRows(records: readonly OmpSessionRecord[]): OmpSessionRow[] {
  const byPath = new Map<string, string>();
  for (const record of records) {
    const path = optionalString(record.path);
    // First writer wins: a duplicate path is malformed, and letting the later
    // record win would silently reparent the earlier one's children.
    if (path !== null && !byPath.has(path)) byPath.set(path, record.id);
  }

  const rows = new Map<string, OmpSessionRow>();
  for (const record of records) {
    const described = describeOmpStatus(record.status);
    rows.set(record.id, {
      id: record.id,
      title: optionalString(record.title),
      cwd: optionalString(record.cwd),
      created: optionalString(record.created),
      modified: optionalString(record.modified),
      messageCount:
        typeof record.messageCount === 'number' && Number.isFinite(record.messageCount)
          ? record.messageCount
          : null,
      status: described.status,
      statusObserved: described.observed,
      parentId: resolveParent(record, byPath),
      parentReferenced: optionalString(record.parentSessionPath) !== null,
      depth: 0,
    });
  }

  // Depth, walked iteratively up the recorded parents. The chain is collected
  // deepest-first and then filled from its top, because a recursive descent
  // over recorded lineage would not terminate on a cycle: two files naming
  // each other as parent is malformed input, and it must still render.
  const depthOf = new Map<string, number>();
  for (const row of rows.values()) {
    if (depthOf.has(row.id)) continue;
    const chain: string[] = [];
    const seen = new Set<string>();
    let cursor: OmpSessionRow | undefined = row;
    while (cursor && !seen.has(cursor.id) && !depthOf.has(cursor.id)) {
      seen.add(cursor.id);
      chain.push(cursor.id);
      cursor = cursor.parentId === null ? undefined : rows.get(cursor.parentId);
    }
    // A chain that stopped at an already-measured node hangs one level below
    // it; one that stopped at a root starts at the top.
    const top = cursor ? (depthOf.get(cursor.id) ?? 0) + 1 : 0;
    for (let i = chain.length - 1; i >= 0; i--) {
      depthOf.set(chain[i]!, top + (chain.length - 1 - i));
    }
  }

  return [...rows.values()].map((row) => ({ ...row, depth: depthOf.get(row.id) ?? 0 }));
}

/** A session with its resolved children, so a fork reads as nested. */
export interface OmpSessionNode {
  readonly row: OmpSessionRow;
  readonly children: readonly OmpSessionNode[];
}

/** A node while the forest is still being wired. */
interface PendingNode {
  row: OmpSessionRow;
  children: PendingNode[];
}

/**
 * Group rows into a forest. A session whose recorded parent is not in this
 * listing becomes a root -- it is shown, with its unresolved parentage marked,
 * rather than hidden.
 *
 * Sessions caught in a recorded parent cycle are promoted to roots too. Two
 * files naming each other as parent is malformed data, and dropping both would
 * make the panel hide sessions the user can plainly see on disk.
 */
export function buildOmpSessionForest(records: readonly OmpSessionRecord[]): OmpSessionNode[] {
  const nodes = new Map<string, PendingNode>();
  for (const row of buildOmpSessionRows(records)) {
    nodes.set(row.id, { row, children: [] });
  }

  const roots: PendingNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.row.parentId === null ? undefined : nodes.get(node.row.parentId);
    if (parent !== undefined && parent !== node && !parentReaches(parent, node.row.id, nodes)) {
      parent.children.push(node);
      continue;
    }
    roots.push(node);
  }

  return roots.map(toNode);
}

/**
 * True when walking up from `from` reaches `targetId` -- that is, `targetId`
 * is an ancestor of `from`, so nesting `targetId` under `from` would close a
 * loop. Bounded by the records it has already visited, so it terminates on the
 * very cycles it exists to detect.
 */
function parentReaches(
  from: PendingNode,
  targetId: string,
  nodes: ReadonlyMap<string, PendingNode>,
): boolean {
  const seen = new Set<string>();
  let cursor: PendingNode | undefined = from;
  while (cursor && !seen.has(cursor.row.id)) {
    if (cursor.row.id === targetId) return true;
    seen.add(cursor.row.id);
    cursor = cursor.row.parentId === null ? undefined : nodes.get(cursor.row.parentId);
  }
  return false;
}

function toNode(node: PendingNode): OmpSessionNode {
  return { row: node.row, children: node.children.map(toNode) };
}

/** Depth-first flatten of a forest, for a list that draws indentation. */
export function flattenOmpSessionForest(forest: readonly OmpSessionNode[]): OmpSessionRow[] {
  const flat: OmpSessionRow[] = [];
  const walk = (nodes: readonly OmpSessionNode[]): void => {
    for (const node of nodes) {
      flat.push(node.row);
      walk(node.children);
    }
  };
  walk(forest);
  return flat;
}

/**
 * Render an observed timestamp: absolute, to the minute, UTC.
 *
 * Deliberately never relative. "3m ago" reads as movement, and a reader who
 * sees a session ticking upward concludes something is running -- a claim about
 * a process, which this API has never made. A value that does not parse is
 * returned untouched: rounding a string we could not read would be inventing a
 * time.
 */
export function formatOmpTimestamp(value: string | null): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : `${new Date(parsed).toISOString().slice(0, 16)}Z`;
}
