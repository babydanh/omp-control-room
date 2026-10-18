/**
 * LedgerGraphTab: one branch graph per repo. The main line is origin/main and each
 * branch forks from it. The geometry comes from ledgerGraphLayout.ts; this file draws
 * it and reports which element was picked.
 */

import { Fragment, type ReactElement, useRef } from 'react';

import type {
  LedgerOverlapScan,
  LedgerRepo,
  LedgerSession,
  LedgerView,
  LedgerWorktree,
} from '../../../../core/src/messages.js';
import { useElementWidth } from '../useElementWidth.js';
import {
  aheadLabel,
  behindLabel,
  dirtyLabel,
  initialsOf,
  scanLabel,
  sessionTitle,
} from './ledgerFormat.js';
import {
  GRAPH_ROW_HEIGHT,
  type GraphConnector,
  type GraphRow,
  layoutRepoGraph,
} from './ledgerGraphLayout.js';
import {
  type ConflictRef,
  type LedgerSelection,
  normalizeCheckoutPath,
} from './ledgerSelection.js';

/** Width of the label column beside each graph, in px. */
const LABEL_WIDTH = 150;
const DOT_RADIUS = 4;
const AVATAR_SIZE = 22;
const DIMMED_OPACITY = 0.55;

export interface LedgerGraphTabProps {
  view: LedgerView;
  selection: LedgerSelection | null;
  onSelect: (selection: LedgerSelection) => void;
}

function isBranchSelected(
  selection: LedgerSelection | null,
  repo: string,
  worktree: LedgerWorktree | null,
): boolean {
  if (selection?.kind !== 'branch' || worktree === null) return false;
  return (
    selection.repo === repo &&
    normalizeCheckoutPath(selection.path) === normalizeCheckoutPath(worktree.path)
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

function scanTone(scan: LedgerOverlapScan | null): string {
  if (scan === null || scan.state === 'idle') return 'text-text-muted';
  if (scan.state === 'error') return 'text-danger';
  if (scan.state === 'running') return 'text-status-active';
  return scan.complete ? 'text-status-success' : 'text-warning';
}

export function LedgerGraphTab({ view, selection, onSelect }: LedgerGraphTabProps) {
  if (view.repos.length === 0) {
    return <p className="text-sm text-text-muted">Chưa có repo nào được quét.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {view.repos.map((repo) => (
        <RepoGraph
          key={repo.repo}
          view={view}
          repo={repo}
          selection={selection}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function RepoGraph({
  view,
  repo,
  selection,
  onSelect,
}: LedgerGraphTabProps & { repo: LedgerRepo }) {
  const ref = useRef<HTMLDivElement>(null);
  const measured = useElementWidth(ref, repo.repo);
  const scan = view.overlaps.find((item) => item.repo === repo.repo) ?? null;
  const layout = layoutRepoGraph(
    { repo, sessions: view.sessions, overlap: scan },
    measured > LABEL_WIDTH ? measured - LABEL_WIDTH : null,
  );
  const sessionsById = new Map(
    view.sessions.map((session) => [session.sessionId, session] as const),
  );

  return (
    <section
      aria-label={`Cây của ${repo.name}`}
      className="rounded-(--company-radius-md) bg-panel p-2.5"
    >
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm text-text">{repo.name}</h3>
        <span className={`rounded-full bg-raised px-2 py-0.5 text-2xs ${scanTone(scan)}`}>
          {scanLabel(scan)}
        </span>
        {scan?.state === 'error' && scan.error !== null && (
          <span className="text-2xs text-danger">{scan.error}</span>
        )}
      </header>
      {layout.rows.length === 0 ? (
        <p className="text-2xs text-text-muted">Repo này chưa có worktree nào.</p>
      ) : (
        <div ref={ref} className="overflow-x-auto">
          <div
            className="relative"
            style={{ width: LABEL_WIDTH + layout.width, height: layout.height }}
          >
            <svg
              aria-hidden="true"
              className="absolute top-0"
              style={{ left: LABEL_WIDTH }}
              width={layout.width}
              height={layout.height}
            >
              {layout.mainLine !== null && (
                <path
                  d={layout.mainLine}
                  fill="none"
                  stroke="var(--color-text-muted)"
                  strokeWidth={2}
                />
              )}
              {layout.rows.map((row) => (
                <RowLines key={row.y} row={row} />
              ))}
              {layout.connectors.map((connector) => (
                <ConnectorLine
                  key={`${connector.upper}-${connector.lower}-${connector.slot}`}
                  connector={connector}
                  selected={isConflictSelected(selection, repo.repo, connector.ref)}
                />
              ))}
            </svg>
            {layout.rows.map((row) => (
              <GraphRowLabels
                key={row.y}
                repo={repo}
                row={row}
                sessionsById={sessionsById}
                selection={selection}
                onSelect={onSelect}
              />
            ))}
            {layout.connectors.map((connector) => (
              <button
                key={`${connector.upper}-${connector.lower}-${connector.slot}-label`}
                type="button"
                aria-pressed={isConflictSelected(selection, repo.repo, connector.ref)}
                onClick={() => onSelect({ kind: 'conflict', repo: repo.repo, ref: connector.ref })}
                className="absolute rounded-(--company-radius-sm) px-1 text-2xs text-danger hover:bg-hover"
                style={{ left: LABEL_WIDTH + connector.labelAt.x, top: connector.labelAt.y - 9 }}
              >
                {connector.conflictCount} tệp
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/** The SVG strokes of one row: the branch curve, its commit dots. */
function RowLines({ row }: { row: GraphRow }) {
  const opacity = row.dimmed ? DIMMED_OPACITY : 1;
  return (
    <g opacity={opacity}>
      {row.branchPath !== null && (
        <path d={row.branchPath} fill="none" stroke="var(--color-text-muted)" strokeWidth={2} />
      )}
      {row.dots.map((dot) => (
        <circle key={dot.x} cx={dot.x} cy={dot.y} r={DOT_RADIUS} fill="var(--color-accent)" />
      ))}
    </g>
  );
}

function ConnectorLine({ connector, selected }: { connector: GraphConnector; selected: boolean }) {
  return (
    <path
      d={connector.path}
      fill="none"
      stroke="var(--color-danger)"
      strokeWidth={selected ? 2.5 : 1.5}
      strokeDasharray="4 3"
    />
  );
}

interface GraphRowLabelsProps {
  repo: LedgerRepo;
  row: GraphRow;
  sessionsById: ReadonlyMap<string, LedgerSession>;
  selection: LedgerSelection | null;
  onSelect: (selection: LedgerSelection) => void;
}

/** The HTML laid over one row: its label, the "+N" and "↓N" counts, and session avatars. */
function GraphRowLabels({ repo, row, sessionsById, selection, onSelect }: GraphRowLabelsProps) {
  const worktree = row.worktree;
  const selected = isBranchSelected(selection, repo.repo, worktree);
  const opacity = row.dimmed ? DIMMED_OPACITY : 1;
  return (
    <>
      <button
        type="button"
        disabled={worktree === null}
        aria-pressed={selected}
        onClick={() => {
          if (worktree !== null) onSelect({ kind: 'branch', repo: repo.repo, path: worktree.path });
        }}
        className={`absolute flex flex-col justify-center overflow-hidden rounded-(--company-radius-sm) px-2 text-left hover:bg-hover disabled:cursor-default ${selected ? 'bg-selected' : ''}`}
        style={{
          top: row.y - GRAPH_ROW_HEIGHT / 2,
          height: GRAPH_ROW_HEIGHT,
          width: LABEL_WIDTH - 8,
          opacity,
        }}
      >
        <span className="block truncate text-sm text-text">
          {worktree === null ? 'origin/main' : worktree.name}
        </span>
        <span className="block truncate text-2xs text-text-muted">
          {worktree?.branch ?? 'chưa có nhánh'}
        </span>
        {worktree !== null && <WorktreeMeta worktree={worktree} />}
      </button>
      {row.behindAt !== null && worktree !== null && worktree.behind > 0 && (
        <span
          className="absolute text-2xs text-warning"
          title={behindLabel(worktree.behind)}
          style={{ left: LABEL_WIDTH + row.behindAt.x, top: row.behindAt.y - 9 }}
        >
          ↓{worktree.behind}
        </span>
      )}
      {row.moreAt !== null && (
        <span
          className="absolute text-2xs text-text-muted"
          style={{ left: LABEL_WIDTH + row.moreAt.x - 4, top: row.moreAt.y - 8 }}
        >
          +{row.aheadMore}
        </span>
      )}
      {row.avatars.map((avatar) => {
        const session = sessionsById.get(avatar.sessionId);
        if (session === undefined) return null;
        return (
          <button
            key={avatar.sessionId}
            type="button"
            aria-label={`${sessionTitle(session)}${session.live ? '' : ' (đã dừng)'}`}
            onClick={() => onSelect({ kind: 'session', sessionId: session.sessionId })}
            className={`absolute grid place-items-center rounded-full bg-raised text-2xs ${session.spamming ? 'bg-danger/14 text-danger' : 'text-text'}`}
            style={{
              left: LABEL_WIDTH + avatar.at.x - AVATAR_SIZE / 2,
              top: avatar.at.y - AVATAR_SIZE / 2,
              width: AVATAR_SIZE,
              height: AVATAR_SIZE,
              opacity,
            }}
          >
            {initialsOf(session.agentName)}
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 size-2 rounded-full"
              style={{
                background: session.live ? 'var(--color-status-success)' : 'var(--color-idle)',
              }}
            />
          </button>
        );
      })}
    </>
  );
}

/** One label in a worktree's meta line; `tone` is a text colour class. */
interface MetaSegment {
  key: string;
  text: string;
  tone: string;
}

/** The worktree's state as segments: ahead, dirty files, merged, git error. */
function worktreeMetaSegments(worktree: LedgerWorktree): MetaSegment[] {
  const segments: MetaSegment[] = [];
  if (worktree.isMain === false && worktree.ahead > 0) {
    segments.push({ key: 'ahead', text: aheadLabel(worktree.ahead), tone: 'text-text-muted' });
  }
  if (worktree.dirtyCount > 0) {
    segments.push({ key: 'dirty', text: dirtyLabel(worktree.dirtyCount), tone: 'text-warning' });
  }
  if (worktree.merged) {
    segments.push({ key: 'merged', text: 'đã gộp', tone: 'text-text-muted' });
  }
  if (worktree.gitError !== undefined) {
    segments.push({ key: 'error', text: 'lỗi git', tone: 'text-danger' });
  }
  return segments;
}

/** Worktree state on one line, so a row needs only its name, branch and this line. */
function WorktreeMeta({ worktree }: { worktree: LedgerWorktree }): ReactElement | null {
  const segments = worktreeMetaSegments(worktree);
  if (segments.length === 0) return null;
  return (
    <span className="block truncate text-2xs">
      {segments.map((segment, index) => (
        <Fragment key={segment.key}>
          {index > 0 && <span className="text-text-muted"> · </span>}
          <span className={segment.tone}>{segment.text}</span>
        </Fragment>
      ))}
    </span>
  );
}
