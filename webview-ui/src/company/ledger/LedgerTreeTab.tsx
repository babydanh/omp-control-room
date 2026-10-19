/**
 * LedgerTreeTab: one git tree per repo, drawn as a column of cards. The trunk (origin/main)
 * is the first card; each branch is a card whose fork leaves the trunk line. Conflicts are
 * red dashed runs through the right gutter. The model (ledgerTreeModel.ts) decides what each
 * card says; the geometry comes from ledgerTreeLayout.ts; this file draws them and reports
 * which element was picked.
 */

import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { LedgerView } from '../../../../core/src/messages.js';
import { Icon } from '../components/Icon.js';
import { formatRelativeTime } from './ledgerFormat.js';
import { type NodeTone, TONE_LABEL } from './ledgerHealth.js';
import { LedgerLegend } from './LedgerLegend.js';
import { type ManagerAction, type ManagerChip, type PaneInput } from './ledgerManagers.js';
import type { BoardSessionIndex } from './ledgerMapping.js';
import {
  type ConflictRef,
  type LedgerSelection,
  normalizeCheckoutPath,
} from './ledgerSelection.js';
import {
  connectorGutter,
  layoutTree,
  planConflicts,
  sameBoxes,
  slotCountOf,
  type TreeBox,
  type TreeShape,
  TRUNK_GUTTER,
} from './ledgerTreeLayout.js';
import { buildRepoTree, type RepoTree, type TreeNode } from './ledgerTreeModel.js';
import {
  DOT_CLASS,
  TONE_BADGE,
  TONE_BAR,
  TONE_FILL,
  TONE_ICON,
  TONE_STROKE,
  TONE_TEXT,
} from './ledgerTreeStyle.js';

/** Shown on a card with nothing to act on. */
const ALL_CLEAR = 'Không có việc cần làm';

export interface LedgerTreeTabProps {
  view: LedgerView;
  selection: LedgerSelection | null;
  onSelect: (selection: LedgerSelection) => void;
  boardSessions: BoardSessionIndex;
  panes: readonly PaneInput[];
  onOpenBoardSession: (boardKey: string) => void;
  onOpenHerdr: (paneId: string) => void;
  onOpenSleeping: (paneId: string) => void;
  /** Phone layout: drops the conflict labels, which would not fit beside the cards. */
  phone: boolean;
}

function isBranchSelected(
  selection: LedgerSelection | null,
  repo: string,
  node: TreeNode,
): boolean {
  if (selection?.kind !== 'branch' || node.worktree === null) return false;
  return (
    selection.repo === repo &&
    normalizeCheckoutPath(selection.path) === normalizeCheckoutPath(node.worktree.path)
  );
}

function isConflictSelected(
  selection: LedgerSelection | null,
  repo: string,
  ref: ConflictRef,
): boolean {
  if (selection?.kind !== 'conflict' || selection.repo !== repo) return false;
  if (ref.kind === 'pair') {
    return selection.ref.kind === 'pair' && selection.ref.a === ref.a && selection.ref.b === ref.b;
  }
  return selection.ref.kind === 'main' && selection.ref.lane === ref.lane;
}

export function LedgerTreeTab(props: LedgerTreeTabProps) {
  const { view, boardSessions, panes, selection, onSelect } = props;
  const [expandedRepos, setExpandedRepos] = useState<ReadonlySet<string>>(() => new Set());

  const trees = useMemo(
    () =>
      view.repos.map((repo) =>
        buildRepoTree(
          repo,
          view.overlaps.find((scan) => scan.repo === repo.repo) ?? null,
          {
            sessions: view.sessions,
            pending: view.pending,
            panes,
            boardSessions,
            generatedAt: view.generatedAt,
          },
          expandedRepos.has(repo.repo),
        ),
      ),
    [view, panes, boardSessions, expandedRepos],
  );

  if (view.repos.length === 0) {
    return <p className="text-sm text-text-muted">Chưa có repo nào được quét.</p>;
  }

  const toggleFolded = (repo: string) => {
    setExpandedRepos((current) => {
      const next = new Set(current);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      return next;
    });
  };

  const openManager = (action: ManagerAction) => {
    switch (action.kind) {
      case 'board':
        props.onOpenBoardSession(action.boardKey);
        return;
      case 'session':
        onSelect({ kind: 'session', sessionId: action.sessionId });
        return;
      case 'herdr':
        props.onOpenHerdr(action.paneId);
        return;
      case 'sleeping':
        props.onOpenSleeping(action.paneId);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <LedgerLegend />
      {trees.map((tree) => (
        <RepoTreeSection
          key={tree.repo}
          tree={tree}
          generatedAt={view.generatedAt}
          selection={selection}
          phone={props.phone}
          expanded={expandedRepos.has(tree.repo)}
          onToggleFolded={() => toggleFolded(tree.repo)}
          onSelect={onSelect}
          onOpenManager={openManager}
        />
      ))}
    </div>
  );
}

interface RepoTreeSectionProps {
  tree: RepoTree;
  generatedAt: string;
  selection: LedgerSelection | null;
  phone: boolean;
  expanded: boolean;
  onToggleFolded: () => void;
  onSelect: (selection: LedgerSelection) => void;
  onOpenManager: (action: ManagerAction) => void;
}

function RepoTreeSection({
  tree,
  generatedAt,
  selection,
  phone,
  expanded,
  onToggleFolded,
  onSelect,
  onOpenManager,
}: RepoTreeSectionProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const boxes = useTreeBoxes(containerRef);
  const planned = useMemo(
    () =>
      planConflicts(
        tree.nodes.map((node) => node.id),
        tree.conflicts,
      ),
    [tree],
  );
  const withLabels = !phone;
  const gutter = connectorGutter(slotCountOf(planned), withLabels);
  const trunkId = tree.nodes[0]?.id ?? null;
  const shape = useMemo(() => layoutTree(boxes, planned, trunkId), [boxes, planned, trunkId]);
  const toneById = new Map(tree.nodes.map((node) => [node.id, node.health.tone] as const));

  return (
    <section
      aria-label={`Cây của ${tree.name}`}
      className="rounded-(--company-radius-md) bg-panel p-3"
    >
      <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-sm text-text">{tree.name}</h3>
        <p className="text-2xs text-text-muted">{tree.summary}</p>
      </header>
      <div
        ref={containerRef}
        className="relative flex flex-col gap-3"
        style={{ paddingLeft: TRUNK_GUTTER, paddingRight: gutter }}
      >
        <TreeLines shape={shape} toneById={toneById} />
        {tree.nodes.map((node) => (
          <TreeCard
            key={node.id}
            node={node}
            repo={tree.repo}
            generatedAt={generatedAt}
            selected={isBranchSelected(selection, tree.repo, node)}
            onSelect={onSelect}
            onOpenManager={onOpenManager}
          />
        ))}
        {withLabels &&
          shape.runs.map((run) => {
            const selected = isConflictSelected(selection, tree.repo, run.edge.ref);
            return (
              <button
                key={run.edge.id}
                type="button"
                aria-pressed={selected}
                onClick={() => onSelect({ kind: 'conflict', repo: tree.repo, ref: run.edge.ref })}
                className={`absolute -translate-y-1/2 rounded-(--company-radius-sm) px-1.5 py-0.5 text-2xs whitespace-nowrap text-danger hover:bg-danger/25 ${selected ? 'bg-danger/25' : 'bg-danger/15'}`}
                style={{ left: run.labelAt.x, top: run.labelAt.y }}
              >
                {`${run.edge.files} tệp xung đột`}
              </button>
            );
          })}
      </div>
      {tree.foldedCount > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggleFolded}
          className="company-toggle touch-target mt-3 text-2xs"
        >
          {expanded
            ? `Ẩn ${tree.foldedCount} nhánh đã gộp`
            : `Hiện ${tree.foldedCount} nhánh đã gộp`}
        </button>
      )}
    </section>
  );
}

/** The trunk line, the forks that leave it, and the conflict runs, drawn behind the cards. */
function TreeLines({
  shape,
  toneById,
}: {
  shape: TreeShape;
  toneById: ReadonlyMap<string, NodeTone>;
}) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="pointer-events-none absolute inset-0 size-full overflow-visible"
    >
      {shape.trunkPath !== null && (
        <path d={shape.trunkPath} fill="none" stroke="var(--color-text-muted)" strokeWidth={2} />
      )}
      {shape.forks.map((fork) => {
        const tone = toneById.get(fork.id) ?? 'ok';
        return (
          <g key={fork.id}>
            <path d={fork.path} fill="none" strokeWidth={1.5} className={TONE_STROKE[tone]} />
            <circle cx={fork.dot.x} cy={fork.dot.y} r={3.5} className={TONE_FILL[tone]} />
          </g>
        );
      })}
      {shape.trunkDot !== null && (
        <circle
          cx={shape.trunkDot.x}
          cy={shape.trunkDot.y}
          r={5}
          fill="var(--color-raised)"
          stroke="var(--color-text-muted)"
          strokeWidth={2}
        />
      )}
      {shape.runs.map((run) => (
        <path
          key={run.edge.id}
          d={run.path}
          fill="none"
          strokeWidth={1.5}
          strokeDasharray="5 4"
          className="stroke-danger"
        />
      ))}
    </svg>
  );
}

interface TreeCardProps {
  node: TreeNode;
  repo: string;
  generatedAt: string;
  selected: boolean;
  onSelect: (selection: LedgerSelection) => void;
  onOpenManager: (action: ManagerAction) => void;
}

function TreeCard({ node, repo, generatedAt, selected, onSelect, onOpenManager }: TreeCardProps) {
  const { worktree, health, managers } = node;
  const title = worktree === null ? 'origin/main' : (worktree.branch ?? `HEAD ${worktree.head}`);
  const subtitle =
    worktree === null
      ? 'Máy này chưa có checkout chính của repo'
      : [
          node.trunk ? 'Checkout chính' : worktree.name,
          worktree.lastCommitSubject === '' ? 'chưa có commit' : worktree.lastCommitSubject,
          formatRelativeTime(worktree.lastCommitAt, generatedAt),
        ].join(' · ');

  return (
    <article
      data-tree-node={node.id}
      className={`relative rounded-(--company-radius-md) p-3 ${selected ? 'bg-selected' : 'bg-raised'}`}
      style={{ boxShadow: `inset 3px 0 0 ${TONE_BAR[health.tone]}` }}
    >
      {worktree !== null && (
        <button
          type="button"
          aria-pressed={selected}
          aria-label={`Chi tiết nhánh ${title}`}
          onClick={() => onSelect({ kind: 'branch', repo, path: worktree.path })}
          className="absolute inset-0 rounded-(--company-radius-md) hover:bg-hover/40"
        />
      )}
      <div className="pointer-events-none relative flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Icon name="git-branch" className="text-text-muted" />
          <h4 className="min-w-0 flex-1 truncate text-sm text-text" title={title}>
            {title}
          </h4>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs ${TONE_BADGE[health.tone]}`}
          >
            <Icon name={TONE_ICON[health.tone]} />
            {TONE_LABEL[health.tone]}
          </span>
        </div>
        <p className="truncate text-2xs text-text-muted">{subtitle}</p>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2">
          {worktree === null ? (
            <p className="text-xs text-text-muted">Không có việc để làm trên máy này.</p>
          ) : health.reasons.length === 0 ? (
            <p className={`flex items-center gap-1.5 text-xs ${TONE_TEXT.ok}`}>
              <Icon name="check" />
              {ALL_CLEAR}
            </p>
          ) : (
            <ul className="flex min-w-0 flex-col gap-1">
              {health.reasons.map((item) => (
                <li
                  key={item.text}
                  className={`flex items-start gap-1.5 text-xs ${TONE_TEXT[item.tone]}`}
                >
                  <span className="mt-0.5 shrink-0">
                    <Icon name={item.icon} />
                  </span>
                  <span className="min-w-0">{item.text}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-2xs text-text-muted">Ai đang quản lý</span>
            {managers.length === 0 ? (
              <span className="text-2xs text-text-muted">Không có phiên nào đang quản lý</span>
            ) : (
              managers.map((chip) => (
                <ManagerChipButton key={chip.key} chip={chip} onOpen={onOpenManager} />
              ))
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

function ManagerChipButton({
  chip,
  onOpen,
}: {
  chip: ManagerChip;
  onOpen: (action: ManagerAction) => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${chip.label}: ${chip.state}`}
      onClick={() => onOpen(chip.action)}
      className="pointer-events-auto touch-target flex flex-col items-start gap-0.5 rounded-(--company-radius-sm) bg-panel px-2 py-1.5 text-left hover:bg-hover"
    >
      <span className="flex max-w-full items-center gap-1.5 text-xs text-text">
        <span
          aria-hidden="true"
          className={`size-2 shrink-0 rounded-full ${DOT_CLASS[chip.dot]}`}
        />
        <span className="truncate">{chip.label}</span>
      </span>
      <span className="text-2xs text-text-muted">
        {chip.age === null ? chip.state : `${chip.state} · ${chip.age}`}
      </span>
      {chip.detail !== null && (
        <span className="max-w-full truncate text-2xs text-text-muted">{chip.detail}</span>
      )}
      {chip.flag !== null && <span className="text-2xs text-caution">{chip.flag}</span>}
    </button>
  );
}

/**
 * The cards' boxes in the container's own coordinates. Re-measured after every render (a
 * no-op when nothing moved) and whenever the container resizes.
 */
function useTreeBoxes(containerRef: RefObject<HTMLDivElement | null>): readonly TreeBox[] {
  const [boxes, setBoxes] = useState<readonly TreeBox[]>([]);
  const measure = useCallback(() => {
    const container = containerRef.current;
    if (container === null) return;
    const origin = container.getBoundingClientRect();
    const next = Array.from(
      container.querySelectorAll<HTMLElement>('[data-tree-node]'),
      (card): TreeBox => {
        const rect = card.getBoundingClientRect();
        return {
          id: card.dataset.treeNode ?? '',
          top: rect.top - origin.top,
          height: rect.height,
          left: rect.left - origin.left,
          width: rect.width,
        };
      },
    );
    setBoxes((previous) => (sameBoxes(previous, next) ? previous : next));
  }, [containerRef]);

  useLayoutEffect(() => {
    measure();
  });

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;
    const observer = new ResizeObserver(() => measure());
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, measure]);

  return boxes;
}
