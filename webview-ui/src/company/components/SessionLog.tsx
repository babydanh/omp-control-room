/**
 * SessionLog: the activity timeline of one session, kept by the server across
 * reloads. What it said, ran, and decided share one timeline; commands are rows
 * in it, not a tab of their own. Filter chips narrow the timeline to one group.
 */

import { useContext, useRef, useState } from 'react';

import type { CompanySessionLogEntry } from '../../../../core/src/company.js';
import type { CompanyViewState } from '../companyState.js';
import {
  ACTIVITY_FILTER_LABELS,
  ACTIVITY_FILTERS,
  activityCounts,
  type ActivityFilter,
  commandExitLabel,
  type CommandTone,
  commandTone,
  filterActivity,
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
import { useStickToBottom } from '../useStickToBottom.js';
import { textWrapClass, WrapLinesContext } from '../wrapLines.js';

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

export interface SessionActivityTabProps {
  state: CompanyViewState;
  sessionId: string;
  /** The task whose entries to show, or null for the whole session. */
  taskId: string | null;
  /** A live session's commands jump to the terminal; the rest expand in place. */
  live: boolean;
  onJump: (command: string, output: string | null) => void;
}

export function SessionActivityTab({
  state,
  sessionId,
  taskId,
  live,
  onJump,
}: SessionActivityTabProps) {
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const entries = logEntriesFor(state, sessionId, taskId);
  const shown = filterActivity(entries, filter);
  const counts = activityCounts(entries);
  const replaying = logIsReplaying(state, sessionId);
  const status = state.sessions[sessionId]?.status ?? '';
  // Live activity shows only while the session is busy: the tool it runs and the text it writes.
  const writing = streamingLine(state.streams[sessionId], status);
  const running = status === 'busy' ? runningToolName(logEntriesFor(state, sessionId, null)) : null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useStickToBottom(scrollRef);
  const wrap = useContext(WrapLinesContext);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="group" aria-label="Lọc hoạt động" className="flex flex-wrap gap-1 px-2 pt-2">
        {ACTIVITY_FILTERS.map((option) => {
          // A chip for a group with nothing in it is noise; the active one always stays.
          if (option !== 'all' && option !== filter && counts[option] === 0) return null;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={filter === option}
              onClick={() => setFilter(option)}
              className={`cursor-pointer rounded-full px-2 py-0.5 text-2xs ${
                filter === option ? 'bg-well text-text' : 'text-text-muted hover:text-text'
              }`}
            >
              {ACTIVITY_FILTER_LABELS[option]}
              {counts[option] > 0 && (
                <span className="ml-1 tabular-nums text-text-muted">{counts[option]}</span>
              )}
            </button>
          );
        })}
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-label="Hoạt động của phiên"
        data-testid="session-log"
        className="min-h-0 flex-1 overflow-y-auto p-2"
      >
        {replaying && <p className="text-2xs text-text-muted">Đang tải hoạt động…</p>}
        {!replaying && entries.length === 0 && writing === null && running === null && (
          <p className="text-2xs text-text-muted">Chưa có hoạt động nào.</p>
        )}
        {!replaying && entries.length > 0 && shown.length === 0 && (
          <p className="text-2xs text-text-muted">Không có mục nào thuộc bộ lọc này.</p>
        )}
        <ol className="flex flex-col gap-1">
          {shown.map((entry) =>
            entry.kind === 'command' ? (
              <CommandRow key={entry.seq} entry={entry} live={live} onJump={onJump} />
            ) : (
              <LogRow key={entry.seq} entry={entry} />
            ),
          )}
        </ol>
        {(running !== null || writing !== null) && (
          <div data-testid="session-live" className="mt-2 flex flex-col gap-1 pt-2 text-2xs">
            {running !== null && <p className="text-status-active">Đang chạy công cụ {running}</p>}
            {writing !== null && (
              <p className={`min-w-0 text-text ${textWrapClass(wrap)}`}>
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
  const wrap = useContext(WrapLinesContext);
  return (
    <li className="company-fade-in grid min-w-0 grid-cols-[64px_72px_minmax(0,1fr)] gap-2 text-2xs">
      <time dateTime={entry.at} className="tabular-nums text-text-muted">
        {formatLogTime(entry.at)}
      </time>
      <span className={`uppercase tracking-wide ${LOG_TONE_CLASS[tone]}`}>
        {LOG_KIND_LABELS[entry.kind]}
      </span>
      <span className={`min-w-0 text-text ${textWrapClass(wrap)}`}>{entry.text}</span>
    </li>
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
  const wrap = useContext(WrapLinesContext);
  return (
    <li className="company-fade-in company-card min-w-0 p-2">
      <button
        type="button"
        aria-expanded={live ? undefined : expanded}
        title={live ? 'Mở lệnh này trong terminal' : undefined}
        onClick={() => (live ? onJump(command, output) : setExpanded((value) => !value))}
        className="flex w-full cursor-pointer items-baseline justify-between gap-2 text-left text-2xs"
      >
        <span className={`min-w-0 font-mono text-text ${textWrapClass(wrap)}`}>{command}</span>
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
            <pre
              className={`mt-1 max-h-60 overflow-auto rounded-(--company-radius-sm) bg-well p-2 text-2xs text-text ${textWrapClass(wrap)}`}
            >
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
