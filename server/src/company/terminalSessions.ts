/**
 * terminalSessions: company session ids to PTYs.
 *
 * One PTY per (company session, run epoch). A restart bumps the epoch, so the
 * old PTY is killed and a stale epoch can never write into the new one -- that
 * is what makes "restart while a question is pending" safe.
 *
 * Re-attaching (a second viewer, or the same viewer after a reconnect) never
 * spawns a second PTY: it issues a new lease and replays a serialized
 * framebuffer, so the terminal the user sees continues where the process is.
 */

import { randomUUID } from 'node:crypto';

import type { CompanyTerminalGateway, CompanyTerminalHandle } from './clientCommands.js';
import { CompanyError } from './companyError.js';
import { COMPANY_DEFAULT_TERMINAL_COLS, COMPANY_DEFAULT_TERMINAL_ROWS } from './constants.js';
import type { PtyClient } from './ptyClient.js';
import type { PtySpawnSpec } from './ptyHost.js';

export interface TerminalOutputEvent {
  sessionId: string;
  runEpoch: number;
  seq: number;
  data: string;
}

export interface TerminalClosedEvent {
  sessionId: string;
  runEpoch: number;
  seq: number;
  reason: string;
}

export interface TerminalSessionsOptions {
  client: PtyClient;
  /** What to actually launch for a company session. Supplied by the coordinator. */
  resolveSpawnSpec(sessionId: string, runEpoch: number): Promise<PtySpawnSpec>;
  onOutput?(event: TerminalOutputEvent): void;
  onClosed?(event: TerminalClosedEvent): void;
}

interface TerminalBinding {
  sessionId: string;
  runEpoch: number;
  ptySessionId: string;
  leaseId: string;
  seq: number;
  cols: number;
  rows: number;
}

function bindingKey(sessionId: string, runEpoch: number): string {
  return `${sessionId}@${runEpoch}`;
}

export class TerminalSessions implements CompanyTerminalGateway {
  private readonly bindings = new Map<string, TerminalBinding>();
  private readonly detachClient: () => void;

  constructor(private readonly options: TerminalSessionsOptions) {
    this.detachClient = options.client.onEvent((event) => this.handleHostEvent(event));
  }

  async attach(
    sessionId: string,
    runEpoch: number,
    cols?: number,
    rows?: number,
    onLeaseGranted?: (leaseId: string) => void,
  ): Promise<CompanyTerminalHandle> {
    const key = bindingKey(sessionId, runEpoch);
    const existing = this.bindings.get(key);
    if (existing) {
      // Re-attach: same PTY, new controller lease, current framebuffer.
      existing.leaseId = randomUUID();
      existing.cols = cols ?? existing.cols;
      existing.rows = rows ?? existing.rows;
      onLeaseGranted?.(existing.leaseId);
      return { leaseId: existing.leaseId, cols: existing.cols, rows: existing.rows };
    }

    const spec = await this.options.resolveSpawnSpec(sessionId, runEpoch);
    const ptySessionId = randomUUID();
    await this.options.client.spawnPty(ptySessionId, spec);
    const binding: TerminalBinding = {
      sessionId,
      runEpoch,
      ptySessionId,
      leaseId: randomUUID(),
      seq: 0,
      cols: cols ?? spec.cols ?? COMPANY_DEFAULT_TERMINAL_COLS,
      rows: rows ?? spec.rows ?? COMPANY_DEFAULT_TERMINAL_ROWS,
    };
    this.bindings.set(key, binding);
    onLeaseGranted?.(binding.leaseId);
    return { leaseId: binding.leaseId, cols: binding.cols, rows: binding.rows };
  }

  async write(sessionId: string, runEpoch: number, data: string, leaseId: string): Promise<void> {
    const binding = this.require(sessionId, runEpoch);
    this.assertController(binding, leaseId);
    await this.options.client.write(binding.ptySessionId, data);
  }
  async resize(
    sessionId: string,
    runEpoch: number,
    cols: number,
    rows: number,
    leaseId: string,
  ): Promise<void> {
    const binding = this.require(sessionId, runEpoch);
    this.assertController(binding, leaseId);
    await this.options.client.resize(binding.ptySessionId, cols, rows);
    binding.cols = cols;
    binding.rows = rows;
  }

  async detach(sessionId: string, runEpoch: number, leaseId: string): Promise<void> {
    const key = bindingKey(sessionId, runEpoch);
    const binding = this.require(sessionId, runEpoch);
    this.assertController(binding, leaseId);
    this.bindings.delete(key);
    await this.options.client.kill(binding.ptySessionId);
  }

  /** Serialized framebuffer for a session, for a fresh attach or a reconnect. */
  async snapshot(sessionId: string, runEpoch: number): Promise<string> {
    const binding = this.require(sessionId, runEpoch);
    return this.options.client.snapshot(binding.ptySessionId);
  }

  async dispose(): Promise<void> {
    this.detachClient();
    for (const key of [...this.bindings.keys()]) {
      const binding = this.bindings.get(key);
      this.bindings.delete(key);
      if (binding) await this.options.client.kill(binding.ptySessionId);
    }
  }

  get liveCount(): number {
    return this.bindings.size;
  }

  private handleHostEvent(event: { type: string } & Record<string, unknown>): void {
    const binding = this.findByPtySession(String(event.sessionId ?? ''));
    if (!binding) return;
    if (event.type === 'data') {
      binding.seq += 1;
      this.options.onOutput?.({
        sessionId: binding.sessionId,
        runEpoch: binding.runEpoch,
        seq: binding.seq,
        data: String(event.data ?? ''),
      });
      return;
    }
    if (event.type === 'exit') {
      this.bindings.delete(bindingKey(binding.sessionId, binding.runEpoch));
      binding.seq += 1;
      this.options.onClosed?.({
        sessionId: binding.sessionId,
        runEpoch: binding.runEpoch,
        seq: binding.seq,
        reason: `process exited with code ${String(event.exitCode)}`,
      });
    }
  }

  private require(sessionId: string, runEpoch: number): TerminalBinding {
    const binding = this.bindings.get(bindingKey(sessionId, runEpoch));
    if (binding) return binding;
    // A mismatched epoch is a real condition (a restart happened), not a typo.
    const sameSession = [...this.bindings.values()].find(
      (candidate) => candidate.sessionId === sessionId,
    );
    throw new CompanyError(
      'stale_terminal_epoch',
      sameSession
        ? `Session ${sessionId} is at epoch ${sameSession.runEpoch}, not ${runEpoch}.`
        : `No terminal attached for session ${sessionId}.`,
    );
  }
  private assertController(binding: TerminalBinding, leaseId: string): void {
    if (leaseId !== binding.leaseId) {
      throw new CompanyError(
        'invalid_terminal_lease',
        'Lease của bộ điều khiển terminal đã cũ hoặc không thuộc về kết nối này.',
      );
    }
  }

  private findByPtySession(ptySessionId: string): TerminalBinding | undefined {
    if (!ptySessionId) return undefined;
    return [...this.bindings.values()].find((binding) => binding.ptySessionId === ptySessionId);
  }
}
