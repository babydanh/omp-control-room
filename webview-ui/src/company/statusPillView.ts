/**
 * statusPillView: what the top bar's one status pill says, as pure data. The pill
 * shows one summary; its popover lists every reading the company has: the
 * connection, the revision, the model catalog, the omp runner, and each provider
 * quota window. A value the server has not sent yet reads as unknown, never zero.
 */

import {
  TRANSPORT_STATE_CONNECTED,
  TRANSPORT_STATE_CONNECTING,
  TRANSPORT_STATE_DISCONNECTED,
  TRANSPORT_STATE_RECONNECTING,
} from '../../../core/src/constants.js';
import type { CompanyDiagnostics } from '../../../core/src/messages.js';
import type { TransportState } from '../../../core/src/transport.js';
import type { CompanyViewState } from './companyState.js';
import { showsAllFolders } from './folderIdentity.js';
import { foldersInView } from './folderView.js';
import { quotaRows } from './usageView.js';
import { folderLabelFor } from './workspaces.js';

export interface StatusRow {
  label: string;
  value: string;
  /** Whether the reading needs the reader's attention; drawn in the warning colour. */
  attention: boolean;
}

export interface StatusPillView {
  /** Attention when the board cannot reach the server or a quota window is spent. */
  tone: 'calm' | 'attention';
  /** What the pill itself says, short enough for a phone bar. */
  summary: string;
  rows: readonly StatusRow[];
}

function connectionLabel(connection: TransportState): string {
  switch (connection) {
    case TRANSPORT_STATE_CONNECTED:
      return 'đã kết nối';
    case TRANSPORT_STATE_CONNECTING:
      return 'đang kết nối…';
    case TRANSPORT_STATE_RECONNECTING:
      return 'đang kết nối lại…';
    case TRANSPORT_STATE_DISCONNECTED:
      return 'đã ngắt kết nối';
  }
}

function catalogText(state: CompanyViewState): string {
  if (!state.modelCatalogLoaded) return 'đang tải…';
  const entries = state.modelCatalog;
  if (entries.length === 0) return 'không có mô hình nào';
  const usable = entries.filter((entry) => entry.credentialsConfigured).length;
  return `${usable}/${entries.length} dùng được`;
}

/**
 * The omp diagnostics the pill reads: the focused folder's in folder mode, and every folder in
 * view's in all mode, so the runner counts are totals across the board.
 */
function diagnosticsInView(state: CompanyViewState): CompanyDiagnostics[] {
  if (!showsAllFolders(state)) return state.diagnostics ? [state.diagnostics] : [];
  return foldersInView(state, Object.keys(state.folders)).flatMap(
    (path) => state.folders[path]?.diagnostics ?? [],
  );
}

function runnerText(state: CompanyViewState): string | null {
  const measured = diagnosticsInView(state);
  if (measured.length === 0) return null;
  const total = (pick: (diagnostics: CompanyDiagnostics) => number): number =>
    measured.reduce((sum, diagnostics) => sum + pick(diagnostics), 0);
  return `đang chạy ${total((d) => d.liveRunners)}/${total((d) => d.modelLeases)} · xếp hàng ${total((d) => d.queuedTasks)} · giữ lại ${total((d) => d.retainedSessions)}`;
}

/**
 * The revision the server last reported: the focused folder's in folder mode, and each folder in
 * view's in all mode, since revisions of different folders do not add up to anything.
 */
function revisionText(state: CompanyViewState): string {
  if (!showsAllFolders(state)) return String(state.revision ?? '-');
  const revisions = foldersInView(state, Object.keys(state.folders)).map(
    (path) => `${folderLabelFor(state.workspaces, path)} ${state.folders[path]?.revision ?? '-'}`,
  );
  return revisions.length === 0 ? '-' : revisions.join(' · ');
}

/**
 * The pill's one word or phrase: whether the company is ready, needs attention, or the board
 * is cut off. The runner counts stay in the popover, where there is room to read them.
 */
function pillSummary(connection: TransportState, spent: boolean): string {
  switch (connection) {
    case TRANSPORT_STATE_CONNECTED:
      return spent ? 'Cần chú ý' : 'Sẵn sàng';
    case TRANSPORT_STATE_CONNECTING:
      return 'Đang kết nối…';
    case TRANSPORT_STATE_RECONNECTING:
      return 'Đang kết nối lại…';
    case TRANSPORT_STATE_DISCONNECTED:
      return 'Mất kết nối';
  }
}

export function statusPillView(
  connection: TransportState,
  state: CompanyViewState,
): StatusPillView {
  const connected = connection === TRANSPORT_STATE_CONNECTED;
  const runner = runnerText(state);
  const windows = quotaRows(Object.values(state.quotas)).flatMap((row) =>
    row.windows.map((quotaWindow) => ({
      label: `${row.provider} ${quotaWindow.label}`,
      value: `${quotaWindow.remaining ?? '?'} ${quotaWindow.reportedUnit}`,
      spent: quotaWindow.remaining === 0,
    })),
  );
  const rows: StatusRow[] = [
    { label: 'Kết nối', value: connectionLabel(connection), attention: !connected },
    { label: 'Bản sửa', value: revisionText(state), attention: false },
    { label: 'Mô hình', value: catalogText(state), attention: false },
    { label: 'omp', value: runner ?? 'chưa có số liệu', attention: false },
    ...windows.map((entry) => ({
      label: entry.label,
      value: entry.value,
      attention: entry.spent,
    })),
  ];
  const spent = windows.some((entry) => entry.spent);
  return {
    tone: !connected || spent ? 'attention' : 'calm',
    summary: pillSummary(connection, spent),
    rows,
  };
}
