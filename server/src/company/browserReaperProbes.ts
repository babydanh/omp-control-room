/**
 * browserReaperProbes: the real boundaries of the browser reaper. Everything that
 * touches this machine lives here: the OMP command, the loopback DevTools fetch and
 * the process-tree memory read. Each is read-only, except the OMP runner, which the
 * reaper uses for `omp ps` and `omp ps stop` only.
 */

import { once } from 'node:events';
import * as http from 'node:http';
import { text } from 'node:stream/consumers';

import type { BrowserReaperStatusMessage } from '../../../core/src/messages.js';
import {
  BROWSER_REAPER_MEMORY_TIMEOUT_MS,
  BROWSER_REAPER_OMP_TIMEOUT_MS,
  BROWSER_REAPER_PROBE_TIMEOUT_MS,
} from '../constants.js';
import { type BrowserReaperDeps, isRecord } from './browserReaper.js';
import type { OmpRunnerCommand } from './ompRunner.js';
import { defaultQuotaRunner, type QuotaRunner, type QuotaRunnerRequest } from './quotaService.js';

const LOOPBACK_HOST = '127.0.0.1';
const PS_LINE_PATTERN = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/;
const BYTES_PER_KIB = 1024;

/** One process as the memory read sees it. */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly workingSetBytes: number;
}

/** Parses `Get-CimInstance Win32_Process | ConvertTo-Json`: one object, or an array of them. */
export function parseWindowsProcessRows(stdout: string): ProcessRow[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  } catch {
    return [];
  }
  const items: unknown[] = Array.isArray(payload) ? payload : [payload];
  const rows: ProcessRow[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const pid = item['ProcessId'];
    const ppid = item['ParentProcessId'];
    const workingSet = item['WorkingSetSize'];
    if (typeof pid !== 'number' || typeof ppid !== 'number' || typeof workingSet !== 'number') {
      continue;
    }
    rows.push({ pid, ppid, workingSetBytes: workingSet });
  }
  return rows;
}

/** Parses `ps -A -o pid= -o ppid= -o rss=`: three columns, with RSS in KiB. */
export function parsePsProcessRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = PS_LINE_PATTERN.exec(line);
    if (match === null) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      workingSetBytes: Number(match[3]) * BYTES_PER_KIB,
    });
  }
  return rows;
}

/** Summed working-set bytes of `rootPid` and every process below it. 0 when the root is not listed. */
export function treeWorkingSetBytes(rows: readonly ProcessRow[], rootPid: number): number {
  const root = rows.find((row) => row.pid === rootPid);
  if (root === undefined) return 0;
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid);
    if (siblings === undefined) children.set(row.ppid, [row]);
    else siblings.push(row);
  }
  const seen = new Set<number>();
  const stack: ProcessRow[] = [root];
  let total = 0;
  while (stack.length > 0) {
    const row = stack.pop();
    if (row === undefined || seen.has(row.pid)) continue;
    seen.add(row.pid);
    total += row.workingSetBytes;
    stack.push(...(children.get(row.pid) ?? []));
  }
  return total;
}

/**
 * Working-set bytes of a process tree, read-only: one process listing, then the
 * tree sum. Returns 0 when the listing is unavailable, so a failed read only
 * under-reports the RAM a reap frees.
 */
export async function readProcessTreeMemoryBytes(
  pid: number,
  runner: QuotaRunner,
  cwd: string,
  platform: NodeJS.Platform,
): Promise<number> {
  const request: QuotaRunnerRequest =
    platform === 'win32'
      ? {
          executable: 'powershell.exe',
          argv: [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress',
          ],
          cwd,
          timeoutMs: BROWSER_REAPER_MEMORY_TIMEOUT_MS,
        }
      : {
          executable: 'ps',
          argv: ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'rss='],
          cwd,
          timeoutMs: BROWSER_REAPER_MEMORY_TIMEOUT_MS,
        };
  try {
    const outcome = await runner(request);
    if (outcome.exitCode !== 0 || outcome.timedOut) return 0;
    const rows =
      platform === 'win32'
        ? parseWindowsProcessRows(outcome.stdout)
        : parsePsProcessRows(outcome.stdout);
    return treeWorkingSetBytes(rows, pid);
  } catch {
    return 0;
  }
}

/**
 * GET of a loopback DevTools endpoint, parsed as JSON. Refuses any host but
 * 127.0.0.1 and rejects on a non-2xx status, a body that is not JSON, a socket
 * error, or the deadline.
 */
export async function fetchLoopbackJson(url: string, timeoutMs: number): Promise<unknown> {
  const target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== LOOPBACK_HOST) {
    throw new Error(`refusing a non-loopback probe to ${target.hostname}`);
  }
  const request = http.get(target, { timeout: timeoutMs });
  request.on('timeout', () => {
    request.destroy(new Error('DevTools probe timed out'));
  });
  // After the response, `text` reports a failed body. This listener only keeps a
  // late socket error from surfacing as an unhandled 'error' once `once` has let go.
  request.on('error', () => undefined);
  // `once` rejects on an 'error' that arrives before the response: a refused
  // connection, or the deadline above.
  const [response] = (await once(request, 'response')) as [http.IncomingMessage];
  const status = response.statusCode ?? 0;
  // A stalled or aborted body rejects here as a premature close.
  const body = await text(response);
  if (status < 200 || status >= 300) throw new Error(`DevTools answered HTTP ${status}`);
  return JSON.parse(body) as unknown;
}

export interface BrowserReaperHostOptions {
  /** The resolved OMP command, read on every check. Throws when OMP is not installed. */
  readonly resolveCommand: () => OmpRunnerCommand;
  /** The workspace directory: the working directory for OMP and the process listing. */
  readonly cwd: string;
  readonly publish: (message: BrowserReaperStatusMessage) => void;
  readonly log: (message: string) => void;
  readonly warn: (message: string) => void;
}

/** The reaper's real boundaries on this machine. */
export function createBrowserReaperHostDeps(options: BrowserReaperHostOptions): BrowserReaperDeps {
  return {
    resolveCommand: options.resolveCommand,
    runOmp: (command, argv, cwd) =>
      defaultQuotaRunner({
        executable: command.file,
        argv: [...command.args, ...argv],
        cwd: cwd ?? options.cwd,
        timeoutMs: BROWSER_REAPER_OMP_TIMEOUT_MS,
      }),
    fetchJson: (url) => fetchLoopbackJson(url, BROWSER_REAPER_PROBE_TIMEOUT_MS),
    treeMemoryBytes: (pid) =>
      readProcessTreeMemoryBytes(pid, defaultQuotaRunner, options.cwd, process.platform),
    now: () => Date.now(),
    schedule: (run, everyMs) => {
      const timer = setInterval(run, everyMs);
      return () => clearInterval(timer);
    },
    publish: options.publish,
    log: options.log,
    warn: options.warn,
  };
}
