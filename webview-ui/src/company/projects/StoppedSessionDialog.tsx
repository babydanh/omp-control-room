/**
 * StoppedSessionDialog: one session from "Vừa ngủ / tắt", opened to decide whether to wake it.
 *
 * It shows the session's code, what it was last asked (the newest prompts first), what the agent
 * last answered, and whether it stopped with work left; then wakes it. A sleeping herdr pane is
 * woken by herdr; an exited omp or Claude session is resumed in a new herdr tab. The optional
 * prompt goes with the wake, and the dialog closes only once the server confirms it.
 */

import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ProjectTreeNode } from '../../../../core/src/messages.js';
import { failureNotice } from '../commandResults.js';
import type { CompanyClient } from '../companyClient.js';
import { CompanyButton } from '../components/CompanyButton.js';
import { useNow } from '../useNow.js';
import { type ProjectStore, type ProjectWakeTarget, waitForProjectWake } from './projectStore.js';
import { isEndedNode, sessionCode, sessionDisplayName, stoppedLabel, stoppedWakeKind } from './projectTreeView.js';

/** The server's limit on a wake prompt, in characters. */
const WAKE_PROMPT_MAX_CHARS = 4000;

export interface StoppedSessionDialogProps {
  readonly node: ProjectTreeNode;
  readonly client: CompanyClient;
  readonly store: ProjectStore;
  readonly onClose: () => void;
  /** The wake went through: the session runs here now. */
  readonly onWoken: (target: ProjectWakeTarget) => void;
}

export function StoppedSessionDialog({ node, client, store, onClose, onWoken }: StoppedSessionDialogProps) {
  const now = useNow();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [opener] = useState<Element | null>(() => document.activeElement);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const wakeKind = stoppedWakeKind(node);
  const code = sessionCode(node);
  const label = stoppedLabel(node, now);
  const progress = node.progress;
  // The first request has its own line; the newest prompts list the others, newest first.
  const recent = (node.recentRequests ?? []).filter((text) => text !== node.request);

  useEffect(() => {
    promptRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) opener.focus();
    };
  }, [opener]);

  async function wake(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const sessionId = node.sessionId;
    if (pending || wakeKind === null || sessionId === undefined) return;
    setPending(true);
    setNotice(null);
    const text = draft.trim();
    if (wakeKind === 'pane') {
      const verdict = await client.waitForCommand(client.herdrWake(sessionId, text === '' ? undefined : text));
      if (verdict.ok) {
        onWoken({ paneId: verdict.paneId ?? sessionId });
        return;
      }
      setNotice(failureNotice(verdict, 'Không đánh thức được.'));
    } else {
      const outcome = await waitForProjectWake(store, store.wakeSession(sessionId, text), sessionId);
      if ('target' in outcome) {
        onWoken(outcome.target);
        return;
      }
      if ('refusal' in outcome) setNotice(outcome.refusal);
    }
    setPending(false);
  }

  function copyCode(): void {
    if (code === null) return;
    void navigator.clipboard.writeText(code.full).then(
      () => setCopied(true),
      () => setNotice('Không chép được mã: hãy bôi đen và chép tay.'),
    );
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }

  const header = [isEndedNode(node) ? 'Đã tắt' : 'Ngủ đông', node.engine === 'herdr' ? undefined : node.engine, label]
    .filter(Boolean)
    .join(' · ');
  const dialog = (
    // The company scale (spacing, text sizes) and reduced motion live on .company-ui.
    <div className="company-ui">
      <div className="fixed inset-0 z-40 flex items-center justify-center">
        <button type="button" aria-label="Đóng chi tiết phiên" onClick={onClose} className="absolute inset-0 cursor-default bg-black/40" />
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="stopped-session-title"
          data-testid="stopped-session-dialog"
          onKeyDown={onKeyDown}
          className="relative flex max-h-[90vh] w-[min(520px,94vw)] flex-col gap-3 overflow-y-auto rounded-(--company-radius-md) bg-panel p-3 text-xs text-text max-md:h-full max-md:max-h-none max-md:w-full max-md:rounded-none"
        >
          <header className="flex items-start gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="text-2xs text-text-muted">{header}</p>
              <h2 id="stopped-session-title" className="break-words text-sm text-text">{sessionDisplayName(node)}</h2>
              {node.path !== undefined && <p className="truncate text-2xs text-text-muted" title={node.path}>{node.path}</p>}
            </div>
            <CompanyButton type="button" size="sm" aria-label="Đóng" onClick={onClose}>×</CompanyButton>
          </header>

          {code !== null && (
            <p className="flex flex-wrap items-center gap-2 text-2xs text-text-muted">
              Mã phiên
              <code className="min-w-0 break-all rounded-(--company-radius-sm) bg-well px-1.5 py-0.5 font-mono text-text" data-testid="stopped-session-code">{code.full}</code>
              <CompanyButton type="button" size="sm" onClick={copyCode}>{copied ? 'Đã chép' : 'Chép mã'}</CompanyButton>
            </p>
          )}

          {node.interrupted !== undefined && <p className="text-status-error">Bị ngắt: {node.interrupted}</p>}
          {progress !== undefined && (
            <p className="text-text-secondary">
              Tiến độ {progress.done}/{progress.total}
              {progress.current === undefined ? '' : ` · đang làm: ${progress.current}`}
            </p>
          )}
          {progress?.blocked !== undefined && <p className="text-status-error">Kẹt: {progress.blocked}</p>}

          <section aria-labelledby="stopped-session-reply" className="flex flex-col gap-1">
            <h3 id="stopped-session-reply" className="text-2xs font-semibold text-text-muted">Agent làm gì gần nhất</h3>
            <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-(--company-radius-sm) bg-well p-2 text-text-secondary" data-testid="stopped-session-reply">
              {node.lastReply ?? 'Transcript chưa có câu trả lời nào của agent.'}
            </p>
          </section>

          <section aria-labelledby="stopped-session-prompts" className="flex flex-col gap-1">
            <h3 id="stopped-session-prompts" className="text-2xs font-semibold text-text-muted">Prompt gần nhất</h3>
            {recent.length === 0 && node.request === undefined ? (
              <p className="text-text-muted">Transcript chưa có prompt nào.</p>
            ) : (
              <ol className="flex flex-col gap-1" data-testid="stopped-session-prompts">
                {recent.map((text, index) => (
                  <li key={index} className="break-words rounded-(--company-radius-sm) bg-well px-2 py-1 text-text-secondary">
                    <span className="mr-1 text-text-muted">{index === 0 ? 'Mới nhất:' : `${index + 1}.`}</span>
                    {text}
                  </li>
                ))}
                {node.request !== undefined && (
                  <li className="break-words rounded-(--company-radius-sm) bg-well px-2 py-1 text-text">
                    <span className="mr-1 text-text-muted">Việc ban đầu:</span>
                    {node.request}
                  </li>
                )}
              </ol>
            )}
          </section>

          {notice !== null && <p role="alert" className="rounded-(--company-radius-sm) bg-warning/12 px-2 py-1 text-2xs text-warning">{notice}</p>}

          {wakeKind === null ? (
            <p className="text-2xs text-text-muted">Board chỉ đánh thức được pane herdr đang ngủ và phiên omp hoặc Claude đã tắt.</p>
          ) : (
            <form onSubmit={(event) => void wake(event)} className="flex flex-col gap-2">
              <textarea
                ref={promptRef}
                aria-label="Lời nhắc khi đánh thức"
                rows={2}
                value={draft}
                maxLength={WAKE_PROMPT_MAX_CHARS}
                disabled={pending}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Lời nhắc khi đánh thức (không bắt buộc), ví dụ: làm tiếp việc dở"
                className="min-h-16 resize-y rounded-(--company-radius-sm) bg-well px-2 py-1 text-xs text-text disabled:text-text-muted"
              />
              <div className="flex flex-wrap justify-end gap-1">
                <CompanyButton type="button" size="sm" onClick={onClose}>Đóng</CompanyButton>
                <CompanyButton type="submit" size="sm" variant="accent" disabled={pending}>
                  {pending ? 'Đang đánh thức…' : 'Đánh thức'}
                </CompanyButton>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
