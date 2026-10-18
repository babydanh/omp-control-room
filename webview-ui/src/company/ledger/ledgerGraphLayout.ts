/**
 * Geometry for one repo's branch graph. Pure: the view turns these numbers into an SVG
 * canvas and HTML labels. Row 0 is the main line (origin/main). Each further row is one
 * non-main worktree, in the order the server sent them.
 *
 * The canvas width depends on the dot spacing, and a phone may be too narrow for the
 * default spacing. `availableWidth` shrinks the spacing (never below DOT_GAP_MIN) so
 * the graph fits without a sideways scroll.
 */

import type {
  LedgerOverlapScan,
  LedgerRepo,
  LedgerSession,
  LedgerWorktree,
} from '../../../../core/src/messages.js';
import { type ConflictRef, normalizeCheckoutPath } from './ledgerSelection.js';

/** Height of one row, in px. Labels in the view are laid out on the same rhythm. */
export const GRAPH_ROW_HEIGHT = 56;

/** Ahead commits drawn as dots; any beyond this are a "+N" label. */
export const GRAPH_MAX_DOTS = 12;

const MAIN_LEFT = 12;
const FORK_X = 36;
const CURVE_WIDTH = 24;
const ROW_STUB = 24;
const DOT_GAP_MAX = 14;
const DOT_GAP_MIN = 6;
const MORE_WIDTH = 24;
const AVATAR_GAP = 16;
const AVATAR_STEP = 26;
const SLOT_OFFSET = 14;
const SLOT_STEP = 12;
const CONNECTOR_LABEL_WIDTH = 64;
const RIGHT_PAD = 12;

export interface GraphPoint {
  x: number;
  y: number;
}

export interface GraphAvatar {
  sessionId: string;
  at: GraphPoint;
}

export interface GraphRow {
  /** The checkout on this row. Null on the main line when the repo has no main checkout. */
  worktree: LedgerWorktree | null;
  y: number;
  /** SVG path from the main line to the row's end; null on the main line itself. */
  branchPath: string | null;
  endX: number;
  dots: GraphPoint[];
  aheadMore: number;
  moreAt: GraphPoint | null;
  /** Where the "N commit mới trên main" label sits; null on the main line. */
  behindAt: GraphPoint | null;
  avatars: GraphAvatar[];
  /** A merged branch is drawn faded. */
  dimmed: boolean;
}

export interface GraphConnector {
  ref: ConflictRef;
  /** Row indexes the connector joins; `upper` is the smaller index. */
  upper: number;
  lower: number;
  slot: number;
  /** SVG path: a stub from each row to a vertical run, which sits in its own slot. */
  path: string;
  labelAt: GraphPoint;
  conflictCount: number;
}

export interface RepoGraphLayout {
  width: number;
  height: number;
  dotGap: number;
  mainLine: string | null;
  rows: GraphRow[];
  connectors: GraphConnector[];
}

export interface RepoGraphInput {
  repo: LedgerRepo;
  sessions: readonly LedgerSession[];
  overlap: LedgerOverlapScan | null;
}

interface ConnectorPlan {
  ref: ConflictRef;
  upper: number;
  lower: number;
  conflictCount: number;
  slot: number;
}

function rowY(index: number): number {
  return index * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2;
}

function avatarsFor(
  sessionIds: readonly string[],
  known: ReadonlySet<string>,
  startX: number,
  y: number,
): GraphAvatar[] {
  const present = sessionIds.filter((sessionId) => known.has(sessionId));
  return present.map((sessionId, index) => ({
    sessionId,
    at: { x: startX + index * AVATAR_STEP, y },
  }));
}

/**
 * Places every row for one dot spacing. Returns the rows and the right edge of the
 * content: the main line runs to it, and connector runs sit beyond it.
 */
function planRows(
  main: LedgerWorktree | null,
  branches: readonly LedgerWorktree[],
  known: ReadonlySet<string>,
  gap: number,
): { rows: GraphRow[]; contentRight: number } {
  const branchStart = FORK_X + CURVE_WIDTH;
  const mainY = rowY(0);

  const mainAvatars = avatarsFor(main?.sessionIds ?? [], known, branchStart + AVATAR_GAP, mainY);
  const mainAvatarEnd =
    mainAvatars.length > 0 ? mainAvatars[mainAvatars.length - 1].at.x + AVATAR_STEP / 2 : 0;

  const branchRows = branches.map((worktree, offset): GraphRow => {
    const y = rowY(offset + 1);
    const dotCount = Math.min(worktree.ahead, GRAPH_MAX_DOTS);
    const dotsEnd = branchStart + dotCount * gap;
    const dots = Array.from({ length: dotCount }, (_, index) => ({
      x: branchStart + (index + 1) * gap,
      y,
    }));
    const aheadMore = worktree.ahead - dotCount;
    const moreAt: GraphPoint | null = aheadMore > 0 ? { x: dotsEnd + gap, y } : null;
    const afterDots = moreAt === null ? dotsEnd : moreAt.x + MORE_WIDTH;
    const avatars = avatarsFor(worktree.sessionIds, known, afterDots + AVATAR_GAP, y);
    const lastAvatar = avatars.length > 0 ? avatars[avatars.length - 1] : null;
    const endX = lastAvatar === null ? afterDots + ROW_STUB : lastAvatar.at.x + AVATAR_STEP / 2;
    const midX = FORK_X + CURVE_WIDTH / 2;
    return {
      worktree,
      y,
      branchPath: `M ${FORK_X} ${mainY} C ${midX} ${mainY} ${midX} ${y} ${FORK_X + CURVE_WIDTH} ${y} L ${endX} ${y}`,
      endX,
      dots,
      aheadMore,
      moreAt,
      behindAt: { x: branchStart + 4, y: y - 10 },
      avatars,
      dimmed: worktree.merged,
    };
  });

  const contentRight = Math.max(
    branchStart + ROW_STUB,
    mainAvatarEnd,
    ...branchRows.map((row) => row.endX),
  );

  const mainRow: GraphRow = {
    worktree: main,
    y: mainY,
    branchPath: null,
    endX: contentRight,
    dots: [],
    aheadMore: 0,
    moreAt: null,
    behindAt: null,
    avatars: mainAvatars,
    dimmed: false,
  };
  return { rows: [mainRow, ...branchRows], contentRight };
}

/**
 * Chooses which overlap entries become connectors and the slot each one uses. A
 * connector takes the lowest slot where no earlier connector overlaps its row range,
 * so two vertical runs never share an x. Entries with no conflict files, or whose
 * checkouts are not on the graph, are left out.
 */
function planConnectors(
  overlap: LedgerOverlapScan | null,
  rowPaths: readonly (string | null)[],
): ConnectorPlan[] {
  if (overlap === null) return [];

  const rowIndex = new Map<string, number>();
  rowPaths.forEach((path, index) => {
    if (path !== null && !rowIndex.has(normalizeCheckoutPath(path))) {
      rowIndex.set(normalizeCheckoutPath(path), index);
    }
  });

  const candidates: Omit<ConnectorPlan, 'slot'>[] = [];
  for (const pair of overlap.pairs) {
    const first = rowIndex.get(normalizeCheckoutPath(pair.a));
    const second = rowIndex.get(normalizeCheckoutPath(pair.b));
    if (
      pair.conflicts.length === 0 ||
      first === undefined ||
      second === undefined ||
      first === second
    ) {
      continue;
    }
    candidates.push({
      ref: { kind: 'pair', a: pair.a, b: pair.b },
      upper: Math.min(first, second),
      lower: Math.max(first, second),
      conflictCount: pair.conflicts.length,
    });
  }
  for (const main of overlap.main) {
    const lane = rowIndex.get(normalizeCheckoutPath(main.lane));
    if (main.conflicts.length === 0 || lane === undefined || lane === 0) continue;
    candidates.push({
      ref: { kind: 'main', lane: main.lane },
      upper: 0,
      lower: lane,
      conflictCount: main.conflicts.length,
    });
  }

  candidates.sort((left, right) => left.upper - right.upper || left.lower - right.lower);
  const placed: ConnectorPlan[] = [];
  for (const candidate of candidates) {
    let slot = 0;
    while (
      placed.some(
        (other) =>
          other.slot === slot && other.upper <= candidate.lower && candidate.upper <= other.lower,
      )
    ) {
      slot += 1;
    }
    placed.push({ ...candidate, slot });
  }
  return placed;
}

/** The largest dot spacing whose canvas fits `availableWidth`, down to DOT_GAP_MIN. */
function fitDotGap(availableWidth: number, widthAt: (gap: number) => number): number {
  for (let gap = DOT_GAP_MAX; gap > DOT_GAP_MIN; gap -= 1) {
    if (widthAt(gap) <= availableWidth) return gap;
  }
  return DOT_GAP_MIN;
}

export function layoutRepoGraph(
  input: RepoGraphInput,
  availableWidth: number | null,
): RepoGraphLayout {
  const main = input.repo.worktrees.find((worktree) => worktree.isMain) ?? null;
  const branches = input.repo.worktrees.filter((worktree) => !worktree.isMain);
  if (main === null && branches.length === 0) {
    return { width: 0, height: 0, dotGap: DOT_GAP_MAX, mainLine: null, rows: [], connectors: [] };
  }

  const known = new Set(input.sessions.map((session) => session.sessionId));
  const plans = planConnectors(input.overlap, [
    main?.path ?? null,
    ...branches.map((worktree) => worktree.path),
  ]);
  const slotCount = plans.reduce((count, plan) => Math.max(count, plan.slot + 1), 0);

  const widthAt = (gap: number): number => {
    const { contentRight } = planRows(main, branches, known, gap);
    if (plans.length === 0) return contentRight + RIGHT_PAD;
    return contentRight + SLOT_OFFSET + slotCount * SLOT_STEP + CONNECTOR_LABEL_WIDTH;
  };
  const dotGap = availableWidth === null ? DOT_GAP_MAX : fitDotGap(availableWidth, widthAt);

  const { rows, contentRight } = planRows(main, branches, known, dotGap);
  const connectors: GraphConnector[] = plans.map((plan) => {
    const upper = rows[plan.upper];
    const lower = rows[plan.lower];
    const runX = contentRight + SLOT_OFFSET + plan.slot * SLOT_STEP;
    return {
      ref: plan.ref,
      upper: plan.upper,
      lower: plan.lower,
      slot: plan.slot,
      path: `M ${upper.endX} ${upper.y} H ${runX} V ${lower.y} H ${lower.endX}`,
      labelAt: { x: runX + 6, y: (upper.y + lower.y) / 2 },
      conflictCount: plan.conflictCount,
    };
  });

  return {
    width: widthAt(dotGap),
    height: rows.length * GRAPH_ROW_HEIGHT,
    dotGap,
    mainLine: `M ${MAIN_LEFT} ${rowY(0)} H ${contentRight}`,
    rows,
    connectors,
  };
}
