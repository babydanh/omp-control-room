/**
 * squadView: the squad runs the board shows, as pure rules.
 *
 * A squad run is the server's copy of one team request: its status, its proposal, its progress
 * and its history. The webview names what the server holds and maps each run to a lane; it never
 * decides a run's state. No DOM and no React here, so the rules are tested on their own.
 */

import type {
  SquadEventKind,
  SquadProgress,
  SquadProposal,
  SquadRowInput,
  SquadRun,
  SquadRunStatus,
  WorkItemAssignee,
} from '../../../core/src/messages.js';
import type { AssigneeOption } from './assigneeOptions.js';
import type { CompanyViewState } from './companyState.js';
import type { CompanyLaneId } from './constants.js';
import type { FolderIdentity } from './folderIdentity.js';
import { showsAllFolders } from './folderIdentity.js';
import { foldersInView } from './folderView.js';
import { workItemFolderIdentity } from './workItemView.js';

/** A folder's squad runs as the server last sent them, with the revision that sent them. */
export interface FolderSquad {
  revision: number;
  runs: SquadRun[];
}

/** Names one squad run. Run ids are unique within a folder, so the folder is part of the name. */
export interface SquadRef {
  runId: string;
  workspacePath: string;
}

/** A squad run the board shows, with the folder it is filed under. */
export interface VisibleSquadRun {
  run: SquadRun;
  workspacePath: string;
  /** The folder's label and tone when the board shows every folder; null in folder mode. */
  folder: FolderIdentity | null;
}

/** A proposal row as the drawer edits it. The key is stable across edits, so focus survives them. */
export interface SquadDraftRow {
  key: string;
  text: string;
  /** Null while the row has no assignee; the drawer's select sets it. */
  assignee: WorkItemAssignee | null;
}

export type SquadRowsVerdict = { ok: true; rows: SquadRowInput[] } | { ok: false; reason: string };

export type SquadStartVerdict = { ok: true } | { ok: false; reason: string };

/** The most rows one proposal may hold. */
export const SQUAD_MAX_ROWS = 8;

/** The longest row text the server takes, in UTF-8 bytes. */
const SQUAD_ROW_MAX_BYTES = 32768;

const LANE_BY_RUN_STATUS: Readonly<Record<SquadRunStatus, CompanyLaneId | null>> = {
  planning: 'planned',
  proposed: 'planned',
  failed: 'planned',
  working: 'running',
  done: 'done',
  stopped: 'done',
  dismissed: null,
};

const STATUS_WORD_VI: Readonly<Record<SquadRunStatus, string>> = {
  planning: 'Đang lập kế hoạch',
  proposed: 'Chờ duyệt',
  working: 'Đang làm',
  done: 'Xong',
  dismissed: 'Đã bỏ',
  failed: 'Lỗi',
  stopped: 'Đã dừng',
};

const EVENT_LABEL_VI: Readonly<Record<SquadEventKind, string>> = {
  request: 'Yêu cầu',
  turn: 'Lượt',
  proposal: 'Đề xuất',
  approved: 'Đã duyệt',
  review: 'Xem lại',
  done: 'Hoàn tất',
  dismissed: 'Đã bỏ',
  failed: 'Lỗi',
  stopped: 'Đã dừng',
};

/** The lane a run is shown in, or null when the board hides it. The run's status is the only input. */
export function squadLaneFor(run: Pick<SquadRun, 'status'>): CompanyLaneId | null {
  return LANE_BY_RUN_STATUS[run.status];
}

/** A run status in words: the card's status line and the drawer's header. */
export function squadStatusLabel(status: SquadRunStatus): string {
  return STATUS_WORD_VI[status];
}

/** A history event kind in words, for the drawer's history. */
export function squadEventLabel(kind: SquadEventKind): string {
  return EVENT_LABEL_VI[kind];
}

/** The progress chip, `Đội: 2/5 xong`, or null while the run has no task count yet. */
export function progressLabel(progress: SquadProgress): string | null {
  if (progress.total <= 0) return null;
  return `Đội: ${progress.done}/${progress.total} xong`;
}

/** A proposal's rows as editable drafts. A row keeps the key it was proposed with. */
export function rowsFromProposal(proposal: SquadProposal): SquadDraftRow[] {
  return proposal.rows.map((row, index) => ({
    key: `${proposal.id}:${index}`,
    text: row.text,
    assignee: row.assignee,
  }));
}

/** A blank row for "Thêm dòng"; the caller gives it a key no other row in the draft holds. */
export function blankDraftRow(key: string): SquadDraftRow {
  return { key, text: '', assignee: null };
}

/**
 * Whether a draft can be sent as an approval, and the rows as the server takes them: one to
 * SQUAD_MAX_ROWS rows, each with trimmed text that fits the server's limit and an assignee.
 * The reason names the first row that fails, in words the drawer can show.
 */
export function validateRows(rows: readonly SquadDraftRow[]): SquadRowsVerdict {
  if (rows.length === 0) return { ok: false, reason: 'Cần ít nhất 1 dòng việc.' };
  if (rows.length > SQUAD_MAX_ROWS) {
    return { ok: false, reason: `Tối đa ${SQUAD_MAX_ROWS} dòng việc.` };
  }
  const out: SquadRowInput[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row === undefined) continue;
    const label = `Dòng ${index + 1}`;
    const text = row.text.trim();
    if (text === '') return { ok: false, reason: `${label} chưa có nội dung.` };
    if (new TextEncoder().encode(text).length > SQUAD_ROW_MAX_BYTES) {
      return { ok: false, reason: `${label} dài quá 32 KB.` };
    }
    if (row.assignee === null) return { ok: false, reason: `${label} chưa giao cho ai.` };
    out.push({ text, assignee: row.assignee });
  }
  return { ok: true, rows: out };
}

/**
 * Whether a folder can take a squad request. A squad needs members: an agent or an omp session
 * already in the folder. A folder that offers only a new session has none.
 */
export function canStartSquad(options: readonly AssigneeOption[]): SquadStartVerdict {
  if (options.some((option) => option.group !== 'new')) return { ok: true };
  return { ok: false, reason: 'Thư mục này chưa có agent hay phiên omp nào để lập đội.' };
}

/** A key that names one squad run across every folder. */
export function squadRunKey(ref: SquadRef): string {
  return JSON.stringify([ref.workspacePath, ref.runId]);
}

/** One folder's squad runs; an empty list when the server has sent none for that folder. */
export function squadRunsOf(
  state: Pick<CompanyViewState, 'squad'>,
  workspacePath: string,
): SquadRun[] {
  return state.squad[workspacePath]?.runs ?? [];
}

/** The run a reference names, or undefined when the folder no longer holds it. */
export function findSquadRun(
  state: Pick<CompanyViewState, 'squad'>,
  ref: SquadRef,
): SquadRun | undefined {
  return squadRunsOf(state, ref.workspacePath).find((run) => run.id === ref.runId);
}

/**
 * The squad runs the board shows, in folder order then the server's order. Folder mode shows the
 * active folder's runs; all-folders mode shows every open folder's, each tagged with its folder.
 * A run appears once even if the server sent it twice.
 */
export function visibleSquadRuns(state: CompanyViewState): VisibleSquadRun[] {
  const showAll = showsAllFolders(state);
  const seen = new Set<string>();
  const rows: VisibleSquadRun[] = [];
  for (const workspacePath of foldersInView(state, Object.keys(state.squad))) {
    for (const run of squadRunsOf(state, workspacePath)) {
      const key = squadRunKey({ runId: run.id, workspacePath });
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        run,
        workspacePath,
        folder: showAll ? workItemFolderIdentity(state, workspacePath) : null,
      });
    }
  }
  return rows;
}
