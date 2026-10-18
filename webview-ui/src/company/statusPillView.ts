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
import type { TransportState } from '../../../core/src/transport.js';
import type { CompanyViewState } from './companyState.js';
import { quotaRows } from './usageView.js';

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

function runnerText(state: CompanyViewState): string | null {
  const diagnostics = state.diagnostics;
  if (!diagnostics) return null;
  return `đang chạy ${diagnostics.liveRunners}/${diagnostics.modelLeases} · xếp hàng ${diagnostics.queuedTasks} · giữ lại ${diagnostics.retainedSessions}`;
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
    { label: 'Bản sửa', value: String(state.revision ?? '-'), attention: false },
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
    summary: connected ? (runner ?? 'omp') : connectionLabel(connection),
    rows,
  };
}
