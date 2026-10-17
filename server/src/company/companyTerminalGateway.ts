/**
 * companyTerminalGateway: terminal control bound to the runner's own PTY.
 *
 * A company session's terminal IS the OMP process. This gateway therefore never
 * spawns anything: it attaches to the PTY the runner already started under
 * `<sessionId>:<runEpoch>`, so attaching a viewer cannot become a second
 * process, and detaching a viewer leaves the run untouched. `TerminalSessions`
 * answers a different question — it owns its PTY and is the right thing for a
 * standalone terminal; conflating the two would give every viewer its own OMP.
 *
 * What it refuses:
 *  - an epoch that is not the live one, because a restart already replaced the
 *    process and an old lease must not be able to type into the new one;
 *  - a lease id that is not the current controller, so two viewers never see
 *    each other's keystrokes;
 *  - a framebuffer larger than the bounded page, which is truncated from the
 *    front so the most recent output always survives.
 */

import { randomUUID } from 'node:crypto';

import type { CompanyTerminalGateway, CompanyTerminalHandle } from './clientCommands.js';
import { CompanyError } from './companyError.js';
import {
  COMPANY_DEFAULT_TERMINAL_COLS,
  COMPANY_DEFAULT_TERMINAL_ROWS,
  COMPANY_TERMINAL_INPUT_MAX_BYTES,
} from './constants.js';
import type { PtyClient } from './ptyClient.js';

/** A reattached viewer replays at most this much of the framebuffer. */
const MAX_SNAPSHOT_BYTES = 64 * 1024;

/** The subset of the PTY client a viewer needs; the runner owns the rest. */
export type TerminalControlPort = Pick<PtyClient, 'write' | 'resize' | 'snapshot'>;

export interface RunnerTerminalGatewayOptions {
  readonly client: TerminalControlPort;
  /** True only while the runtime owns a live runner for this exact run. */
  readonly isLive: (sessionId: string, runEpoch: number) => boolean;
  /** Size the runner's PTY was started with. */
  readonly size: (sessionId: string, runEpoch: number) => { cols: number; rows: number };
}

interface ViewerLease {
  readonly leaseId: string;
  seq: number;
}

/** The PTY helper session id a run owns; the same key `OmpRunner` builds. */
export function runnerPtySessionId(sessionId: string, runEpoch: number): string {
  return `${sessionId}:${runEpoch}`;
}

/**
 * Trim a serialized framebuffer from the front, because the tail is the part a
 * returning viewer needs and the scrollback head is the part it does not.
 */
function boundFramebuffer(frame: string): { data: string; truncated: boolean } {
  const bytes = Buffer.from(frame, 'utf8');
  if (bytes.length <= MAX_SNAPSHOT_BYTES) return { data: frame, truncated: false };
  return {
    data: bytes.subarray(bytes.length - MAX_SNAPSHOT_BYTES).toString('utf8'),
    truncated: true,
  };
}

export class RunnerTerminalGateway implements CompanyTerminalGateway {
  private readonly leases = new Map<string, ViewerLease>();

  constructor(private readonly options: RunnerTerminalGatewayOptions) {}

  async attach(
    sessionId: string,
    runEpoch: number,
    cols?: number,
    rows?: number,
    onLeaseGranted?: (leaseId: string) => void,
  ): Promise<CompanyTerminalHandle> {
    this.assertLive(sessionId, runEpoch);
    const key = runnerPtySessionId(sessionId, runEpoch);
    const live = this.options.size(sessionId, runEpoch);
    const resolvedCols = cols ?? live.cols ?? COMPANY_DEFAULT_TERMINAL_COLS;
    const resolvedRows = rows ?? live.rows ?? COMPANY_DEFAULT_TERMINAL_ROWS;
    if (resolvedCols !== live.cols || resolvedRows !== live.rows) {
      // Resizing changes the shared PTY, so it happens before the new lease is
      // issued and is never applied twice by two racing viewers.
      await this.options.client.resize(key, resolvedCols, resolvedRows);
    }
    const lease: ViewerLease = { leaseId: randomUUID(), seq: this.leases.get(key)?.seq ?? 0 };
    this.leases.set(key, lease);
    onLeaseGranted?.(lease.leaseId);
    return { leaseId: lease.leaseId, cols: resolvedCols, rows: resolvedRows };
  }

  async write(sessionId: string, runEpoch: number, data: string, leaseId: string): Promise<void> {
    const key = runnerPtySessionId(sessionId, runEpoch);
    this.assertLive(sessionId, runEpoch);
    this.assertController(key, leaseId);
    if (Buffer.byteLength(data, 'utf8') > COMPANY_TERMINAL_INPUT_MAX_BYTES) {
      throw new CompanyError(
        'terminal_input_too_large',
        `A terminal input chunk may not exceed ${COMPANY_TERMINAL_INPUT_MAX_BYTES} bytes.`,
      );
    }
    // Only the caller's own keystrokes are forwarded: nothing is buffered and
    // replayed, so a reattaching viewer never re-sends input it did not type.
    await this.options.client.write(key, data);
  }

  async resize(
    sessionId: string,
    runEpoch: number,
    cols: number,
    rows: number,
    leaseId: string,
  ): Promise<void> {
    const key = runnerPtySessionId(sessionId, runEpoch);
    this.assertLive(sessionId, runEpoch);
    this.assertController(key, leaseId);
    await this.options.client.resize(key, cols, rows);
  }

  /**
   * Release the viewer. The runner keeps its process: a detached terminal is a
   * closed window, not a cancelled run.
   */
  async detach(sessionId: string, runEpoch: number, leaseId: string): Promise<void> {
    const key = runnerPtySessionId(sessionId, runEpoch);
    const lease = this.leases.get(key);
    if (!lease) {
      throw new CompanyError('terminal_not_attached', `No terminal is attached for ${sessionId}.`);
    }
    if (lease.leaseId !== leaseId) {
      throw new CompanyError(
        'invalid_terminal_lease',
        'Lease của bộ điều khiển terminal đã cũ hoặc không thuộc về kết nối này.',
      );
    }
    this.leases.delete(key);
  }

  /** Bounded framebuffer for a fresh attach or a reconnect. */
  async snapshot(
    sessionId: string,
    runEpoch: number,
  ): Promise<{ data: string; truncated: boolean }> {
    const key = runnerPtySessionId(sessionId, runEpoch);
    this.assertLive(sessionId, runEpoch);
    return boundFramebuffer(await this.options.client.snapshot(key));
  }

  /** Next output sequence for a run, so a client's frames stay ordered. */
  nextSeq(sessionId: string, runEpoch: number): number {
    const key = runnerPtySessionId(sessionId, runEpoch);
    const lease = this.leases.get(key);
    const next = (lease?.seq ?? 0) + 1;
    if (lease) lease.seq = next;
    return next;
  }

  /** True when at least one viewer currently holds this run's terminal. */
  hasViewer(sessionId: string, runEpoch: number): boolean {
    return this.leases.has(runnerPtySessionId(sessionId, runEpoch));
  }

  /** Forget every viewer; used when a run ends. Never signals the process. */
  forgetRun(sessionId: string, runEpoch: number): void {
    this.leases.delete(runnerPtySessionId(sessionId, runEpoch));
  }

  private assertLive(sessionId: string, runEpoch: number): void {
    if (this.options.isLive(sessionId, runEpoch)) return;
    throw new CompanyError(
      'terminal_session_not_live',
      `Session ${sessionId} has no live run at epoch ${runEpoch}; its terminal is not available.`,
    );
  }

  private assertController(key: string, leaseId: string): void {
    const lease = this.leases.get(key);
    if (!lease || lease.leaseId !== leaseId) {
      throw new CompanyError(
        'invalid_terminal_lease',
        'Lease của bộ điều khiển terminal đã cũ hoặc không thuộc về kết nối này.',
      );
    }
  }
}
