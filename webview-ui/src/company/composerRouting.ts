/**
 * composerRouting: what the composer's keys, buttons and `/` commands mean.
 *
 * Pure functions only. The component reads the board, asks these where a
 * prompt goes or what a command does, and then acts. They live outside the React
 * component because the test environment is node, and these rules are the part
 * that must not drift.
 *
 *  - Enter and the Send button: the line is typed into the selected session's terminal
 *    (`terminalLine`), where OMP reads it as its own TUI does, including its `/` commands.
 *    Ctrl/Cmd+Enter does the same. With no session selected nothing is sent.
 *  - With a herdr agent selected, the plain send goes to that agent's pane instead.
 *  - Ctrl/Cmd+Shift+Enter and the "Giao cho công ty" button: the Company workflow.
 *    A chat session is never a Company target.
 *  - `/new` opens a new omp chat in the folder and `/resume` lists the saved ones. Those
 *    two are the composer's own; every other `/` line goes to the terminal.
 */

import type { CompanySessionSummary, HerdrAgent } from '../../../core/src/company.js';
import type { OmpSessionEntry } from '../../../core/src/messages.js';
import { type CommandResultView, failureNotice } from './commandResults.js';
import type { CompanyClient } from './companyClient.js';
import type { OmpSessionsView } from './companyState.js';
import type { PromptRoute } from './promptSubmission.js';
import { companyRoleLabel } from './roleProfiles.js';
import { resolveSlashCommand } from './slashCommands.js';

/** Session states in which OMP steers rather than starting a new turn. */
const BUSY_STATUSES: readonly string[] = ['busy', 'running', 'starting'];

/** The session a route is for: the selected one, or null when nothing is selected. */
export type RouteSession = Pick<CompanySessionSummary, 'id' | 'role' | 'status'> | null;

/** Enter and the Send button: chat mode, aimed at the selected session. */
export function chatRoute(session: RouteSession): PromptRoute {
  return {
    mode: 'chat',
    delivery: session !== null && BUSY_STATUSES.includes(session.status) ? 'steer' : 'prompt',
    targetSessionId: session?.id ?? null,
  };
}

/**
 * Ctrl/Cmd+Shift+Enter and the company button. The selected session is a target
 * only when it has a Company role: a plain omp chat is never one.
 */
export function companyRoute(session: RouteSession): PromptRoute {
  return {
    mode: 'company',
    delivery: 'prompt',
    targetSessionId: session !== null && session.role !== 'chat' ? session.id : null,
  };
}

/** The line above the box: where the next plain send goes. */
export function sendTargetLabel(
  session: Pick<CompanySessionSummary, 'code' | 'name' | 'role'> | null,
  herdr: Pick<HerdrAgent, 'kind' | 'paneId'> | null = null,
): string {
  if (herdr !== null) return `Gửi tới: ${herdr.kind} · ${herdr.paneId} (herdr)`;
  if (session === null) return 'Gửi tới: phiên omp mới';
  return `Gửi tới: ${session.code} · ${session.name} · ${companyRoleLabel(session.role)}`;
}

/**
 * What a submitted draft means. `new` and `resume` are the composer's own commands.
 * `prompt` is everything else, including OMP commands with arguments OMP does not take
 * (for example `/new stuff`). The line is typed into the selected session's terminal,
 * so OMP runs its own commands exactly as its TUI does.
 */
export type ComposerCommandPlan = { kind: 'new' } | { kind: 'resume' } | { kind: 'prompt' };

export function planComposerCommand(text: string): ComposerCommandPlan {
  const resolved = resolveSlashCommand(text);
  if (resolved === null) return { kind: 'prompt' };
  switch (resolved.command.name) {
    case 'new':
      return { kind: 'new' };
    case 'resume':
      return { kind: 'resume' };
    default:
      return { kind: 'prompt' };
  }
}

/**
 * The bytes a typed line becomes in an omp terminal: the text and Enter, as the keyboard
 * sends them. Several lines go as one bracketed paste, so OMP keeps them together and
 * submits once. Blank text sends nothing.
 */
export function terminalLine(text: string): string | null {
  const line = text.replace(/\s+$/, '');
  if (line.trim() === '') return null;
  if (!line.includes('\n')) return `${line}\r`;
  return `\u001b[200~${line.replace(/\r\n?/g, '\n')}\u001b[201~\r`;
}

/**
 * Open a new omp chat in the folder, with no prompt. The session is selected once the
 * server names it in its verdict. Resolves with the verdict, so the caller can show a refusal.
 */
export function startNewChat(
  client: Pick<CompanyClient, 'newChatSession' | 'waitForCommand' | 'select'>,
): Promise<CommandResultView> {
  return client.waitForCommand(client.newChatSession()).then((verdict) => {
    if (verdict.ok && verdict.sessionId !== undefined) {
      client.select({ sessionId: verdict.sessionId });
    }
    return verdict;
  });
}

/** What the `/resume` picker shows for its request. */
export type ResumeListView =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; entries: readonly OmpSessionEntry[] };

const RESUME_LIST_FAILED = 'Chưa tải được danh sách phiên.';

/**
 * The picker's state for one `/resume` request. The list counts only as the
 * answer to THAT request, so an older answer never fills the picker. A refused
 * verdict is a failure, so the picker never waits forever on a request the server
 * turned down.
 */
export function resumeListView(
  requestId: string,
  ompSessions: OmpSessionsView | null,
  verdict: CommandResultView | undefined,
): ResumeListView {
  if (ompSessions !== null && ompSessions.requestId === requestId) {
    return { kind: 'ready', entries: ompSessions.sessions };
  }
  const failure = failureNotice(verdict, RESUME_LIST_FAILED);
  if (failure !== null) return { kind: 'failed', message: failure };
  return { kind: 'loading' };
}

const KB = 1024;
const MB = 1024 * KB;

/** Size of a saved session file: whole KB up to a megabyte, then MB to one decimal. */
export function formatSessionSize(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${Math.ceil(bytes / KB)} KB`;
}

/** A picker row's label: the session's title, or its file name when it has none. */
export function resumeRowTitle(entry: Pick<OmpSessionEntry, 'file' | 'title'>): string {
  const title = entry.title?.trim();
  if (title !== undefined && title !== '') return title;
  // The file name, whichever separator the path uses.
  return entry.file.split(/[\\/]/).pop() ?? entry.file;
}

/** An update stamp in the Vietnamese locale. An unreadable stamp is shown as sent. */
export function formatUpdatedAt(updatedAt: string): string {
  const time = Date.parse(updatedAt);
  return Number.isNaN(time) ? updatedAt : new Date(time).toLocaleString('vi-VN');
}
