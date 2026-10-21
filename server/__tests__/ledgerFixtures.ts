/**
 * Fakes shared by the ledger tests. Every clock, script run, git result, database
 * row and timer comes from here, so no test touches the disk, a process, or a real
 * timer. Ledger timestamps are local wall-clock strings, matching the activity DB.
 */

import type { LedgerDatabaseStatus } from '../../core/src/messages.js';
import type { GitRunner, GitRunOptions } from '../src/ledger/git.js';
import type {
  EventRow,
  LedgerFileTouch,
  LedgerSource,
  NoticeRow,
  PendingRow,
  SessionRow,
} from '../src/ledger/ledgerDb.js';
import {
  type LedgerScheduler,
  LedgerService,
  type LedgerTimerHandle,
} from '../src/ledger/ledgerService.js';
import { formatLedgerTime } from '../src/ledger/ledgerTime.js';
import type { ProcessOptions, ProcessResult, ScriptRunner } from '../src/ledger/processRunner.js';

/** The "now" every ledger test uses: a fixed local wall-clock instant. */
export const LEDGER_NOW_MS = new Date(2026, 3, 10, 12, 0, 0).getTime();

/** Ledger-format local timestamp `minutes` before `LEDGER_NOW_MS`. */
export function minutesAgo(minutes: number): string {
  return formatLedgerTime(LEDGER_NOW_MS - minutes * 60_000);
}

/** Lets queued promise callbacks and `setImmediate` work run, as the other server tests do. */
export async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

let nextEventId = 0;

export function sessionRow(sessionId: string, overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId,
    pid: null,
    cwd: null,
    agentKind: 'main',
    agentName: null,
    parentId: null,
    startedAt: null,
    lastSeen: null,
    endedAt: null,
    state: null,
    heartbeat: null,
    ...overrides,
  };
}

export function eventRow(sessionId: string, overrides: Partial<EventRow> = {}): EventRow {
  nextEventId += 1;
  return {
    id: nextEventId,
    ts: minutesAgo(0),
    sessionId,
    kind: 'edit',
    tool: 'edit',
    path: null,
    pathKey: null,
    repo: null,
    checkout: null,
    isMainCheckout: false,
    branch: null,
    intent: null,
    ...overrides,
  };
}

export function pendingRow(checkout: string, overrides: Partial<PendingRow> = {}): PendingRow {
  return {
    checkout,
    sessionId: null,
    branch: null,
    dirty: 0,
    unpushed: 0,
    notInMain: 0,
    hasRemote: false,
    ts: minutesAgo(0),
    ...overrides,
  };
}

export function noticeRow(id: number, overrides: Partial<NoticeRow> = {}): NoticeRow {
  return {
    id,
    ts: minutesAgo(0),
    toSession: 'session-to',
    fromSession: null,
    relKey: null,
    content: 'note',
    delivered: 0,
    ...overrides,
  };
}

/** A process reply as a fake runner sees it. Missing fields mean exit 0, empty output. */
export interface ProcessReply {
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly timedOut?: boolean;
  readonly truncated?: boolean;
}

/** Builds the result a real runner would report: `ok` depends on the caller's ok codes. */
export function replyResult(reply: ProcessReply, okCodes: readonly number[]): ProcessResult {
  const code = reply.code ?? 0;
  const timedOut = reply.timedOut ?? false;
  return {
    ok: !timedOut && okCodes.includes(code),
    code: timedOut ? null : code,
    stdout: reply.stdout ?? '',
    stderr: reply.stderr ?? '',
    timedOut,
    truncated: reply.truncated ?? false,
  };
}

export type GitScript = (cwd: string, args: readonly string[]) => ProcessReply;

export interface GitCall {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly options: GitRunOptions;
}

/** Git runner that records every call and answers from a script. */
export class FakeGitRunner implements GitRunner {
  readonly calls: GitCall[] = [];

  constructor(private readonly script: GitScript) {}

  run(cwd: string, args: readonly string[], options: GitRunOptions): Promise<ProcessResult> {
    this.calls.push({ cwd, args: [...args], options });
    return Promise.resolve(replyResult(this.script(cwd, args), options.okCodes));
  }
}

export const COMMIT_ISO = '2026-04-10T11:00:00+07:00';

/**
 * A healthy single-checkout repo: the repo root is the folder asked about, git
 * reports it clean and in sync, and no upstream is configured.
 */
export function defaultGitScript(cwd: string, args: readonly string[]): ProcessReply {
  const key = args.join(' ');
  if (key === 'rev-parse --show-prefix') return { stdout: '\n' };
  if (key === 'worktree list --porcelain') {
    return { stdout: `worktree ${cwd}\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/main\n` };
  }
  if (args[0] === 'status' || args[0] === 'diff') return { stdout: '' };
  if (args[0] === 'rev-list') return { stdout: '0\t0\n' };
  if (args[0] === 'merge-base') return { code: 0 };
  if (args[0] === 'log') return { stdout: `Initial\u0000${COMMIT_ISO}\n` };
  // `@{u}` with no upstream exits 128, a valid "no upstream" answer.
  if (args[0] === 'rev-parse') return { code: 128 };
  return { code: 1 };
}

export interface ScriptCall {
  readonly argv: readonly string[];
  readonly options: ProcessOptions;
}

export interface FakeScript {
  readonly run: ScriptRunner;
  readonly calls: ScriptCall[];
}

/** Script runner (overlap.py or who.py) that records argv and options. */
export function fakeScript(
  reply: ProcessReply | ((argv: readonly string[]) => ProcessReply),
): FakeScript {
  const calls: ScriptCall[] = [];
  const run: ScriptRunner = (argv, options) => {
    calls.push({ argv: [...argv], options });
    return Promise.resolve(
      replyResult(typeof reply === 'function' ? reply(argv) : reply, options.okCodes),
    );
  };
  return { run, calls };
}

/** In-memory activity database. `data` is public so a test can add rows between polls. */
export interface FakeSourceData {
  status?: LedgerDatabaseStatus;
  sessions?: SessionRow[];
  events?: EventRow[];
  pending?: PendingRow[];
  notices?: NoticeRow[];
  mainWrites?: EventRow[];
}

export class FakeLedgerSource implements LedgerSource {
  closed = false;

  constructor(readonly data: FakeSourceData = {}) {}

  status(): LedgerDatabaseStatus {
    return this.data.status ?? { state: 'ok' };
  }

  sessionRows(): SessionRow[] {
    return [...(this.data.sessions ?? [])];
  }

  eventRows(sinceTs: string): EventRow[] {
    return (this.data.events ?? []).filter((row) => row.ts >= sinceTs);
  }

  pendingRows(): PendingRow[] {
    return [...(this.data.pending ?? [])];
  }

  noticeRows(): NoticeRow[] {
    return [...(this.data.notices ?? [])];
  }

  mainWriteRows(sinceTs: string): EventRow[] {
    return (this.data.mainWrites ?? []).filter((row) => row.ts >= sinceTs);
  }
  fileHistory(pathKey: string, sinceTs: string): LedgerFileTouch[] {
    return (this.data.events ?? [])
      .filter((row) => row.pathKey === pathKey && row.ts >= sinceTs)
      .sort((a, b) => b.ts.localeCompare(a.ts) || b.id - a.id)
      .slice(0, 200)
      .map((row) => {
        const session = this.data.sessions?.find((entry) => entry.sessionId === row.sessionId);
        return {
          ts: row.ts,
          sessionId: row.sessionId,
          agentKind: session?.agentKind ?? null,
          agentName: session?.agentName ?? null,
          branch: row.branch,
          checkout: row.checkout,
          tool: row.tool,
          intent: row.intent,
        };
      });
  }

  close(): void {
    this.closed = true;
  }
}

/** Interval scheduler that never waits: the test calls `fire()` to run one poll. */
export class FakeScheduler implements LedgerScheduler {
  readonly live = new Map<
    LedgerTimerHandle,
    { readonly callback: () => void; readonly ms: number }
  >();

  setInterval(callback: () => void, ms: number): LedgerTimerHandle {
    const handle = {} as LedgerTimerHandle;
    this.live.set(handle, { callback, ms });
    return handle;
  }

  clearInterval(handle: LedgerTimerHandle): void {
    this.live.delete(handle);
  }

  /** Runs every live interval callback once, as if the poll interval had elapsed. */
  fire(): void {
    for (const { callback } of [...this.live.values()]) callback();
  }
}

export const EMPTY_OVERLAP_JSON = JSON.stringify({
  complete: true,
  base: 'origin/main',
  lanes: 0,
  pairs: [],
  main: [],
  pending: [],
});

export interface ServiceHarness {
  readonly service: LedgerService;
  readonly source: FakeLedgerSource;
  readonly git: FakeGitRunner;
  readonly overlap: FakeScript;
  readonly who: FakeScript;
  readonly schedule: FakeScheduler;
  /** Moves the fake clock forward. */
  advance(ms: number): void;
}

export interface ServiceHarnessOptions {
  readonly data?: FakeSourceData;
  readonly git?: GitScript;
  readonly extraRepoPaths?: () => readonly string[];
}

/** A `LedgerService` wired entirely to fakes, with a clock the test controls. */
export function makeService(options: ServiceHarnessOptions = {}): ServiceHarness {
  let nowMs = LEDGER_NOW_MS;
  const source = new FakeLedgerSource(options.data);
  const git = new FakeGitRunner(options.git ?? defaultGitScript);
  const overlap = fakeScript({ stdout: EMPTY_OVERLAP_JSON });
  const who = fakeScript({ stdout: 'Đã gửi tới …89abcdef\n' });
  const schedule = new FakeScheduler();
  const service = new LedgerService({
    source,
    git,
    overlap: overlap.run,
    who: who.run,
    now: () => nowMs,
    schedule,
    extraRepoPaths: options.extraRepoPaths,
  });
  return {
    service,
    source,
    git,
    overlap,
    who,
    schedule,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}
