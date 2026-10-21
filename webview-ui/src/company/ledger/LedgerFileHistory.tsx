import { useEffect } from 'react';

import type { LedgerFileTouch } from '../../../../core/src/messages.js';
import { relativeTimeVi } from '../agentSidebarView.js';
import { useNow } from '../useNow.js';
import { ledgerStore } from './ledgerClient.js';
import type { LedgerState } from './ledgerStore.js';

export function LedgerFileHistory({ ledger, absolutePath }: { ledger: LedgerState; absolutePath: string }) {
  const history = ledger.fileHistory;
  useEffect(() => {
    if (history?.path !== absolutePath) ledgerStore.requestFileHistory(absolutePath);
  }, [absolutePath, history?.path]);

  if (history === null || history.path !== absolutePath || history.status === 'loading') {
    return <section aria-label="Lịch sử file"><h4 className="text-sm font-semibold text-text">Lịch sử file</h4><p role="status" className="text-xs text-text-muted">Đang tải lịch sử…</p></section>;
  }
  if (history.status === 'failed') {
    return <section aria-label="Lịch sử file"><h4 className="text-sm font-semibold text-text">Lịch sử file</h4><p role="status" className="text-xs text-text-muted">{history.reason ?? 'Không tải được lịch sử file.'}</p></section>;
  }
  return <section aria-label="Lịch sử file"><h4 className="text-sm font-semibold text-text">Lịch sử file</h4>{history.entries.length === 0 ? <p className="text-xs text-text-muted">Chưa có hoạt động trong 7 ngày.</p> : <ul className="flex flex-col gap-1">{history.entries.map((entry, index) => <HistoryEntry key={`${entry.ts}-${entry.sessionId}-${index}`} entry={entry} />)}</ul>}</section>;
}

function HistoryEntry({ entry }: { entry: LedgerFileTouch }) {
  const time = relativeTimeVi(entry.ts, useNow()) ?? 'không rõ thời gian';
  const agent = entry.agentName ?? entry.agentKind ?? 'Agent không rõ';
  return <li className="grid grid-cols-[70px_minmax(0,1fr)] gap-x-2 text-xs"><span className="text-text-muted">{time}</span><span className="min-w-0 truncate text-text-secondary" title={entry.intent ?? undefined}>{agent}{entry.branch === null ? '' : ` · ${entry.branch}`}{entry.intent === null ? '' : ` · ${entry.intent}`}</span></li>;
}
