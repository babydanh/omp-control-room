/**
 * SessionLog: what a session did, kept by the server across reloads.
 *
 * The Log tab reads the session's entries in order, with the attempts it ran at
 * the top. The log follows the newest line only while the reader is already at
 * the bottom, so reading an older line is never yanked away. The Lệnh tab lists
 * the commands the session ran. A live command jumps to its place in the terminal;
 * any other expands in place to its output.
 */

import type { UIEvent } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';

import type { Attempt, CompanySessionLogEntry } from '../../../../core/src/company.js';
import type { CompanyViewState } from '../companyState.js';
import {
  commandExitLabel,
  type CommandTone,
  commandTone,
  formatLogTime,
  LOG_KIND_LABELS,
  logEntriesFor,
  logIsReplaying,
  type LogTone,
  logTone,
  runningToolName,
  splitCommandText,
  streamingLine,
} from '../sessionLogView.js';
import { AttemptRow } from './AttemptRow.js';

/** Pixels from the bottom that still count as "following the log". */
const FOLLOW_THRESHOLD_PX = 24;

const LOG_TONE_CLASS: Readonly<Record<LogTone, string>> = {
  text: 'text-text',
  tool: 'text-status-active',
  command: 'text-accent',
  ok: 'text-status-success',
  fail: 'text-warning',
  ask: 'text-warning',
  state: 'text-text-muted',
};

const COMMAND_TONE_CLASS: Readonly<Record<CommandTone, string>> = {
  running: 'text-accent',
  passed: 'text-status-success',
  failed: 'text-warning',
};

export interface SessionLogTabProps {
  state: CompanyViewState;
  sessionId: string;
  /** The task whose entries to show, or null for the whole session. */
  taskId: string | null;
  attempts: readonly Attempt[];
  onOpenArtifact: (artifactId: string) => void;
}

export function SessionLogTab({
  state,
  sessionId,
  taskId,
  attempts,
  onOpenArtifact,
}: SessionLogTabProps) {
  const entries = logEntriesFor(state, sessionId, taskId);
  const replaying = logIsReplaying(state, sessionId);
  const status = state.sessions[sessionId]?.status ?? '';
  // Live activity shows only while the session is busy: the tool it runs and the text it writes.
  const writing = streamingLine(state.streams[sessionId], status);
  const running = status === 'busy' ? runningToolName(logEntriesFor(state, sessionId, null)) : null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element !== null && followingRef.current) element.scrollTop = element.scrollHeight;
  }, [entries, writing, running]);

  function onScroll(event: UIEvent<HTMLDivElement>): void {
    const element = event.currentTarget;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    followingRef.current = distance < FOLLOW_THRESHOLD_PX;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {attempts.length > 0 && (
        <div className="flex max-h-48 flex-col gap-2 overflow-y-auto p-2">
          {attempts.map((attempt) => (
            <AttemptRow
              key={attempt.id}
              attempt={attempt}
              evidence={state.evidence}
              onOpenArtifact={onOpenArtifact}
            />
          ))}
        </div>
      )}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-label="Nhật ký phiên"
        data-testid="session-log"
        className="min-h-0 flex-1 overflow-y-auto border-t border-border p-2"
      >
        {replaying && <p className="text-2xs text-text-muted">Đang tải nhật ký…</p>}
        {!replaying && entries.length === 0 && writing === null && running === null && (
          <p className="text-2xs text-text-muted">Chưa có nhật ký nào.</p>
        )}
        <ol className="flex flex-col gap-1">
          {entries.map((entry) => (
            <LogRow key={entry.seq} entry={entry} />
          ))}
        </ol>
        {(running !== null || writing !== null) && (
          <div
            data-testid="session-live"
            className="mt-2 flex flex-col gap-1 border-t border-border pt-2 text-2xs"
          >
            {running !== null && <p className="text-status-active">Đang chạy công cụ {running}</p>}
            {writing !== null && (
              <p className="break-words text-text">
                <span className="text-text-muted">đang viết…</span> {writing}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function LogRow({ entry }: { entry: CompanySessionLogEntry }) {
  const tone = logTone(entry);
  const text = entry.kind === 'command' ? splitCommandText(entry.text).command : entry.text;
  return (
    <li className="company-fade-in grid grid-cols-[64px_72px_1fr] gap-2 text-2xs">
      <time dateTime={entry.at} className="tabular-nums text-text-muted">
        {formatLogTime(entry.at)}
      </time>
      <span className={`uppercase tracking-wide ${LOG_TONE_CLASS[tone]}`}>
        {LOG_KIND_LABELS[entry.kind]}
      </span>
      <span className="min-w-0 whitespace-pre-wrap break-words text-text">{text}</span>
    </li>
  );
}

export interface CommandsTabProps {
  state: CompanyViewState;
  sessionId: string;
  taskId: string | null;
  /** A live session's commands jump to the terminal; the rest expand in place. */
  live: boolean;
  onJump: (command: string, output: string | null) => void;
}

export function CommandsTab({ state, sessionId, taskId, live, onJump }: CommandsTabProps) {
  const commands = logEntriesFor(state, sessionId, taskId).filter(
    (entry) => entry.kind === 'command',
  );
  if (commands.length === 0) {
    return <p className="p-2 text-2xs text-text-muted">Chưa có lệnh nào được chạy.</p>;
  }
  return (
    <ol className="flex flex-col gap-2 p-2">
      {commands.map((entry) => (
        <CommandRow key={entry.seq} entry={entry} live={live} onJump={onJump} />
      ))}
    </ol>
  );
}

function CommandRow({
  entry,
  live,
  onJump,
}: {
  entry: CompanySessionLogEntry;
  live: boolean;
  onJump: (command: string, output: string | null) => void;
}) {
  const { command, output } = splitCommandText(entry.text);
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="company-fade-in rounded-[6px] border border-border p-2">
      <button
        type="button"
        aria-expanded={live ? undefined : expanded}
        title={live ? 'Mở lệnh này trong terminal' : undefined}
        onClick={() => (live ? onJump(command, output) : setExpanded((value) => !value))}
        className="flex w-full cursor-pointer items-baseline justify-between gap-2 text-left text-2xs"
      >
        <span className="min-w-0 truncate font-mono text-text">{command}</span>
        <span className={`shrink-0 ${COMMAND_TONE_CLASS[commandTone(entry)]}`}>
          {commandExitLabel(entry)}
        </span>
      </button>
      {!live && expanded && (
        <div>
          <p className="mt-1 text-2xs text-text-muted">
            <time dateTime={entry.at}>{formatLogTime(entry.at)}</time>
          </p>
          {output !== null ? (
            <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-[5px] bg-bg p-1 text-2xs text-text">
              {output}
            </pre>
          ) : (
            <p className="mt-1 text-2xs text-text-muted">Nhật ký không có kết quả của lệnh này.</p>
          )}
        </div>
      )}
    </li>
  );
}
