/**
 * `board`: the Agent Board for an agent in a terminal.
 *
 *   board status              who is working where, and the open work items
 *   board task                the work items that are this session's own
 *   board report <#n> <text>  write a progress note onto work item #n
 *   board handoff [#n]        print the handoff notes of work item #n's worktree, or of this one
 *   add --json for the raw answer
 *
 * The session names itself by HERDR_PANE_ID and its working directory. The board's port and token
 * come from ~/.pixel-agents/server.json, the file the board writes when it starts. Every answer is
 * read field by field before it is printed: a board without the agent API answers with its web page.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { WorkItem, WorkItemCloudState } from '../../core/src/messages.js';
import { isRecord } from './company/typeGuards.js';
import { HANDOFF_MAX_BYTES, type HandoffFile, readHandoffFiles } from './ledger/handoffFiles.js';

export const BOARD_HELP = [
  'board: xem và báo cho Agent Board từ terminal.',
  '',
  '  board status                  phiên nào đang làm gì ở đâu (kèm yêu cầu, cả phiên đang ngủ), và các việc chưa xong trên bảng',
  '  board task                    việc trên bảng giao cho chính phiên này',
  '  board report <#n> <nội dung>  ghi tiến độ vào lịch sử việc #n (không đổi trạng thái)',
  '  board handoff [#n]            in file bàn giao của worktree việc #n (không có #n: worktree đang đứng)',
  '',
  'Thêm --json để lấy dữ liệu thô (status, task, report).',
  'Nhắn agent khác (chạy cả khi board tắt): lane send <mã|all> "<nội dung>"; tin của mình: lane msgs --me.',
].join('\n');

const STATUS_LABEL: Record<WorkItem['status'], string> = {
  queued: 'Xếp hàng',
  running: 'Đang làm',
  needs_input: 'Chờ người dùng',
  review: 'Đang chấm',
  done: 'Xong',
  failed: 'Lỗi',
};

/** A board without the agent API answers an unknown route with its web page: say to restart it. */
const OLD_BOARD = 'Board đang chạy bản chưa có lệnh board, hoặc trả dữ liệu lạ: khởi động lại board.';

export type BoardCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'status' | 'task'; readonly json: boolean }
  | { readonly kind: 'report'; readonly json: boolean; readonly item: string; readonly text: string }
  | { readonly kind: 'handoff'; readonly item?: string }
  | { readonly kind: 'error'; readonly message: string };

export function parseBoardArgs(argv: readonly string[]): BoardCommand {
  const json = argv.includes('--json');
  const [command, ...rest] = argv.filter((arg) => arg !== '--json');
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') return { kind: 'help' };
  if (command === 'status' || command === 'task') return { kind: command, json };
  if (command === 'report') {
    const [item, ...words] = rest;
    const text = words.join(' ').trim();
    if (item === undefined || text === '') return { kind: 'error', message: 'Cách dùng: board report <#n> <nội dung>' };
    return { kind: 'report', json, item, text };
  }
  if (command === 'handoff') return rest[0] === undefined ? { kind: 'handoff' } : { kind: 'handoff', item: rest[0] };
  return { kind: 'error', message: `Không có lệnh "${command}".\n\n${BOARD_HELP}` };
}

// ── What the CLI prints, read from the board's answer ────────────

export interface CliCaller {
  readonly paneId?: string;
  readonly cwd?: string;
}

export interface CliProgress {
  readonly done: number;
  readonly total: number;
  readonly current?: string;
  readonly blocked?: string;
}

export interface CliSession {
  readonly agent: string;
  readonly state: string;
  readonly title: string;
  readonly cwd: string;
  readonly paneId?: string;
  readonly progress?: CliProgress;
  readonly request?: string;
  readonly lastRequest?: string;
}

export interface CliItem {
  readonly sequence: number;
  readonly status: WorkItem['status'];
  readonly text: string;
  readonly folder: string;
  readonly assignee: string;
  readonly reason?: string;
  readonly acceptance?: string;
  readonly repo?: string;
  readonly worktree?: { readonly path: string; readonly branch: string };
  /** Where the branch stands and what is missing, as the board last read it from git. */
  readonly delivery?: { readonly stage: string; readonly nextStep: string; readonly checkedAt: string };
  readonly history: readonly { readonly at: string; readonly message: string }[];
  readonly cloud?: {
    readonly issue: number;
    readonly url: string;
    readonly state: WorkItemCloudState;
    readonly summary?: string;
    readonly logUrl?: string;
    readonly reason?: string;
  };
}

export interface StatusAnswer {
  readonly caller: CliCaller;
  readonly you?: CliSession;
  readonly sessions: readonly CliSession[];
  readonly workItems: readonly CliItem[];
  /** Finished items whose branch has not reached origin/main; empty from a board that does not tell. */
  readonly undelivered: readonly CliItem[];
  readonly cloudIssues: readonly CliCloudIssue[];
}
export interface CliCloudIssue {
  readonly issue: number;
  readonly title: string;
  readonly url: string;
  readonly createdAt: string;
  readonly state: 'running' | 'finished';
  readonly repo?: string;
  readonly folder: string;
}

export interface TaskAnswer {
  readonly caller: CliCaller;
  readonly items: readonly CliItem[];
}

function text(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' ? value : undefined;
}

function need(record: Record<string, unknown>, field: string): string {
  const value = text(record, field);
  if (value === undefined) throw new Error(OLD_BOARD);
  return value;
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined || value === '' ? {} : ({ [key]: value } as Partial<Record<K, string>>);
}

function readCaller(value: unknown): CliCaller {
  const caller = isRecord(value) && isRecord(value['caller']) ? value['caller'] : {};
  return { ...optional('paneId', text(caller, 'paneId')), ...optional('cwd', text(caller, 'cwd')) };
}

function readProgress(value: unknown): CliProgress | undefined {
  if (!isRecord(value)) return undefined;
  const done = value['done'];
  const total = value['total'];
  if (typeof done !== 'number' || typeof total !== 'number' || total <= 0) return undefined;
  return { done, total, ...optional('current', text(value, 'current')), ...optional('blocked', text(value, 'blocked')) };
}

function readSession(value: unknown): CliSession {
  if (!isRecord(value)) throw new Error(OLD_BOARD);
  const progress = readProgress(value['progress']);
  return {
    agent: need(value, 'agent'),
    state: need(value, 'state'),
    title: need(value, 'title'),
    cwd: need(value, 'cwd'),
    ...optional('paneId', text(value, 'paneId')),
    ...(progress === undefined ? {} : { progress }),
    ...optional('request', text(value, 'request')),
    ...optional('lastRequest', text(value, 'lastRequest')),
  };
}

function readAssignee(value: unknown): string {
  if (!isRecord(value)) return '?';
  const kind = text(value, 'kind') ?? '?';
  if (kind === 'herdr') return `pane ${text(value, 'paneId') ?? '?'}`;
  if (kind === 'session') return `phiên ${text(value, 'sessionId') ?? '?'}`;
  return kind;
}

const CLOUD_STATE_LABEL: Record<WorkItemCloudState, string> = {
  running: 'đang chạy trên cloud',
  finished: 'xong trên cloud',
  waiting_clean: 'chờ worktree sạch',
  diverged: 'nhánh bị rẽ',
  pulled: 'đã kéo về',
  no_changes: 'không có thay đổi',
  closed: 'đã đóng',
};

function isStatus(value: unknown): value is WorkItem['status'] {
  return typeof value === 'string' && Object.hasOwn(STATUS_LABEL, value);
}

function readCloud(value: unknown): Pick<CliItem, 'cloud'> {
  if (!isRecord(value)) return {};
  const issue = value['issue'];
  const url = text(value, 'url');
  const state = text(value, 'state');
  if (typeof issue !== 'number' || !Number.isInteger(issue) || issue < 1 || url === undefined || state === undefined || !Object.hasOwn(CLOUD_STATE_LABEL, state)) return {};
  return {
    cloud: {
      issue,
      url,
      state: state as WorkItemCloudState,
      ...optional('summary', text(value, 'summary')),
      ...optional('logUrl', text(value, 'logUrl')),
      ...optional('reason', text(value, 'reason')),
    },
  };
}

function readItem(value: unknown): CliItem {
  if (!isRecord(value)) throw new Error(OLD_BOARD);
  const sequence = value['sequence'];
  const status = value['status'];
  if (typeof sequence !== 'number' || !isStatus(status)) throw new Error(OLD_BOARD);
  const worktree = value['worktree'];
  const path = isRecord(worktree) ? text(worktree, 'path') : undefined;
  const branch = isRecord(worktree) ? text(worktree, 'branch') : undefined;
  const history = Array.isArray(value['history']) ? value['history'] : [];
  return {
    sequence,
    status,
    text: need(value, 'text'),
    folder: need(value, 'folder'),
    assignee: readAssignee(value['assignee']),
    ...optional('reason', text(value, 'reason')),
    ...optional('acceptance', text(value, 'acceptance')),
    ...optional('repo', text(value, 'repo')),
    ...(path === undefined || branch === undefined || value['worktreeRemoved'] === true ? {} : { worktree: { path, branch } }),
    ...readDelivery(value['delivery']),
    ...readCloud(value['cloud']),
    history: history.flatMap((event) => {
      if (!isRecord(event)) return [];
      const at = text(event, 'at');
      const message = text(event, 'message');
      return at === undefined || message === undefined ? [] : [{ at, message }];
    }),
  };
}

function readDelivery(value: unknown): Pick<CliItem, 'delivery'> {
  if (!isRecord(value)) return {};
  const stage = text(value, 'stage');
  const nextStep = text(value, 'nextStep');
  const checkedAt = text(value, 'checkedAt');
  return stage === undefined || nextStep === undefined || checkedAt === undefined ? {} : { delivery: { stage, nextStep, checkedAt } };
}

function readCloudIssue(value: unknown): CliCloudIssue {
  if (!isRecord(value)) throw new Error(OLD_BOARD);
  const issue = value['issue'];
  const state = text(value, 'state');
  if (typeof issue !== 'number' || !Number.isInteger(issue) || issue < 1 || (state !== 'running' && state !== 'finished')) throw new Error(OLD_BOARD);
  return {
    issue,
    title: need(value, 'title'),
    url: need(value, 'url'),
    createdAt: need(value, 'createdAt'),
    state,
    ...optional('repo', text(value, 'repo')),
    folder: need(value, 'folder'),
  };
}

const DELIVERY_LABEL: Record<string, string> = {
  uncommitted: 'CHƯA COMMIT',
  no_commits: 'chưa có commit',
  branch: 'chỉ trên nhánh',
  staging: 'đã lên staging, chưa main',
  main: 'đã vào main',
};

function deliveryText(item: CliItem): string {
  const delivery = item.delivery;
  if (delivery === undefined) return '';
  return `${DELIVERY_LABEL[delivery.stage] ?? delivery.stage} (kiểm ${delivery.checkedAt.slice(0, 16).replace('T', ' ')}) · Tiếp theo: ${delivery.nextStep}`;
}

function readList<T>(value: unknown, field: string, read: (entry: unknown) => T): T[] {
  const list = isRecord(value) ? value[field] : undefined;
  if (!Array.isArray(list)) throw new Error(OLD_BOARD);
  return list.map(read);
}

export function readStatusAnswer(value: unknown): StatusAnswer {
  const you = isRecord(value) && value['you'] !== undefined ? readSession(value['you']) : undefined;
  return {
    caller: readCaller(value),
    ...(you === undefined ? {} : { you }),
    sessions: readList(value, 'sessions', readSession),
    workItems: readList(value, 'workItems', readItem),
    undelivered: isRecord(value) && Array.isArray(value['undelivered']) ? value['undelivered'].map(readItem) : [],
    cloudIssues: isRecord(value) && Array.isArray(value['cloudIssues']) ? value['cloudIssues'].map(readCloudIssue) : [],
  };
}

export function readTaskAnswer(value: unknown): TaskAnswer {
  return { caller: readCaller(value), items: readList(value, 'items', readItem) };
}

// ── Printing ─────────────────────────────────────────────────────

function clip(value: string, max: number): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function progressText(progress: CliProgress | undefined): string {
  if (progress === undefined) return '';
  const percent = Math.round((Math.min(progress.done, progress.total) / progress.total) * 100);
  const tail = progress.blocked ? ` · KẸT: ${clip(progress.blocked, 160)}` : progress.current ? ` · đang: ${clip(progress.current, 100)}` : '';
  return ` · ${progress.done}/${progress.total} (${percent}%)${tail}`;
}

/** What the session was asked and its newest message, on its own line: a sleeping session titled by its id is found again by it. */
function requestText(session: CliSession): string {
  const parts = [
    session.request && `Yêu cầu: ${clip(session.request, 140)}`,
    session.lastRequest && `Gần nhất: ${clip(session.lastRequest, 140)}`,
  ].filter(Boolean);
  return parts.length === 0 ? '' : `\n      ${parts.join(' · ')}`;
}

function sessionLine(session: CliSession): string {
  const pane = session.paneId === undefined ? '' : ` [${session.paneId}]`;
  return `  ${session.agent}${pane} · ${session.state} · ${clip(session.title, 80)} · ${session.cwd}${progressText(session.progress)}${requestText(session)}`;
}

function itemLine(item: CliItem): string {
  const cloud = item.cloud === undefined ? '' : ` · cloud #${item.cloud.issue} [${CLOUD_STATE_LABEL[item.cloud.state]}]`;
  return `  #${item.sequence} [${STATUS_LABEL[item.status]}] ${clip(item.text, 100)} → ${item.assignee}${cloud}${item.reason ? ` · ${clip(item.reason, 140)}` : ''}`;
}

function callerText(caller: CliCaller): string {
  return [caller.paneId && `pane ${caller.paneId}`, caller.cwd].filter(Boolean).join(' · ') || 'không rõ';
}

export function formatStatus(answer: StatusAnswer): string {
  const lines = [`Bạn: ${callerText(answer.caller)}${answer.you ? ` · ${answer.you.agent} "${clip(answer.you.title, 60)}"` : ''}`, ''];
  lines.push(`Phiên đang chạy (${answer.sessions.length}):`);
  lines.push(...(answer.sessions.length === 0 ? ['  (không có)'] : answer.sessions.map(sessionLine)));
  lines.push('', `Việc chưa xong trên bảng (${answer.workItems.length}):`);
  lines.push(...(answer.workItems.length === 0 ? ['  (không có)'] : answer.workItems.map(itemLine)));
  if (answer.undelivered.length > 0) {
    lines.push('', `Việc xong nhưng chưa vào main (${answer.undelivered.length}):`);
    lines.push(...answer.undelivered.map((item) => `${itemLine(item)}\n      ${deliveryText(item)}`));
  }
  if (answer.cloudIssues.length > 0) {
    lines.push('', `Issue [Handoff] ngoài board (${answer.cloudIssues.length}):`);
    lines.push(...answer.cloudIssues.map((issue) =>
      `  #${issue.issue} [${cloudIssueLabel(issue, Date.now())}] ${clip(issue.title, 100)} · ${issue.folder}${issue.repo ? ` · ${issue.repo}` : ''}\n      ${issue.url}`,
    ));
  }
  return lines.join('\n');
}

/** A cloud run reports within hours (cloud-watch gives up after 8): an older Issue with no summary is not "running". */
const CLOUD_SILENT_AFTER_MS = 8 * 3_600_000;

function cloudIssueLabel(issue: { readonly state: WorkItemCloudState; readonly createdAt: string }, now: number): string {
  const created = Date.parse(issue.createdAt);
  if (issue.state === 'running' && Number.isFinite(created) && now - created > CLOUD_SILENT_AFTER_MS) {
    return 'chưa có tổng kết sau 8 giờ: xem Issue';
  }
  return CLOUD_STATE_LABEL[issue.state];
}

export function formatTask(answer: TaskAnswer): string {
  if (answer.items.length === 0) return `Không có việc nào trên bảng giao cho phiên này (${callerText(answer.caller)}).`;
  return answer.items.map((item) => {
    const lines = [`#${item.sequence} · ${STATUS_LABEL[item.status]} · ${item.folder}`, `Việc: ${item.text.trim()}`];
    if (item.acceptance) lines.push(`Xong khi: ${item.acceptance}`);
    if (item.repo) lines.push(`Repo: ${item.repo}`);
    if (item.worktree) lines.push(`Worktree: ${item.worktree.path} (nhánh ${item.worktree.branch})`);
    if (item.delivery) lines.push(`Giao hàng: ${deliveryText(item)}`);
    if (item.reason) lines.push(`Lý do/chặn: ${item.reason}`);
    if (item.cloud !== undefined) {
      lines.push(`Cloud: Issue #${item.cloud.issue} [${CLOUD_STATE_LABEL[item.cloud.state]}] ${item.cloud.url}`);
      if (item.cloud.summary) lines.push(`Cloud kết quả: ${item.cloud.summary}`);
      if (item.cloud.logUrl) lines.push(`Cloud log: ${item.cloud.logUrl}`);
      if (item.cloud.reason) lines.push(`Cloud chặn: ${item.cloud.reason}`);
    }
    const recent = item.history.slice(-6);
    if (recent.length > 0) lines.push('Lịch sử gần đây:', ...recent.map((event) => `  ${event.at.slice(0, 16).replace('T', ' ')} ${clip(event.message, 200)}`));
    lines.push(`Báo tiến độ: board report #${item.sequence} "<nội dung>"`);
    return lines.join('\n');
  }).join('\n\n');
}

/** The handoff notes of one worktree, each file whole, or how to start one when there is none. */
export function formatHandoff(worktree: string, files: readonly HandoffFile[]): string {
  if (files.length === 0) {
    return `Không có file bàn giao trong ${worktree} (HANDOFF.md hoặc openspec/changes/<id>/handoff.md).\n` +
      'Mẫu: ~/.omp/agent/skills/git-worktree-lanes/handoff-template.md';
  }
  return files.map((file) => {
    const when = file.modifiedAt.toLocaleString('vi-VN', { hour12: false });
    const cut = file.truncated ? `\n… (cắt ở ${HANDOFF_MAX_BYTES / 1024} KB đầu)` : '';
    return `── ${join(worktree, file.path)} · sửa ${when} ──\n${file.text.trimEnd()}${cut}`;
  }).join('\n\n');
}

/** The nearest folder from `cwd` up that holds `.git` (a worktree has a `.git` file); else `cwd`. */
function worktreeRoot(cwd: string): string {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return cwd;
  }
}

// ── Talking to the board ─────────────────────────────────────────

interface BoardServer {
  readonly port: number;
  readonly token: string;
}

function readServer(): BoardServer {
  const file = join(homedir(), '.pixel-agents', 'server.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`Board chưa chạy (không đọc được ${file}).`);
  }
  const port = isRecord(parsed) ? parsed['port'] : undefined;
  const token = isRecord(parsed) ? parsed['token'] : undefined;
  if (typeof port !== 'number' || typeof token !== 'string') throw new Error(`${file} thiếu port hoặc token.`);
  return { port, token };
}

async function call(server: BoardServer, path: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${server.port}/api/agent/${path}`, {
      ...init,
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    });
  } catch {
    throw new Error(`Không kết nối được board ở cổng ${server.port}: board có đang chạy không?`);
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = isRecord(body) ? body['error'] : undefined;
    throw new Error(typeof error === 'string' ? error : `Board trả lỗi ${response.status}.`);
  }
  return body;
}

export async function runBoard(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const command = parseBoardArgs(argv);
  if (command.kind === 'help') return BOARD_HELP;
  if (command.kind === 'error') throw new Error(command.message);
  if (command.kind === 'handoff' && command.item === undefined) {
    const root = worktreeRoot(cwd);
    return formatHandoff(root, await readHandoffFiles(root));
  }
  const server = readServer();
  const pane = env['HERDR_PANE_ID'];
  const caller = { cwd, ...(pane ? { pane } : {}) };
  if (command.kind === 'handoff') {
    const sequence = Number(command.item?.replace(/^#/, ''));
    const status = readStatusAnswer(await call(server, `status?${new URLSearchParams(caller).toString()}`));
    const item = status.workItems.find((entry) => entry.sequence === sequence);
    if (item === undefined) throw new Error(`Không thấy việc ${command.item} trong các việc chưa xong trên bảng.`);
    if (item.worktree === undefined) throw new Error(`Việc #${item.sequence} chưa có worktree.`);
    return formatHandoff(item.worktree.path, await readHandoffFiles(item.worktree.path));
  }
  if (command.kind === 'report') {
    const answer = await call(server, 'report', {
      method: 'POST',
      body: JSON.stringify({ item: command.item, text: command.text, ...caller }),
    });
    const item = isRecord(answer) ? answer['item'] : undefined;
    const folder = isRecord(answer) ? answer['folder'] : undefined;
    if (typeof item !== 'number' || typeof folder !== 'string') throw new Error(OLD_BOARD);
    return command.json ? JSON.stringify(answer, null, 2) : `Đã ghi vào lịch sử việc #${item} (${folder}).`;
  }
  const answer = await call(server, `${command.kind}?${new URLSearchParams(caller).toString()}`);
  if (command.kind === 'status') {
    const status = readStatusAnswer(answer);
    return command.json ? JSON.stringify(answer, null, 2) : formatStatus(status);
  }
  const task = readTaskAnswer(answer);
  return command.json ? JSON.stringify(answer, null, 2) : formatTask(task);
}

/** Runs one `board` command and prints its answer; `boardMain.ts` calls it. */
export function main(): void {
  runBoard(process.argv.slice(2), process.env, process.cwd()).then(
    (output) => {
      process.stdout.write(`${output}\n`);
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
