/**
 * companyFollowerProxy: the follower half of a workspace company host.
 *
 * `CompanyOwnership` gives exactly one process the owner role for a canonical
 * workspace. Every other surface on that workspace is a follower: it may read
 * the company's projection and forward a privileged client's commands, and it
 * may do nothing else. This module is that "nothing else" made concrete.
 *
 * Three rules shape everything here:
 *
 *  - **No second executor.** A follower never constructs a coordinator, a
 *    runtime, a runner or a PTY. Its `CompanyCoordinator` and its
 *    `CompanyTerminalGateway` are proxies: every mutation is a correlated
 *    broker request to the owner, which performs it exactly once.
 *  - **No replay after an uncertain outcome.** `sendCompanyBrokerRequest`
 *    connects once, sends once and waits. A timeout, a dropped connection or a
 *    refusal is reported to the caller as an error and NEVER re-sent: the owner
 *    may already have applied the side effect, and a duplicated company
 *    mutation is worse than an honest failure. Reads (the snapshot poll) are
 *    idempotent and may repeat.
 *  - **No capability beyond the channel.** Every request carries an explicit
 *    privilege proof naming the client that issued it; the owner's dispatcher
 *    re-validates that client against its own authority before acting. The
 *    broker nonce proves which process is speaking, never which client may
 *    mutate, so it is not treated as authority here.
 *
 * Reads are served from a bounded poll of the owner's snapshot projection. The
 * follower never calls `CompanyStore.load()`, which repairs a torn journal and
 * therefore writes: the owner is the only writer, and a follower that truncated
 * the journal would race the commit in flight.
 */

import { randomUUID } from 'node:crypto';

import type {
  AgentInfo,
  CompanyDiagnostics,
  CompanyModelCatalogEntry,
  CompanyPrompt,
  CompanyRole,
  CompanySnapshot,
  QuestionAnswerInput,
  RoleProfile,
  SubmitPromptInput,
} from '../../../core/src/company.js';
import type { OmpSessionEntry, ServerMessage } from '../../../core/src/messages.js';
import type { CompanyTerminalGateway, CompanyTerminalHandle } from './clientCommands.js';
import {
  COMPANY_BROKER_MAX_FRAME_BYTES,
  type CompanyBrokerRequest,
  sendCompanyBrokerRequest,
} from './companyBroker.js';
import {
  COMPANY_SESSION_ACTIONS,
  type CompanyCoordinator,
  type CompanySessionAction,
  CONTRACT_DECISIONS,
  type ContractDecision,
  type OmpSessionListing,
  type ReviewerResultOutput,
  type VerificationOutcome,
  type WorkerTaskResultOutput,
} from './companyCoordinator.js';
import { CompanyError } from './companyError.js';

// ── Wire vocabulary ─────────────────────────────────────────────
//
// Shared by both halves: the follower sends these names, and the owner's
// dispatcher validates every request against exactly this set. A command that
// is not in this object does not exist on the channel.

export const COMPANY_HOST_COMMANDS = {
  snapshot: 'company.snapshot',
  modelCatalog: 'company.modelCatalog',
  submitPrompt: 'company.prompt.submit',
  decideContract: 'company.contract.decide',
  answerQuestion: 'company.question.answer',
  controlSession: 'company.session.control',
  parkSquadSession: 'company.session.parkSquad',
  renameSession: 'company.session.rename',
  promptCancel: 'company.prompt.cancel',
  ompSessions: 'company.omp.sessions',
  resumeOmpSession: 'company.session.resume',
  openNewChat: 'company.chat.new',
  sessionInfo: 'company.session.info',
  updateSettings: 'company.settings.update',
  terminalAttach: 'terminal.attach',
  terminalWrite: 'terminal.write',
  terminalResize: 'terminal.resize',
  terminalDetach: 'terminal.detach',
  subscribe: 'company.events.subscribe',
  drain: 'company.events.drain',
  unsubscribe: 'company.events.unsubscribe',
} as const;

export type CompanyHostCommand = (typeof COMPANY_HOST_COMMANDS)[keyof typeof COMPANY_HOST_COMMANDS];

/** Bounds on the owner's per-lease drain buffer and one drain response. */
export const COMPANY_HOST_MAX_PENDING_MESSAGES = 256;
export const COMPANY_HOST_MAX_PENDING_BYTES = Math.floor(COMPANY_BROKER_MAX_FRAME_BYTES / 2);
export const COMPANY_HOST_MAX_MESSAGE_BYTES = Math.floor(COMPANY_BROKER_MAX_FRAME_BYTES / 8);
export const COMPANY_HOST_DRAIN_LIMIT = 32;

/**
 * Bounded follower poll cadence. The projection poll is a durable read, so it
 * may repeat; the drain poll is the follower half of a one-way event stream,
 * because the broker transport is request-response only.
 */
export const COMPANY_FOLLOWER_POLL_INTERVAL_MS = 1_000;
export const COMPANY_FOLLOWER_EVENT_POLL_INTERVAL_MS = 250;

// ── Error text ──────────────────────────────────────────────────

const ERROR_TEXT = {
  command_invalid: 'Lệnh công ty được chuyển tiếp mang nội dung không dùng được.',
  command_unknown: 'Môi giới công ty không phục vụ lệnh đó.',
  drain_lease_unknown: 'Lease của thuê bao đó không còn được đăng ký.',
  drain_limit_invalid: 'Giới hạn rút dữ liệu nằm ngoài phạm vi cho phép.',
  execution_forbidden: 'Không được phép thực thi công ty ở trạng thái client đó.',
  model_catalog_unavailable: 'Danh mục mô hình của công ty không khả dụng.',
  owner_descriptor_unreadable: 'Bản thể này không đọc được chủ sở hữu mà nó vừa trở thành.',
  owner_protocol_error: 'Chủ sở hữu công ty trả lời bằng kết quả không dùng được.',
  owner_unavailable: 'Chủ sở hữu công ty cho workspace này không khả dụng.',
  privileged_required: 'Client công ty đó không được phép chạy lệnh công ty.',
  role_forbidden: 'Chỉ chủ sở hữu công ty nắm quyền chạy native.',
  role_invalid: 'Vai trò công ty đó không có trong công ty này.',
  reply_too_large: 'Sự kiện công ty đó vượt quá giới hạn khung môi giới.',
  subscriber_limit: 'Chủ sở hữu công ty không còn lease thuê bao trống nào.',
  terminal_lease_denied: 'Lease terminal đó không thuộc về thuê bao này.',
  terminal_unavailable: 'Chưa cài đặt khả năng terminal gốc.',
} as const satisfies Record<string, string>;

function hostError(key: keyof typeof ERROR_TEXT, cause?: unknown): CompanyError {
  return new CompanyError(`company_${key}`, ERROR_TEXT[key], { cause });
}

/** Every command this channel serves; anything else is refused by name. */
export const COMPANY_HOST_COMMAND_NAMES: Readonly<Record<string, true>> = Object.fromEntries(
  Object.values(COMPANY_HOST_COMMANDS).map((name) => [name, true]),
);

/** Terminal traffic is viewer-scoped; everything else is board-wide. */
export const COMPANY_HOST_TERMINAL_MESSAGE_TYPES: Readonly<Record<string, true>> = {
  terminalSnapshot: true,
  terminalData: true,
  terminalClosed: true,
};

/** A JSON object frame; anything else is refused before it is read. */
function isFrameObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty, length-bounded string; the only shape accepted for an id. */
export function readBoundedString(
  body: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw hostError('command_invalid');
  }
  return value;
}

export function readOptionalBoundedString(
  body: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  if (body[key] === undefined) return undefined;
  return readBoundedString(body, key, maxLength);
}

/** A safe, non-negative integer; rejects NaN, Infinity and fractions. */
export function readInteger(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw hostError('command_invalid');
  }
  return value;
}

export function readObject(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  if (!isFrameObject(value)) throw hostError('command_invalid');
  return value;
}

export interface CompanyHostPrincipal {
  /** Client identity the follower claims to be acting for. */
  readonly clientId: string;
}

/**
 * Extract the privilege proof every request must carry.
 *
 * The flag is checked before the body is even looked at, so a request without
 * it cannot reach a mutation handler, and the client id is what the owner
 * re-checks against its own authority: a peer that knows the broker nonce still
 * has to name a client the owner recognizes.
 */
export function readPrincipal(params: unknown): CompanyHostPrincipal {
  if (!isFrameObject(params)) throw hostError('privileged_required');
  if (params['privileged'] !== true) throw hostError('privileged_required');
  const clientId = params['clientId'];
  if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 128) {
    throw hostError('privileged_required');
  }
  return { clientId };
}

/**
 * The second proof, required by every command that changes state or takes a
 * control lease.
 *
 * Privilege says the client may command the company at all; execution consent
 * says the client is in a state where the company is allowed to run — a
 * trusted workspace, a closing server, a muted control. The owner cannot see
 * either, so the follower states both explicitly and the owner refuses the
 * request when the second one is absent. Reads carry it too and ignore it.
 */
export function readExecutionConsent(params: Record<string, unknown>): void {
  if (params['executionAllowed'] !== true) throw hostError('execution_forbidden');
}

/** Commands that change company state or hand out a control lease. */
export const COMPANY_HOST_MUTATING_COMMANDS: Readonly<Record<string, true>> = {
  'company.prompt.submit': true,
  'company.prompt.cancel': true,
  'company.contract.decide': true,
  'company.question.answer': true,
  'company.session.control': true,
  'company.session.rename': true,
  'company.session.resume': true,
  'company.chat.new': true,
  'company.settings.update': true,
  'terminal.attach': true,
  'terminal.write': true,
  'terminal.resize': true,
  'terminal.detach': true,
};

/** The privilege proof plus the command body, as it travels on the wire. */
function commandParams(
  clientId: string,
  body: Record<string, unknown> = {},
): Record<string, unknown> {
  return { privileged: true, executionAllowed: true, clientId, ...body };
}

// ── Follower channel ────────────────────────────────────────────

export interface CompanyFollowerChannelOptions {
  readonly endpoint: string;
  readonly nonce: string;
  /** The UI client this surface's proxied calls are made for. */
  readonly clientId: string;
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly eventPollIntervalMs?: number;
}

/** One drain response, as the owner reports it. */
export interface FollowerDrainResult {
  readonly messages: ServerMessage[];
  readonly dropped: number;
  readonly pending: boolean;
}

const EMPTY_DIAGNOSTICS: CompanyDiagnostics = {
  liveRunners: 0,
  modelLeases: 0,
  nativeJobs: 0,
  queuedTasks: 0,
  pendingQuestions: 0,
  retainedSessions: 0,
  archivedSessions: 0,
  terminalBufferedBytes: 0,
  ownedHandleCount: 0,
  measuredAt: '1970-01-01T00:00:00.000Z',
};

/** True while a value can carry a durable revision. */
function isSnapshot(value: unknown): value is CompanySnapshot {
  return isFrameObject(value) && typeof value['revision'] === 'number';
}

export class CompanyFollowerProxy {
  /** Proxied coordinator: mutations proxy, reads serve the last poll. */
  readonly coordinator: CompanyCoordinator;
  /** Proxied terminal: attaches and input run on the owner's PTY. */
  readonly terminal: CompanyTerminalGateway;

  /** Durable revision of the owner's last polled projection. */
  private snapshotValue: CompanySnapshot | null = null;
  private diagnosticsValue: CompanyDiagnostics | null = null;
  private diagnosticsRequested = false;
  private readonly subscriberLease: string;
  private readonly sessions = new Map<string, string>();
  private endpoint: string;
  private nonce: string;
  private readonly clientId: string;
  private readonly connectTimeoutMs: number | undefined;
  private readonly requestTimeoutMs: number | undefined;
  private readonly pollIntervalMs: number;
  private readonly eventPollIntervalMs: number;
  private sink: ((messages: ServerMessage[]) => void) | null = null;
  private disposed = false;
  private snapshotTimer: NodeJS.Timeout | undefined;
  private drainTimer: NodeJS.Timeout | undefined;
  private draining = false;
  private snapshotting = false;

  constructor(options: CompanyFollowerChannelOptions) {
    this.endpoint = options.endpoint;
    this.nonce = options.nonce;
    this.clientId = options.clientId;
    this.connectTimeoutMs = options.connectTimeoutMs;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.pollIntervalMs = options.pollIntervalMs ?? COMPANY_FOLLOWER_POLL_INTERVAL_MS;
    this.eventPollIntervalMs =
      options.eventPollIntervalMs ?? COMPANY_FOLLOWER_EVENT_POLL_INTERVAL_MS;
    this.subscriberLease = randomUUID();
    this.coordinator = this.createCoordinator();
    this.terminal = {
      attach: (sessionId, runEpoch, cols, rows, onLeaseGranted) =>
        this.attachTerminal(sessionId, runEpoch, cols, rows, onLeaseGranted),
      write: (sessionId, runEpoch, data, leaseId) =>
        this.writeTerminal(sessionId, runEpoch, data, leaseId),
      resize: (sessionId, runEpoch, cols, rows, leaseId) =>
        this.resizeTerminal(sessionId, runEpoch, cols, rows, leaseId),
      detach: (sessionId, runEpoch, leaseId) => this.detachTerminal(sessionId, runEpoch, leaseId),
    };
  }

  /** The owner's model catalog; resolves availability, never credentials. */
  async modelCatalog(): Promise<CompanyModelCatalogEntry[]> {
    const value = await this.send(COMPANY_HOST_COMMANDS.modelCatalog);
    if (!Array.isArray(value)) throw hostError('owner_protocol_error');
    return value as CompanyModelCatalogEntry[];
  }

  /** One managed session's description, as the owner's live run or its record reports it. */
  async sessionInfo(sessionId: string): Promise<AgentInfo> {
    const value = await this.send(COMPANY_HOST_COMMANDS.sessionInfo, { id: sessionId });
    if (!isFrameObject(value) || typeof value['collectedAt'] !== 'string') {
      throw hostError('owner_protocol_error');
    }
    // The owner builds this from its own typed description; only the envelope is checked here.
    return value as unknown as AgentInfo;
  }

  /**
   * Join the owner's board: subscribe to its event stream, read one snapshot to
   * prove the owner is answering, then start both bounded polls.
   *
   * A failure here is reported to the caller, which closes the host. A follower
   * that cannot reach an owner never becomes a second writer to "make progress".
   */
  async start(sink: (messages: ServerMessage[]) => void): Promise<void> {
    if (this.disposed) throw hostError('owner_unavailable');
    this.sink = sink;
    await this.send(COMPANY_HOST_COMMANDS.subscribe, { leaseId: this.subscriberLease });
    await this.refreshSnapshot();
    this.scheduleSnapshot();
    this.scheduleDrain();
  }

  /** Stop polling, drop this viewer's terminal claims, leave the owner's work. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimers();
    this.sink = null;
    const owned = [...this.sessions.entries()];
    this.sessions.clear();
    for (const [key, leaseId] of owned) {
      const [sessionId, epoch] = key.split(':', 2);
      const runEpoch = Number(epoch);
      // Best effort, and never re-sent: an owner that already exited needs no
      // revocation, and a revoke that fails must not delay this process's exit.
      await this.send(COMPANY_HOST_COMMANDS.terminalDetach, {
        sessionId,
        runEpoch,
        leaseId,
        releasing: true,
      }).catch(() => undefined);
    }
    await this.send(COMPANY_HOST_COMMANDS.unsubscribe, { leaseId: this.subscriberLease }).catch(
      () => undefined,
    );
  }

  // ── Polls ───────────────────────────────────────────────────

  private clearTimers(): void {
    clearTimeout(this.snapshotTimer);
    clearTimeout(this.drainTimer);
    this.snapshotTimer = undefined;
    this.drainTimer = undefined;
  }

  private scheduleSnapshot(): void {
    if (this.disposed) return;
    this.snapshotTimer = setTimeout(() => {
      void this.pollSnapshot();
    }, this.pollIntervalMs);
    this.snapshotTimer.unref?.();
  }

  private scheduleDrain(): void {
    if (this.disposed) return;
    this.drainTimer = setTimeout(() => {
      void this.pollDrain();
    }, this.eventPollIntervalMs);
    this.drainTimer.unref?.();
  }

  /** One read of the owner's projection. Repeats are harmless, so it may. */
  private async pollSnapshot(): Promise<void> {
    if (this.disposed || this.snapshotting) return;
    this.snapshotting = true;
    try {
      await this.refreshSnapshot();
    } catch {
      // The owner is unreachable or mid-restart. The last projection stays on
      // screen and the next tick tries again: this is a read, and repeating a
      // read cannot duplicate a company effect.
    } finally {
      this.snapshotting = false;
      this.scheduleSnapshot();
    }
  }

  private async pollDrain(): Promise<void> {
    if (this.disposed || this.draining) return;
    this.draining = true;
    try {
      const value = await this.send(COMPANY_HOST_COMMANDS.drain, {
        leaseId: this.subscriberLease,
        limit: COMPANY_HOST_DRAIN_LIMIT,
      });
      if (isFrameObject(value)) {
        const messages = Array.isArray(value['messages'])
          ? (value['messages'] as ServerMessage[])
          : [];
        const sink = this.sink;
        if (sink && messages.length > 0) sink(messages);
        if (value['pending'] === true) this.scheduleDrain();
      }
    } catch {
      // Same as the snapshot poll: the stream resumes when the owner answers.
    } finally {
      this.draining = false;
      this.scheduleDrain();
    }
  }

  private async refreshSnapshot(): Promise<void> {
    const value = await this.send(
      COMPANY_HOST_COMMANDS.snapshot,
      this.diagnosticsRequested ? { includeDiagnostics: true } : {},
    );
    if (!isFrameObject(value) || !isSnapshot(value['snapshot'])) {
      throw hostError('owner_protocol_error');
    }
    this.snapshotValue = value['snapshot'];
    const diagnostics = value['diagnostics'];
    if (isFrameObject(diagnostics)) {
      this.diagnosticsValue = diagnostics as unknown as CompanyDiagnostics;
    }
    this.diagnosticsRequested = false;
  }

  // ── Transport ───────────────────────────────────────────────

  /**
   * One correlated request. Never retried: an uncertain outcome is returned to
   * the caller as an error, because the owner may have applied it.
   */
  private async send(
    command: CompanyHostCommand,
    body: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (this.disposed) throw hostError('owner_unavailable');
    try {
      const result = await sendCompanyBrokerRequest({
        endpoint: this.endpoint,
        nonce: this.nonce,
        command,
        params: commandParams(this.clientId, body),
        connectTimeoutMs: this.connectTimeoutMs,
        requestTimeoutMs: this.requestTimeoutMs,
      });
      return result.value;
    } catch (error) {
      throw normalizeFollowerError(error);
    }
  }

  // ── Terminal ────────────────────────────────────────────────

  private async attachTerminal(
    sessionId: string,
    runEpoch: number,
    cols?: number,
    rows?: number,
    onLeaseGranted?: (leaseId: string) => void,
  ): Promise<CompanyTerminalHandle> {
    const value = await this.send(COMPANY_HOST_COMMANDS.terminalAttach, {
      sessionId,
      runEpoch,
      cols,
      rows,
      // The subscriber lease is what the owner binds this viewer to; without
      // it the attach is a request with no proven owner and is refused.
      leaseId: this.subscriberLease,
    });
    if (
      !isFrameObject(value) ||
      typeof value['leaseId'] !== 'string' ||
      value['leaseId'].length === 0 ||
      typeof value['cols'] !== 'number' ||
      typeof value['rows'] !== 'number'
    ) {
      throw hostError('owner_protocol_error');
    }
    const replay = value['replay'];
    const handle: CompanyTerminalHandle = {
      leaseId: value['leaseId'],
      cols: value['cols'],
      rows: value['rows'],
      ...(isFrameObject(replay) &&
      typeof replay['seq'] === 'number' &&
      typeof replay['data'] === 'string'
        ? { replay: { seq: replay['seq'], data: replay['data'] } }
        : {}),
    };
    this.sessions.set(sessionKey(sessionId, runEpoch), handle.leaseId);
    onLeaseGranted?.(handle.leaseId);
    return handle;
  }

  private async writeTerminal(
    sessionId: string,
    runEpoch: number,
    data: string,
    leaseId: string,
  ): Promise<void> {
    await this.send(COMPANY_HOST_COMMANDS.terminalWrite, { sessionId, runEpoch, data, leaseId });
  }

  private async resizeTerminal(
    sessionId: string,
    runEpoch: number,
    cols: number,
    rows: number,
    leaseId: string,
  ): Promise<void> {
    await this.send(COMPANY_HOST_COMMANDS.terminalResize, {
      sessionId,
      runEpoch,
      cols,
      rows,
      leaseId,
    });
  }

  private async detachTerminal(
    sessionId: string,
    runEpoch: number,
    leaseId: string,
  ): Promise<void> {
    await this.send(COMPANY_HOST_COMMANDS.terminalDetach, { sessionId, runEpoch, leaseId });
    if (this.sessions.get(sessionKey(sessionId, runEpoch)) === leaseId) {
      this.sessions.delete(sessionKey(sessionId, runEpoch));
    }
  }

  // ── Coordinator proxy ───────────────────────────────────────

  private createCoordinator(): CompanyCoordinator {
    const proxy = this;
    return {
      async submitPrompt(input: SubmitPromptInput): Promise<CompanyPrompt> {
        if (!isFrameObject(input) || typeof input.requestId !== 'string') {
          throw hostError('command_invalid');
        }
        const value = await proxy.send(COMPANY_HOST_COMMANDS.submitPrompt, { input });
        if (!isFrameObject(value) || !isFrameObject(value['prompt'])) {
          throw hostError('owner_protocol_error');
        }
        return value['prompt'] as unknown as CompanyPrompt;
      },

      async decideContract(
        id: string,
        revision: number,
        decision: ContractDecision,
        note?: string,
      ): Promise<void> {
        if (typeof id !== 'string' || id.length === 0) throw hostError('command_invalid');
        if (!CONTRACT_DECISIONS.includes(decision)) throw hostError('command_invalid');
        if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
          throw hostError('command_invalid');
        }
        await proxy.send(COMPANY_HOST_COMMANDS.decideContract, { id, revision, decision, note });
      },

      async answerQuestion(input: QuestionAnswerInput): Promise<void> {
        if (!isFrameObject(input) || typeof input.requestId !== 'string') {
          throw hostError('command_invalid');
        }
        await proxy.send(COMPANY_HOST_COMMANDS.answerQuestion, { input });
      },

      /**
       * Native-run reporting has no follower half. A Worker result, a QA
       * verdict or a Judge verdict is a claim about a live native generation
       * that only the owner runs, and relaying it would let a second executor
       * attest to work it never performed. The owner applies these itself.
       */
      async submitTaskResult(): Promise<WorkerTaskResultOutput> {
        throw hostError('role_forbidden');
      },

      async verifyTask(): Promise<VerificationOutcome> {
        throw hostError('role_forbidden');
      },

      async submitQaResult(): Promise<ReviewerResultOutput> {
        throw hostError('role_forbidden');
      },

      async submitJudgeResult(): Promise<ReviewerResultOutput> {
        throw hostError('role_forbidden');
      },

      async controlSession(
        id: string,
        action: CompanySessionAction,
        runEpoch: number,
      ): Promise<void> {
        if (typeof id !== 'string' || id.length === 0) throw hostError('command_invalid');
        if (!COMPANY_SESSION_ACTIONS.includes(action)) throw hostError('command_invalid');
        if (typeof runEpoch !== 'number' || !Number.isInteger(runEpoch) || runEpoch < 0) {
          throw hostError('command_invalid');
        }
        await proxy.send(COMPANY_HOST_COMMANDS.controlSession, { id, action, runEpoch });
      },

      async renameSession(id: string, name: string): Promise<void> {
        if (typeof id !== 'string' || id.length === 0) throw hostError('command_invalid');
        if (typeof name !== 'string') throw hostError('command_invalid');
        await proxy.send(COMPANY_HOST_COMMANDS.renameSession, { id, name });
      },

      async cancelPrompt(promptId: string): Promise<void> {
        if (typeof promptId !== 'string' || promptId.length === 0) {
          throw hostError('command_invalid');
        }
        await proxy.send(COMPANY_HOST_COMMANDS.promptCancel, { promptId });
      },

      async listOmpSessions(): Promise<OmpSessionListing> {
        const value = await proxy.send(COMPANY_HOST_COMMANDS.ompSessions);
        if (!isFrameObject(value)) throw hostError('owner_protocol_error');
        const folder = value['folder'];
        const sessions = value['sessions'];
        if (typeof folder !== 'string' || !Array.isArray(sessions)) {
          throw hostError('owner_protocol_error');
        }
        return { folder, sessions: sessions as OmpSessionEntry[] };
      },

      async resumeOmpSession(file: string): Promise<string> {
        if (typeof file !== 'string' || file.length === 0) throw hostError('command_invalid');
        const value = await proxy.send(COMPANY_HOST_COMMANDS.resumeOmpSession, { file });
        if (!isFrameObject(value)) throw hostError('owner_protocol_error');
        const sessionId = value['sessionId'];
        if (typeof sessionId !== 'string') throw hostError('owner_protocol_error');
        return sessionId;
      },

      async openNewChat(
        input: { cwd?: string; role?: CompanyRole; workstreamKey?: string } = {},
      ): Promise<string> {
        const value = await proxy.send(COMPANY_HOST_COMMANDS.openNewChat, {
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.role === undefined ? {} : { role: input.role }),
          ...(input.workstreamKey === undefined ? {} : { workstreamKey: input.workstreamKey }),
        });
        if (!isFrameObject(value)) throw hostError('owner_protocol_error');
        const sessionId = value['sessionId'];
        if (typeof sessionId !== 'string') throw hostError('owner_protocol_error');
        return sessionId;
      },

      async parkSquadSession(sessionId: string): Promise<boolean> {
        const value = await proxy.send(COMPANY_HOST_COMMANDS.parkSquadSession, { id: sessionId });
        if (!isFrameObject(value) || typeof value['parked'] !== 'boolean') {
          throw hostError('owner_protocol_error');
        }
        return value['parked'];
      },

      async updateSettings(roleProfiles: Record<string, RoleProfile>): Promise<void> {
        if (!isFrameObject(roleProfiles)) throw hostError('command_invalid');
        await proxy.send(COMPANY_HOST_COMMANDS.updateSettings, { roleProfiles });
      },

      snapshot(): CompanySnapshot {
        if (!proxy.snapshotValue) throw hostError('owner_unavailable');
        return proxy.snapshotValue;
      },

      holdsId(id: string): boolean {
        // A follower keeps no state of its own: it answers from the owner's last polled projection.
        const snapshot = proxy.snapshotValue;
        if (snapshot === null) return false;
        const held = (items: ReadonlyArray<{ readonly id: string }>): boolean =>
          items.some((item) => item.id === id);
        return (
          held(snapshot.sessions) ||
          held(snapshot.tasks) ||
          held(snapshot.contracts) ||
          held(snapshot.questions) ||
          held(snapshot.prompts)
        );
      },

      diagnostics(): CompanyDiagnostics {
        // Demand-driven: the panel asks when it opens, and the next poll carries
        // the measurement instead of this process spawning one per session.
        proxy.diagnosticsRequested = true;
        return proxy.diagnosticsValue ?? { ...EMPTY_DIAGNOSTICS };
      },

      async dispose(): Promise<void> {
        await proxy.dispose();
      },
    };
  }
}

/**
 * A follower's channel failure is reported as a company code so the surface can
 * tell "the owner is not there" from "the company refused this", without
 * learning anything about the owner process beyond that.
 *
 * The broker's own codes describe the pipe, not the company: an unreachable,
 * closed or timed-out channel means the owner is unavailable, and saying so
 * plainly is what makes the follower's next move obvious. Codes the owner sent
 * about the company itself are passed through untouched.
 */
function normalizeFollowerError(error: unknown): CompanyError {
  if (error instanceof CompanyError) {
    if (error.code.startsWith('company_broker_')) return hostError('owner_unavailable', error);
    if (error.code.startsWith('company_')) return error;
  }
  return hostError('owner_unavailable', error);
}

function sessionKey(sessionId: string, runEpoch: number): string {
  return `${sessionId}:${runEpoch}`;
}

/** Owner-side subscriber registry; see `workspaceCompanyHost.ts`. */
export interface CompanyHostFanout {
  subscribe(leaseId: string, clientId: string): void;
  unsubscribe(leaseId: string, clientId: string): void;
  drain(leaseId: string, clientId: string, limit: number): FollowerDrainResult;
  publish(message: ServerMessage): void;
  count(): number;
}

/** Owner-side dispatcher dependencies; see `workspaceCompanyHost.ts`. */
export interface CompanyHostDispatcher {
  (request: CompanyBrokerRequest): Promise<unknown>;
}

export { hostError as companyHostError };
