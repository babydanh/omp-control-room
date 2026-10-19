/**
 * LedgerSidePanels: the read-only context around the graph: notices no session has
 * picked up, work left in checkouts, overlap scan status, folders never scanned, writes
 * to main, and the spam rule in force. Nothing here acts on the data.
 */

import type { ReactNode } from 'react';

import type { LedgerView } from '../../../../core/src/messages.js';
import {
  fileName,
  formatRelativeTime,
  pendingFlags,
  scanLabel,
  sessionTitle,
  shortSessionId,
} from './ledgerFormat.js';

export function LedgerSidePanels({ view }: { view: LedgerView }) {
  return (
    <div className="flex flex-col gap-2">
      <Panel title={`Tin chưa được nhận (${view.notices.length})`}>
        {view.notices.length === 0 ? (
          <p className="text-2xs text-text-muted">Không có tin chờ.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {view.notices.map((notice) => (
              <li key={notice.id} className="text-2xs">
                <p className="text-text">
                  {nameOf(view, notice.fromSession)} → {nameOf(view, notice.toSession)}{' '}
                  <span className="text-text-muted">
                    {formatRelativeTime(notice.ts, view.generatedAt)}
                  </span>
                </p>
                {notice.relKey !== null && (
                  <p className="font-mono text-text-muted">{notice.relKey}</p>
                )}
                <p className="whitespace-pre-wrap break-words text-text-secondary">
                  {notice.content}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={`Việc chưa xong (${view.pending.length})`}>
        {view.pending.length === 0 ? (
          <p className="text-2xs text-text-muted">Không checkout nào còn việc dở dang.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {view.pending.map((item) => (
              <li key={item.checkout} className="text-2xs">
                <p className="truncate text-text">
                  {fileName(item.checkout)}
                  {item.branch !== null && ` · ${item.branch}`}
                </p>
                <p className="text-warning">{pendingFlags(item).join(' · ')}</p>
                <p className="text-text-muted">
                  {nameOf(view, item.sessionId)} · {formatRelativeTime(item.ts, view.generatedAt)}
                  {item.hasRemote ? '' : ' · chưa có remote'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Quét trùng lặp">
        {view.overlaps.length === 0 ? (
          <p className="text-2xs text-text-muted">Chưa có lần quét nào.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {view.overlaps.map((scan) => {
              const repoName =
                view.repos.find((item) => item.repo === scan.repo)?.name ?? scan.repo;
              return (
                <li key={scan.repo} className="text-2xs">
                  <p className="text-text">
                    {repoName} · {scanLabel(scan)}
                  </p>
                  {!scan.complete && (
                    <p className="text-warning">Chưa quét hết: không được coi là sạch.</p>
                  )}
                  {scan.pending.length > 0 && (
                    <p className="text-text-muted">Đang chờ: {scan.pending.join(', ')}</p>
                  )}
                  {scan.error !== null && <p className="text-danger">{scan.error}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel title={`Thư mục chưa quét (${view.unscannedFolders.length})`}>
        {view.unscannedFolders.length === 0 ? (
          <p className="text-2xs text-text-muted">Mọi thư mục đều đã được quét.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {view.unscannedFolders.map((folder) => (
              <li key={folder.path} className="truncate font-mono text-2xs text-text-muted">
                {folder.path}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={`Ghi trực tiếp vào main (${view.mainWrites.length})`}>
        {view.mainWrites.length === 0 ? (
          <p className="text-2xs text-text-muted">Không ghi nào vào main.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {view.mainWrites.map((write, index) => (
              <li key={`${write.ts}|${write.sessionId}|${index}`} className="text-2xs">
                <p className="text-text">
                  {nameOf(view, write.sessionId)} · {formatRelativeTime(write.ts, view.generatedAt)}
                </p>
                <p className="truncate font-mono text-text-muted">
                  {write.tool ?? '?'} {write.path ?? ''}
                </p>
                {write.intent !== null && <p className="text-text-secondary">{write.intent}</p>}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <p className="text-2xs text-text-muted">
        Ngưỡng spam: {view.spamRule.callsPerWindow} lượt gọi trong {view.spamRule.windowMinutes}{' '}
        phút; {view.spamRule.sameIntentPerWindow} lượt cùng một việc; xét{' '}
        {view.spamRule.lookbackMinutes} phút gần nhất.
      </p>
    </div>
  );
}

function nameOf(view: LedgerView, sessionId: string | null): string {
  if (sessionId === null) return 'hệ thống';
  const session = view.sessions.find((item) => item.sessionId === sessionId);
  return session === undefined ? shortSessionId(sessionId) : sessionTitle(session);
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-(--company-radius-md) bg-panel p-2.5">
      <h2 className="mb-1.5 text-xs text-text">{title}</h2>
      {children}
    </section>
  );
}
