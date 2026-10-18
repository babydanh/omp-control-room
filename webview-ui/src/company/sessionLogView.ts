/**
 * sessionLogView: what the drawer shows of a session's log, as pure functions.
 *
 * The log is the server's account of a session, one entry per seq. These
 * helpers choose and label what the drawer draws; they never invent an entry,
 * and an entry they cannot read is shown as sent rather than dropped.
 */

import type { CompanySessionLogEntry } from '../../../core/src/company.js';
import type { CompanyViewState, TextStreamView } from './companyState.js';

export const LOG_KIND_LABELS: Readonly<Record<CompanySessionLogEntry['kind'], string>> = {
  text: 'nói',
  tool: 'công cụ',
  command: 'lệnh',
  verdict: 'kết luận',
  question: 'hỏi',
  state: 'trạng thái',
  error: 'lỗi',
};

/** The colour family a log row is drawn in. */
export type LogTone = 'text' | 'tool' | 'command' | 'ok' | 'fail' | 'ask' | 'state';

/** The entries of one session, narrowed to one task when a task is the subject. */
export function logEntriesFor(
  state: CompanyViewState,
  sessionId: string,
  taskId: string | null,
): readonly CompanySessionLogEntry[] {
  const entries = state.sessionLogs[sessionId]?.entries ?? [];
  return taskId === null ? entries : entries.filter((entry) => entry.taskId === taskId);
}

/** Whether the session's log is still being replayed from the server. */
export function logIsReplaying(state: CompanyViewState, sessionId: string): boolean {
  const view = state.sessionLogs[sessionId];
  return view !== undefined && !view.replayed;
}

/**
 * The chips above the activity timeline. One chip is one group of log kinds, so
 * the merged timeline (commands included) can be narrowed without a second tab.
 */
export const ACTIVITY_FILTERS = ['all', 'commands', 'tools', 'says', 'asks', 'errors'] as const;
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number];

export const ACTIVITY_FILTER_LABELS: Readonly<Record<ActivityFilter, string>> = {
  all: 'Tất cả',
  commands: 'Lệnh',
  tools: 'Công cụ',
  says: 'Lời nói',
  asks: 'Kết luận & hỏi',
  errors: 'Lỗi',
};

/** Whether a log entry belongs to a filter group. `all` holds every entry, state lines included. */
export function matchesActivityFilter(
  entry: CompanySessionLogEntry,
  filter: ActivityFilter,
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'commands':
      return entry.kind === 'command';
    case 'tools':
      return entry.kind === 'tool';
    case 'says':
      return entry.kind === 'text';
    case 'asks':
      return entry.kind === 'verdict' || entry.kind === 'question';
    case 'errors':
      return (
        entry.kind === 'error' ||
        (entry.kind === 'verdict' && entry.ok === false) ||
        (entry.kind === 'command' && commandTone(entry) === 'failed')
      );
  }
}

/** The entries one chip shows, in log order. */
export function filterActivity(
  entries: readonly CompanySessionLogEntry[],
  filter: ActivityFilter,
): readonly CompanySessionLogEntry[] {
  return entries.filter((entry) => matchesActivityFilter(entry, filter));
}

/** How many entries each chip would show, so the chips can carry counts. */
export function activityCounts(
  entries: readonly CompanySessionLogEntry[],
): Readonly<Record<ActivityFilter, number>> {
  const counts = {} as Record<ActivityFilter, number>;
  for (const filter of ACTIVITY_FILTERS) counts[filter] = filterActivity(entries, filter).length;
  return counts;
}

export function logTone(entry: CompanySessionLogEntry): LogTone {
  switch (entry.kind) {
    case 'text':
      return 'text';
    case 'tool':
      return 'tool';
    case 'command':
      return 'command';
    case 'verdict':
      if (entry.ok === true) return 'ok';
      return entry.ok === false ? 'fail' : 'text';
    case 'question':
      return 'ask';
    case 'error':
      return 'fail';
    case 'state':
      return 'state';
  }
}

/** A command entry's text is its command line, then the output tail after a newline. */
export interface CommandParts {
  command: string;
  /** The output tail, or null when the command printed nothing. */
  output: string | null;
}

export function splitCommandText(text: string): CommandParts {
  const newline = text.indexOf('\n');
  if (newline === -1) return { command: text, output: null };
  const output = text.slice(newline + 1).replace(/\s+$/, '');
  return {
    command: text.slice(0, newline),
    output: output.length === 0 ? null : output,
  };
}

/** A command is passed only with exit 0 and no `ok: false`; no exit code means still running. */
export type CommandTone = 'running' | 'passed' | 'failed';

export function commandTone(entry: CompanySessionLogEntry): CommandTone {
  if (entry.exitCode === undefined) return 'running';
  return entry.exitCode === 0 && entry.ok !== false ? 'passed' : 'failed';
}

export function commandExitLabel(entry: CompanySessionLogEntry): string {
  if (entry.exitCode === undefined) return 'đang chạy';
  return `exit ${entry.exitCode}`;
}

/** HH:MM:SS in the user's local time; an unreadable timestamp shows as dashes. */
export function formatLogTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

/**
 * The tool a session is running now, or null. The log records a tool's start but
 * not its success, only its failure, so a start counts as running until something
 * after it says otherwise. A command still running belongs to the tool that started
 * it, and a state line is not news, so both are passed over. Any other entry means
 * the agent has moved on.
 */
export function runningToolName(entries: readonly CompanySessionLogEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined || entry.kind === 'state') continue;
    if (entry.kind === 'command' && entry.exitCode === undefined) continue;
    if (entry.kind !== 'tool') return null;
    return entry.ok === undefined ? (entry.toolName ?? null) : null;
  }
  return null;
}

/**
 * The live line of a busy session: the newest excerpt of what it is writing, on
 * one line. Null when the session is not busy, or has written nothing to show.
 */
export function streamingLine(stream: TextStreamView | undefined, status: string): string | null {
  if (status !== 'busy' || stream === undefined) return null;
  const line = stream.excerpt.replace(/\s+/g, ' ').trim();
  return line === '' ? null : line;
}
