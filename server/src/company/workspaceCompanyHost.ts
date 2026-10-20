/**
 * workspaceCompanyHost: the shared composition both surfaces open.
 *
 * A canonical workspace has exactly one execution owner, and either surface
 * (the VS Code extension, the standalone CLI) can be open on it at the same
 * time. This module is what a surface actually opens. It resolves ownership
 * first, then composes exactly one of two shapes and hands the surface the same
 * `CompanyCommandServices` either way:
 *
 *  - **Owner.** Native runtime, coordinator and a local broker. Commands run
 *    here; the broker exists so another surface on this workspace can ask for
 *    them instead of starting a second executor.
 *  - **Follower.** No runtime, no coordinator, no runner, no PTY. A proxied
 *    coordinator and terminal gateway forward each call to the owner over the
 *    broker, and the durable projection arrives by bounded poll.
 *
 * Ordering is the whole point of the composition. Ownership is acquired BEFORE
 * anything is created, because anything created first would already be a second
 * executor by the time the lock says "follower". Ownership failure never
 * degrades into "carry on without the lock": a follower that cannot resolve a
 * live owner closes with a capability error instead of writing to a journal it
 * does not own.
 *
 * Everything acquired is rolled back if a later step fails, in reverse order,
 * because a half-composed owner is worse than no owner: it would hold the lock
 * and refuse every command sent to it.
 *
 * Privilege is checked twice, on purpose. A follower already knows its client
 * passed its own ingress gate, and that gate is worthless to the owner, which
 * cannot see it. So every proxied request carries an explicit privilege proof
 * naming the client, and this process's dispatcher re-checks that name against
 * an injected authority before it changes anything. The broker nonce
 * authenticates the peer process; the authority decides what that client may do.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  AgentInfo,
  CompanyModelCatalogEntry,
  CompanyRole,
  QuestionAnswerInput,
  RoleProfile,
  SubmitPromptInput,
} from '../../../core/src/company.js';
import type { ServerMessage, SquadSettings } from '../../../core/src/messages.js';
import { registerWorkItemService } from '../library/workItemRegistry.js';
import { createClaudeTurnRunner, createEngineRunner } from './claudeCode/claudeTurnRunner.js';
import type { CompanyCommandServices, CompanyTerminalGateway } from './clientCommands.js';
import {
  type CompanyBrokerEvent,
  type CompanyBrokerHandle,
  type CompanyBrokerRequest,
  createCompanyBrokerServer,
  resolveCompanyBrokerEndpoint,
} from './companyBroker.js';
import {
  COMPANY_SESSION_ACTIONS,
  COMPANY_SESSION_NAME_MAX_LENGTH,
  type CompanySessionAction,
  CONTRACT_DECISIONS,
  type ContractDecision,
} from './companyCoordinator.js';
import { WorkspaceCompanyCoordinator } from './companyCoordinatorRuntime.js';
import { CompanyError } from './companyError.js';
import {
  COMPANY_HOST_COMMAND_NAMES,
  COMPANY_HOST_COMMANDS,
  COMPANY_HOST_DRAIN_LIMIT,
  COMPANY_HOST_MAX_MESSAGE_BYTES,
  COMPANY_HOST_MAX_PENDING_BYTES,
  COMPANY_HOST_MAX_PENDING_MESSAGES,
  COMPANY_HOST_MUTATING_COMMANDS,
  COMPANY_HOST_TERMINAL_MESSAGE_TYPES,
  CompanyFollowerProxy,
  type CompanyHostDispatcher,
  companyHostError,
  type CompanyHostFanout,
  type CompanyHostPrincipal,
  readBoundedString,
  readExecutionConsent,
  readInteger,
  readObject,
  readOptionalBoundedString,
  readPrincipal,
} from './companyFollowerProxy.js';
import { resolveNativeLaunch } from './companyNativeLaunch.js';
import {
  type CompanyOwnerDescriptor,
  CompanyOwnership,
  type CompanyOwnershipRole,
} from './companyOwnership.js';
import { type CompanyRuntime, createCompanyRuntime } from './companyRuntime.js';
import { createInitialCompanyState } from './companyState.js';
import { companyNamespaceDir, CompanyStore } from './companyStore.js';
import {
  COMPANY_MAX_RETAINED_SESSIONS,
  COMPANY_OWNER_DESCRIPTOR_FILE,
  COMPANY_TERMINAL_INPUT_MAX_BYTES,
} from './constants.js';
import {
  COMPANY_ROLES,
  type CompanyModelResolution,
  readCompanyModelRoles,
} from './hostModelRoles.js';
import type { OmpRunnerCommand } from './ompRunner.js';
import { SQUAD_LEADER_REPLY_SCHEMA } from './squad/squadLeaderSchema.js';
import { createOmpLeaderRunner } from './squad/squadRunner.js';
import { type SquadWiring, startSquad } from './squad/squadWiring.js';
import { UsageLedger } from './usageService.js';
import type { PrerequisiteCheck } from './verificationRunner.js';
import { JUDGE_REPLY_SCHEMA } from './workItems/judgeSchema.js';
import { SQUAD_SETTINGS_DEFAULT } from './workItems/squadSettings.js';
import {
  NO_LEDGER,
  startWorkItems,
  type WorkItemHerdr,
  type WorkItemLedger,
  type WorkItemWiring,
} from './workItems/workItemWiring.js';
/**
 * The client identity a surface gets when it does not name one: this process's
 * own UI client. Only that client is privileged unless the host is given an
 * authority that says otherwise, so a host cannot accidentally authorize every
 * client that can reach it.
 */
export const COMPANY_HOST_LOCAL_CLIENT = 'local-surface';

/** Follower subscriptions one owner will hold at once. */
export const COMPANY_HOST_MAX_SUBSCRIBERS = 8;

/** Bounded body fields, so a hostile peer cannot pin the owner with one value. */
const MAX_ID_LENGTH = 128;
const MAX_NOTE_LENGTH = 4_096;
/** An absolute path: an OMP session file or a working directory. */
const MAX_FILE_PATH_LENGTH = 4_096;
/** A PTY dimension is never zero, negative, or larger than a giant display. */
const MAX_TERMINAL_DIMENSION = 1_000;

/**
 * Decides which clients may run company commands THROUGH this process.
 *
 * The dispatcher consults it for every proxied command, after the explicit
 * proofs and before any body is interpreted, so a client it refuses never
 * reaches a mutation handler.
 */
export interface CompanyHostAuthority {
  isClientPrivileged(clientId: string): boolean;
}

/**
 * Default authority: a peer that proved it holds the instance nonce AND stated
 * both proofs is trusted, and its named client is recorded for the audit trail.
 *
 * An owner cannot know a follower's client ids in advance -- that is the
 * follower's own socket table -- so allowlisting them by default would refuse
 * every real follower. The trust boundary here is the same-account process the
 * broker already authenticates. A surface that keeps a client table (the
 * standalone server with many sockets) injects its own authority instead, and
 * that one really can refuse a client.
 */
export const TRUST_BROKER_PEER_AUTHORITY: CompanyHostAuthority = {
  isClientPrivileged: () => true,
};

/** The inputs the native runtime factory receives; see `companyRuntime.ts`. */
export interface CompanyRuntimeFactoryInput {
  readonly store: CompanyStore;
  readonly usageLedger: UsageLedger;
  readonly getCoordinator: () => WorkspaceCompanyCoordinator;
  readonly onMessage: (msg: ServerMessage) => void;
  readonly runnerCommand?: OmpRunnerCommand;
  readonly extensionPath?: string;
  readonly helperPath?: string;
}

/**
 * Runtime construction seam. Production uses the real factory; a host that
 * already owns a runtime, or a test that must not spawn a native process,
 * supplies its own.
 */
export type CompanyRuntimeFactory = (input: CompanyRuntimeFactoryInput) => Promise<CompanyRuntime>;

/** The real factory; a follower never reaches it because it never composes. */
const DEFAULT_RUNTIME_FACTORY: CompanyRuntimeFactory = createCompanyRuntime;

export interface WorkspaceCompanyHostOptions {
  /** Canonical workspace root; every company file path resolves inside it. */
  readonly workspacePath: string;
  /** Process-level message sink; per-client egress gates run downstream. */
  readonly onMessage: (msg: ServerMessage) => void;
  /** Process-level herdr link for work items; absent when herdr is not linked. */
  readonly herdr?: WorkItemHerdr;
  /** The process ledger's overlap scans and board watch, for conflict checks. Absent: no conflicts. */
  readonly ledger?: WorkItemLedger;
  readonly runnerCommand?: OmpRunnerCommand;
  readonly extensionPath?: string;
  readonly helperPath?: string;
  /** Identity of this surface's own client; defaults to `local-surface`. */
  readonly clientId?: string;
  /** Defaults to "only this surface's own client". */
  readonly authority?: CompanyHostAuthority;
  /** Injected ownership handle; the host still acquires and releases it. */
  readonly ownership?: CompanyOwnership;
  /**
   * Machine-checks a Contract-declared prerequisite. Omitted, a declared
   * prerequisite is unverifiable and the coordinator blocks the run instead of
   * assuming the machine is ready.
   */
  readonly checkPrerequisite?: PrerequisiteCheck;
  /** Injected native runtime factory; defaults to the real one. */
  readonly runtimeFactory?: CompanyRuntimeFactory;
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  /** Follower projection poll cadence. */
  readonly pollIntervalMs?: number;
  /** Follower event-drain poll cadence. */
  readonly eventPollIntervalMs?: number;
  /** Owner broker diagnostics; codes and counters only. */
  readonly onBrokerEvent?: (event: CompanyBrokerEvent) => void;
}

export interface WorkspaceCompanyHost {
  /** Canonical workspace root, shared with every command service. */
  readonly workspacePath: string;
  /** Folded identity key (the namespace identity). */
  readonly workspaceKey: string;
  /** Which half of the ownership this host composed. */
  readonly role: CompanyOwnershipRole;
  readonly isOwner: boolean;
  readonly services: CompanyCommandServices;
  /** Stop this host: callbacks, polls, native resources, then the lock. */
  dispose(): Promise<void>;
}

// ── Owner descriptor ───────────────────────────────────────────

/**
 * Read the current owner descriptor for a namespace.
 *
 * Read-only on purpose: a follower resolves its owner's endpoint and nonce from
 * this file and writes nothing, and the owner reads its own descriptor back to
 * name the channel it is about to bind. The parse mirrors
 * `CompanyOwnership.readDescriptor`, so a descriptor this function cannot place
 * is one the owner module will not trust either.
 */
export async function readCompanyOwnerDescriptor(
  workspaceKey: string,
): Promise<CompanyOwnerDescriptor | null> {
  const descriptorPath = path.join(
    companyNamespaceDir(workspaceKey),
    COMPANY_OWNER_DESCRIPTOR_FILE,
  );
  let raw: string;
  try {
    raw = await fs.promises.readFile(descriptorPath, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CompanyOwnerDescriptor>;
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid)) return null;
    return {
      protocolVersion: parsed.protocolVersion ?? 0,
      pid: parsed.pid,
      processStartTime: parsed.processStartTime ?? 0,
      instanceNonce: parsed.instanceNonce ?? '',
      brokerEndpoint: parsed.brokerEndpoint ?? null,
      acquiredAt: parsed.acquiredAt ?? '',
    };
  } catch {
    return null;
  }
}

/**
 * The address of an owner's channel. The descriptor may name it outright; when
 * it does not, the same derivation the owner used is repeated from its nonce,
 * so both halves always agree on one address.
 */
function ownerEndpoint(descriptor: CompanyOwnerDescriptor, socketDir: string): string {
  return (
    descriptor.brokerEndpoint ?? resolveCompanyBrokerEndpoint(socketDir, descriptor.instanceNonce)
  );
}

// ── Owner-side event fanout ────────────────────────────────────

interface BufferedMessage {
  readonly message: ServerMessage;
  readonly bytes: number;
}

interface Subscriber {
  clientId: string;
  /** Session keys this subscriber currently views. */
  readonly sessions: Set<string>;
  readonly buffer: BufferedMessage[];
  bytes: number;
  dropped: number;
}

/**
 * One session's viewer. A PTY belongs to the company's run, but at any moment
 * exactly ONE surface watches it: the owner's own UI, or one follower. The
 * claim is what makes that exclusive, and it carries both identities the rest
 * of the host needs to keep them apart.
 */
interface ViewerClaim {
  /** Follower lease that owns the view; `null` for the owner's own surface. */
  subscriberLease: string | null;
  /** Client the view was established for, local or remote. */
  clientId: string;
  /** Control lease the runtime minted for this viewer, once granted. */
  controlLease: string | null;
}

/** Session key of one terminal binding; a viewer claim is per session. */
function sessionKey(sessionId: string, runEpoch: number): string {
  return `${sessionId}:${runEpoch}`;
}

/** The session a message is scoped to, when it has one. */
function scopedSession(message: ServerMessage): string | null {
  const record = message as unknown as Record<string, unknown>;
  if (typeof record['sessionId'] !== 'string') return null;
  if (typeof record['runEpoch'] !== 'number') return null;
  return sessionKey(record['sessionId'], record['runEpoch']);
}

/** The session a terminal frame belongs to, or null for board-wide traffic. */
function terminalSessionKey(message: ServerMessage): string | null {
  if (COMPANY_HOST_TERMINAL_MESSAGE_TYPES[message.type] !== true) return null;
  return scopedSession(message);
}

/**
 * The owner's own view of its PTYs.
 *
 * The local surface attaches through this wrapper so it takes the SAME viewer
 * claim a follower does, which is what makes the two halves symmetric: whoever
 * attaches last owns the session, the other stops receiving its frames, and a
 * control lease only works for the viewer that obtained it. Routing the local
 * surface straight into the runtime left the registry blind to it, which is how
 * one surface kept watching a terminal another surface had attached.
 */
function ownerSurfaceTerminal(
  terminal: CompanyTerminalGateway,
  events: OwnerEventRegistry,
  clientId: string,
): CompanyTerminalGateway {
  return {
    attach: async (sessionId, runEpoch, cols, rows, onLeaseGranted) => {
      events.claimLocalSession(sessionId, runEpoch, clientId);
      try {
        return await terminal.attach(sessionId, runEpoch, cols, rows, (granted) => {
          events.bindControlLease(sessionId, runEpoch, granted);
          onLeaseGranted?.(granted);
        });
      } catch (error) {
        events.dropClaim(sessionId, runEpoch);
        throw error;
      }
    },
    write: (sessionId, runEpoch, data, leaseId) =>
      terminal.write(sessionId, runEpoch, data, leaseId),
    resize: (sessionId, runEpoch, cols, rows, leaseId) =>
      terminal.resize(sessionId, runEpoch, cols, rows, leaseId),
    detach: async (sessionId, runEpoch, leaseId) => {
      await terminal.detach(sessionId, runEpoch, leaseId);
      events.releaseSession(sessionId, runEpoch, leaseId);
    },
  };
}

/**
 * Bounded per-subscriber buffers for the owner's one-way events.
 *
 * The broker transport is request-response, so a follower collects its events by
 * draining this registry on its own bounded poll. Two properties matter:
 *
 *  - **Bounded.** Each subscriber holds at most a message count and a byte
 *    budget; the oldest entries are dropped first, because a board that shows
 *    a gap is recoverable and a process that grows with the event stream is
 *    not. The drop count travels with the drain so the surface knows the
 *    stream was lossy instead of silently losing terminal output.
 *  - **Viewer-scoped.** Terminal frames are delivered only to the subscriber
 *    that currently holds that session's viewer claim, so one follower's
 *    terminal is never handed to another follower, and a session that is not
 *    attached goes to nobody.
 */
class OwnerEventRegistry implements CompanyHostFanout {
  private readonly subscribers = new Map<string, Subscriber>();
  /** Session key → the viewer claim currently on that session. */
  private readonly claims = new Map<string, ViewerClaim>();

  subscribe(leaseId: string, clientId: string): void {
    if (!this.subscribers.has(leaseId) && this.subscribers.size >= COMPANY_HOST_MAX_SUBSCRIBERS) {
      throw companyHostError('subscriber_limit');
    }
    const existing = this.subscribers.get(leaseId);
    if (existing) {
      existing.clientId = clientId;
      return;
    }
    this.subscribers.set(leaseId, {
      clientId,
      sessions: new Set<string>(),
      buffer: [],
      bytes: 0,
      dropped: 0,
    });
  }

  /**
   * Drop a subscription. The client that subscribed must be the one leaving:
   * a lease id alone is a bearer token that any peer holding the instance
   * nonce could guess, so the identity it was established for is checked too.
   */
  unsubscribe(leaseId: string, clientId: string): void {
    const subscriber = this.subscribers.get(leaseId);
    if (!subscriber) return;
    if (subscriber.clientId !== clientId) throw companyHostError('privileged_required');
    for (const key of subscriber.sessions) {
      if (this.claims.get(key)?.subscriberLease === leaseId) this.claims.delete(key);
    }
    this.subscribers.delete(leaseId);
  }

  /**
   * Record a remote viewer claim before the PTY produces anything for it: the
   * attach reply and the first frames must land with the same subscriber, or
   * the stream starts somewhere the client is not listening.
   *
   * Two leases meet here and must not be confused. The SUBSCRIBER lease names
   * this process's follower and routes its frames; the CONTROL lease is minted
   * later by the runtime and is what a write, resize or detach must present.
   */
  claimRemoteSession(leaseId: string, sessionId: string, runEpoch: number): void {
    const subscriber = this.subscribers.get(leaseId);
    if (!subscriber) throw companyHostError('drain_lease_unknown');
    const key = sessionKey(sessionId, runEpoch);
    if (
      !subscriber.sessions.has(key) &&
      subscriber.sessions.size >= COMPANY_MAX_RETAINED_SESSIONS
    ) {
      throw companyHostError('command_invalid');
    }
    subscriber.sessions.add(key);
    this.claims.set(key, {
      subscriberLease: leaseId,
      clientId: subscriber.clientId,
      controlLease: null,
    });
  }

  /**
   * Record a local viewer claim, taking the session away from any follower.
   *
   * The owner's own surface attaches through this host too, so one rule covers
   * both halves: whoever attached last owns the view, and the other surface
   * stops receiving that session's frames immediately.
   */
  claimLocalSession(sessionId: string, runEpoch: number, clientId: string): void {
    const key = sessionKey(sessionId, runEpoch);
    this.detachClaimFromSubscriber(key);
    this.claims.set(key, { subscriberLease: null, clientId, controlLease: null });
  }

  /** True while the owner's own surface is the session's viewer. */
  isLocallyViewed(key: string): boolean {
    const claim = this.claims.get(key);
    return claim !== undefined && claim.subscriberLease === null;
  }

  private detachClaimFromSubscriber(key: string): void {
    const previous = this.claims.get(key);
    if (previous?.subscriberLease) {
      this.subscribers.get(previous.subscriberLease)?.sessions.delete(key);
    }
  }

  /** Bind the control lease the runtime issued to the claim waiting on it. */
  bindControlLease(sessionId: string, runEpoch: number, controlLease: string): void {
    const claim = this.claims.get(sessionKey(sessionId, runEpoch));
    if (claim) claim.controlLease = controlLease;
  }

  /** True while this control lease is the one the owner issued for the session. */
  controlsControlLease(sessionId: string, runEpoch: number, controlLease: string): boolean {
    const claim = this.claims.get(sessionKey(sessionId, runEpoch));
    return claim !== undefined && claim.controlLease === controlLease;
  }

  /** Drop a viewer claim. The PTY and the run behind it are untouched. */
  releaseSession(sessionId: string, runEpoch: number, controlLease: string): void {
    const key = sessionKey(sessionId, runEpoch);
    const claim = this.claims.get(key);
    if (!claim || claim.controlLease !== controlLease) return;
    this.dropClaim(sessionId, runEpoch);
  }

  /** Drop the claim outright, for an attach that never produced a lease. */
  dropClaim(sessionId: string, runEpoch: number): void {
    const key = sessionKey(sessionId, runEpoch);
    if (!this.claims.delete(key)) return;
    this.detachClaimFromSubscriber(key);
  }

  drain(
    leaseId: string,
    clientId: string,
    limit: number,
  ): { messages: ServerMessage[]; dropped: number; pending: boolean } {
    const subscriber = this.subscribers.get(leaseId);
    if (!subscriber) throw companyHostError('drain_lease_unknown');
    if (subscriber.clientId !== clientId) throw companyHostError('privileged_required');
    const take = Math.min(Math.max(Math.floor(limit) || 1, 1), COMPANY_HOST_DRAIN_LIMIT);
    const messages = subscriber.buffer.splice(0, take);
    for (const entry of messages) subscriber.bytes -= entry.bytes;
    return {
      messages: messages.map((entry) => entry.message),
      dropped: subscriber.dropped,
      pending: subscriber.buffer.length > 0,
    };
  }

  /**
   * Fan one owner event out to the surfaces entitled to see it.
   *
   * Terminal traffic follows the viewer claim and nothing else: the session's
   * current viewer gets the frame, and a session the OWNER's own surface is
   * watching is not fanned out to any follower at all. Board-wide events go to
   * every subscriber, because every authorized surface already renders them.
   */
  publish(message: ServerMessage): void {
    const isTerminal = COMPANY_HOST_TERMINAL_MESSAGE_TYPES[message.type] === true;
    const key = isTerminal ? scopedSession(message) : null;
    if (isTerminal) {
      // A terminal frame with no identifiable session has no viewer that could
      // claim it, so it is dropped rather than broadcast to every subscriber.
      if (key === null) return;
      const claim = this.claims.get(key);
      if (!claim || claim.subscriberLease === null) return;
      const viewer = this.subscribers.get(claim.subscriberLease);
      if (viewer) this.enqueue(viewer, message);
      return;
    }
    if (this.subscribers.size === 0) return;
    for (const subscriber of this.subscribers.values()) this.enqueue(subscriber, message);
  }

  private enqueue(subscriber: Subscriber, message: ServerMessage): void {
    const bytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
    if (bytes > COMPANY_HOST_MAX_MESSAGE_BYTES) {
      // One frame this large would not fit a broker answer; dropping it and
      // counting it is honest, where sending it would fail the whole drain.
      subscriber.dropped += 1;
      return;
    }
    subscriber.buffer.push({ message, bytes });
    subscriber.bytes += bytes;
    while (
      subscriber.buffer.length > COMPANY_HOST_MAX_PENDING_MESSAGES ||
      subscriber.bytes > COMPANY_HOST_MAX_PENDING_BYTES
    ) {
      const trimmed = subscriber.buffer.shift();
      if (!trimmed) break;
      subscriber.bytes -= trimmed.bytes;
      subscriber.dropped += 1;
    }
  }

  /** True while a lease is registered; the dispatcher refuses unknown leases. */
  has(leaseId: string): boolean {
    return this.subscribers.has(leaseId);
  }

  count(): number {
    return this.subscribers.size;
  }
}

// ── Owner-side dispatcher ──────────────────────────────────────

const PROMPT_DELIVERIES: Readonly<Record<string, true>> = {
  prompt: true,
  steer: true,
  follow_up: true,
};

const QUESTION_DECISIONS: Readonly<Record<string, true>> = {
  approve_once: true,
  reject: true,
};

export interface CompanyHostDispatcherOptions {
  readonly coordinator: () => WorkspaceCompanyCoordinator;
  readonly terminal: () => CompanyTerminalGateway;
  readonly modelCatalog: () => Promise<CompanyModelCatalogEntry[]>;
  readonly sessionInfo: (sessionId: string) => Promise<AgentInfo>;
  readonly authority: CompanyHostAuthority;
  readonly events: OwnerEventRegistry;
  readonly isDisposed: () => boolean;
}

/**
 * Build the owner's command handler.
 *
 * The broker has already proved which process is speaking. This function
 * decides what that process may ask for: the command must be in the published
 * vocabulary, the body must survive validation, and the client the request
 * claims must be one this process's authority calls privileged. The privilege
 * check runs before the body is read, so an unproven request cannot reach a
 * mutation handler at all.
 */
export function createCompanyHostDispatcher(
  options: CompanyHostDispatcherOptions,
): CompanyHostDispatcher {
  const assertClient = (
    params: unknown,
  ): { body: Record<string, unknown>; client: CompanyHostPrincipal } => {
    const principal = readPrincipal(params);
    if (!options.authority.isClientPrivileged(principal.clientId)) {
      throw companyHostError('privileged_required');
    }
    if (options.isDisposed()) throw companyHostError('owner_unavailable');
    return { body: params as Record<string, unknown>, client: principal };
  };

  const subscriberLease = (body: Record<string, unknown>): string => {
    const leaseId = readBoundedString(body, 'leaseId', MAX_ID_LENGTH);
    if (!options.events.has(leaseId)) throw companyHostError('drain_lease_unknown');
    return leaseId;
  };

  /** The session's current control lease, or a refusal the viewer can act on. */
  const assertControlLease = (sessionId: string, runEpoch: number, controlLease: string): void => {
    if (!options.events.controlsControlLease(sessionId, runEpoch, controlLease)) {
      throw companyHostError('terminal_lease_denied');
    }
  };

  /**
   * Run one coordinator call and re-raise a refusal the broker can carry.
   *
   * The broker forwards a handler's own code only when it starts with
   * `company_`, and collapses anything else into one opaque failure. A refusal
   * like `prompt_target_required` is the difference between "fix your prompt"
   * and "something broke", so it crosses the pipe with its prefix intact.
   */
  const withCompanyCode = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof CompanyError && !error.code.startsWith('company_')) {
        throw new CompanyError(`company_${error.code}`, error.message, { cause: error });
      }
      throw error;
    }
  };

  return async (request: CompanyBrokerRequest): Promise<unknown> => {
    if (COMPANY_HOST_COMMAND_NAMES[request.command] !== true) {
      throw companyHostError('command_unknown');
    }
    const { body, client } = assertClient(request.params);
    // A mutation also needs the caller's execution consent, stated explicitly:
    // the owner cannot see the follower's workspace trust or server state, and
    // must never infer either from the broker nonce.
    if (COMPANY_HOST_MUTATING_COMMANDS[request.command] === true) readExecutionConsent(body);
    switch (request.command) {
      case COMPANY_HOST_COMMANDS.snapshot: {
        const includeDiagnostics = body['includeDiagnostics'];
        if (includeDiagnostics !== undefined && typeof includeDiagnostics !== 'boolean') {
          throw companyHostError('command_invalid');
        }
        const snapshot = options.coordinator().snapshot();
        if (includeDiagnostics !== true) return { snapshot };
        return { snapshot, diagnostics: options.coordinator().diagnostics() };
      }

      case COMPANY_HOST_COMMANDS.modelCatalog:
        return options.modelCatalog();

      case COMPANY_HOST_COMMANDS.sessionInfo:
        return options.sessionInfo(readBoundedString(body, 'id', MAX_ID_LENGTH));

      case COMPANY_HOST_COMMANDS.submitPrompt: {
        const input = readObject(body, 'input');
        const text = input['text'];
        if (typeof text !== 'string' || text.length === 0)
          throw companyHostError('command_invalid');
        if (typeof input['requestId'] !== 'string' || input['requestId'].length === 0) {
          throw companyHostError('command_invalid');
        }
        if (PROMPT_DELIVERIES[String(input['delivery'])] !== true) {
          throw companyHostError('command_invalid');
        }
        const prompt = await withCompanyCode(() =>
          options.coordinator().submitPrompt(input as unknown as SubmitPromptInput),
        );
        return { prompt };
      }

      case COMPANY_HOST_COMMANDS.decideContract: {
        const id = readBoundedString(body, 'id', MAX_ID_LENGTH);
        const revision = readInteger(body, 'revision');
        const decision = readBoundedString(body, 'decision', MAX_ID_LENGTH);
        if (CONTRACT_DECISIONS.includes(decision as ContractDecision) === false) {
          throw companyHostError('command_invalid');
        }
        const note = readOptionalBoundedString(body, 'note', MAX_NOTE_LENGTH);
        await withCompanyCode(() =>
          options.coordinator().decideContract(id, revision, decision as ContractDecision, note),
        );
        return null;
      }

      case COMPANY_HOST_COMMANDS.answerQuestion: {
        const input = readObject(body, 'input');
        if (typeof input['requestId'] !== 'string' || input['requestId'].length === 0) {
          throw companyHostError('command_invalid');
        }
        if (typeof input['questionId'] !== 'string' || input['questionId'].length === 0) {
          throw companyHostError('command_invalid');
        }
        if (typeof input['runEpoch'] !== 'number' || !Number.isInteger(input['runEpoch'])) {
          throw companyHostError('command_invalid');
        }
        if (typeof input['answers'] !== 'object' || input['answers'] === null) {
          throw companyHostError('command_invalid');
        }
        const decision = input['decision'];
        if (decision !== undefined && QUESTION_DECISIONS[String(decision)] !== true) {
          throw companyHostError('command_invalid');
        }
        await withCompanyCode(() =>
          options.coordinator().answerQuestion(input as unknown as QuestionAnswerInput),
        );
        return null;
      }

      case COMPANY_HOST_COMMANDS.controlSession: {
        const id = readBoundedString(body, 'id', MAX_ID_LENGTH);
        const action = readBoundedString(body, 'action', MAX_ID_LENGTH);
        if (COMPANY_SESSION_ACTIONS.includes(action as CompanySessionAction) === false) {
          throw companyHostError('command_invalid');
        }
        const runEpoch = readInteger(body, 'runEpoch');
        await withCompanyCode(() =>
          options.coordinator().controlSession(id, action as CompanySessionAction, runEpoch),
        );
        return null;
      }

      case COMPANY_HOST_COMMANDS.renameSession: {
        const id = readBoundedString(body, 'id', MAX_ID_LENGTH);
        const name = readBoundedString(body, 'name', COMPANY_SESSION_NAME_MAX_LENGTH);
        await withCompanyCode(() => options.coordinator().renameSession(id, name));
        return null;
      }

      case COMPANY_HOST_COMMANDS.promptCancel: {
        const promptId = readBoundedString(body, 'promptId', MAX_ID_LENGTH);
        await withCompanyCode(() => options.coordinator().cancelPrompt(promptId));
        return null;
      }

      case COMPANY_HOST_COMMANDS.ompSessions:
        return withCompanyCode(() => options.coordinator().listOmpSessions());

      case COMPANY_HOST_COMMANDS.resumeOmpSession: {
        const file = readBoundedString(body, 'file', MAX_FILE_PATH_LENGTH);
        const sessionId = await withCompanyCode(() => options.coordinator().resumeOmpSession(file));
        return { sessionId };
      }

      case COMPANY_HOST_COMMANDS.openNewChat: {
        const cwd = readOptionalBoundedString(body, 'cwd', MAX_FILE_PATH_LENGTH);
        const role = readOptionalRole(body);
        const workstreamKey = readOptionalBoundedString(body, 'workstreamKey', MAX_ID_LENGTH);
        // Only a squad may name its workstream; the key decides which parked session it reuses.
        if (workstreamKey !== undefined && !workstreamKey.startsWith('squad:')) {
          throw companyHostError('command_invalid');
        }
        const sessionId = await withCompanyCode(() =>
          options.coordinator().openNewChat({
            ...(cwd === undefined ? {} : { cwd }),
            ...(role === undefined ? {} : { role }),
            ...(workstreamKey === undefined ? {} : { workstreamKey }),
          }),
        );
        return { sessionId };
      }

      case COMPANY_HOST_COMMANDS.parkSquadSession: {
        const id = readBoundedString(body, 'id', MAX_ID_LENGTH);
        const parked = await withCompanyCode(() => options.coordinator().parkSquadSession(id));
        return { parked };
      }

      case COMPANY_HOST_COMMANDS.updateSettings: {
        const roleProfiles = readObject(body, 'roleProfiles');
        for (const [role, profile] of Object.entries(roleProfiles)) {
          if (role.length === 0 || role.length > MAX_ID_LENGTH) {
            throw companyHostError('command_invalid');
          }
          if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
            throw companyHostError('command_invalid');
          }
        }
        await withCompanyCode(() =>
          options
            .coordinator()
            .updateSettings(roleProfiles as unknown as Record<string, RoleProfile>),
        );
        return null;
      }

      case COMPANY_HOST_COMMANDS.terminalAttach: {
        const sessionId = readBoundedString(body, 'sessionId', MAX_ID_LENGTH);
        const runEpoch = readInteger(body, 'runEpoch');
        const cols = readDimension(body, 'cols');
        const rows = readDimension(body, 'rows');
        const leaseId = subscriberLease(body);
        // Claim first: the attach reply and every frame after it belong to the
        // same viewer claim, and a frame published before the claim would be
        // dropped for lack of an owner.
        options.events.claimRemoteSession(leaseId, sessionId, runEpoch);
        try {
          return await withCompanyCode(() =>
            options.terminal().attach(sessionId, runEpoch, cols, rows, (granted) => {
              // The runtime mints the control lease on grant; binding it here is
              // what makes a write, resize or detach prove it came from this
              // attach, and it invalidates the lease the previous viewer held.
              options.events.bindControlLease(sessionId, runEpoch, granted);
            }),
          );
        } catch (error) {
          options.events.dropClaim(sessionId, runEpoch);
          throw error;
        }
      }

      case COMPANY_HOST_COMMANDS.terminalWrite: {
        const sessionId = readBoundedString(body, 'sessionId', MAX_ID_LENGTH);
        const runEpoch = readInteger(body, 'runEpoch');
        const data = readBoundedString(body, 'data', COMPANY_TERMINAL_INPUT_MAX_BYTES);
        const leaseId = readBoundedString(body, 'leaseId', MAX_ID_LENGTH);
        assertControlLease(sessionId, runEpoch, leaseId);
        await withCompanyCode(() => options.terminal().write(sessionId, runEpoch, data, leaseId));
        return null;
      }

      case COMPANY_HOST_COMMANDS.terminalResize: {
        const sessionId = readBoundedString(body, 'sessionId', MAX_ID_LENGTH);
        const runEpoch = readInteger(body, 'runEpoch');
        const leaseId = readBoundedString(body, 'leaseId', MAX_ID_LENGTH);
        assertControlLease(sessionId, runEpoch, leaseId);
        const cols = readRequiredDimension(body, 'cols');
        const rows = readRequiredDimension(body, 'rows');
        await withCompanyCode(() =>
          options.terminal().resize(sessionId, runEpoch, cols, rows, leaseId),
        );
        return null;
      }

      case COMPANY_HOST_COMMANDS.terminalDetach: {
        const sessionId = readBoundedString(body, 'sessionId', MAX_ID_LENGTH);
        const runEpoch = readInteger(body, 'runEpoch');
        const leaseId = readBoundedString(body, 'leaseId', MAX_ID_LENGTH);
        assertControlLease(sessionId, runEpoch, leaseId);
        // Release this VIEWER: the runtime drops the lease that drove the PTY
        // while the run keeps going, so a follower leaving the room never stops
        // work the owner started.
        await withCompanyCode(() => options.terminal().detach(sessionId, runEpoch, leaseId));
        options.events.releaseSession(sessionId, runEpoch, leaseId);
        return null;
      }

      case COMPANY_HOST_COMMANDS.subscribe: {
        const leaseId = readBoundedString(body, 'leaseId', MAX_ID_LENGTH);
        options.events.subscribe(leaseId, client.clientId);
        return { subscribed: true };
      }

      case COMPANY_HOST_COMMANDS.drain: {
        const leaseId = readBoundedString(body, 'leaseId', MAX_ID_LENGTH);
        const limit = readInteger(body, 'limit');
        if (limit === 0) throw companyHostError('drain_limit_invalid');
        return options.events.drain(leaseId, client.clientId, limit);
      }

      case COMPANY_HOST_COMMANDS.unsubscribe: {
        const leaseId = readBoundedString(body, 'leaseId', MAX_ID_LENGTH);
        options.events.unsubscribe(leaseId, client.clientId);
        return null;
      }

      default:
        throw companyHostError('command_unknown');
    }
  };
}

/** An explicit PTY dimension; absent means "keep what the binding has". */
function readDimension(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_TERMINAL_DIMENSION
  ) {
    throw companyHostError('command_invalid');
  }
  return value;
}

/** A resize names both dimensions; one that does not is not a resize. */
function readRequiredDimension(body: Record<string, unknown>, key: string): number {
  const value = readDimension(body, key);
  if (value === undefined) throw companyHostError('command_invalid');
  return value;
}

/** An optional company role for a new chat; a name outside the roster is refused, never guessed. */
function readOptionalRole(body: Record<string, unknown>): CompanyRole | undefined {
  const value = body['role'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || COMPANY_ROLES.includes(value as CompanyRole) === false) {
    throw companyHostError('role_invalid');
  }
  return value as CompanyRole;
}

/** Run one disposal step, remembering the first failure instead of aborting. */
async function runStep(state: { failure?: unknown }, step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (error) {
    state.failure ??= error;
  }
}

// ── Composition ────────────────────────────────────────────────

/**
 * Open the shared company host for one canonical workspace.
 *
 * The board's models are read first — once, from the host OMP, before anything
 * can run — and every piece of durable state this surface creates is seeded from
 * that one answer. Ownership is resolved next. The owner composes a runtime, a
 * coordinator and a broker; a follower composes a proxied coordinator, a proxied
 * terminal and the polls that keep its projection current. Either way the surface
 * receives one `CompanyCommandServices`, so a command path cannot tell the two
 * apart.
 */
export async function openWorkspaceCompany(
  options: WorkspaceCompanyHostOptions,
): Promise<WorkspaceCompanyHost> {
  // One read answers the whole board: the host OMP's own `modelRoles` decide
  // what every Company role runs on. It happens here — once per surface start,
  // before a coordinator exists and therefore before any run can start — rather
  // than per role or per turn, because the read costs seconds.
  // `readCompanyModelRoles` never throws and never hangs, so a machine with no
  // OMP, an unreadable payload or a timeout keeps the documented fallback models
  // and says which in the line below.
  const modelRoles = await readCompanyModelRoles({
    command: hostModelRolesCommand(options),
    cwd: options.workspacePath,
  });
  reportBoardModelRoles(modelRoles);
  const store = await CompanyStore.open(options.workspacePath, modelRoles);
  const ownership = options.ownership ?? new CompanyOwnership();
  const role = await ownership.acquire(store.workspaceKey);
  return role === 'owner'
    ? openOwnerCompanyHost(options, store, ownership, modelRoles)
    : openFollowerCompanyHost(options, store, ownership);
}

/**
 * The OMP command the host model-role read asks for its roles.
 *
 * Production names no command and lets the runtime resolve the installed one, so
 * the same resolver answers here rather than a second spelling of that lookup.
 * A machine where OMP cannot be resolved yields no executable at all, which the
 * read reports as a fallback rather than as a reason to refuse opening the
 * company — the runtime raises that failure on its own, where it belongs.
 */
function hostModelRolesCommand(options: WorkspaceCompanyHostOptions): OmpRunnerCommand {
  if (options.runnerCommand !== undefined) return options.runnerCommand;
  try {
    return resolveNativeLaunch({
      ...(options.extensionPath === undefined ? {} : { extensionPath: options.extensionPath }),
      ...(options.helperPath === undefined ? {} : { helperPath: options.helperPath }),
    }).command;
  } catch {
    return { file: '', args: [] };
  }
}

/**
 * State where the board's models came from, before anything runs on them.
 *
 * A board quietly on its fallback models is indistinguishable from one following
 * the host, and the user cannot tell which is running their work — so the source,
 * the resolved selectors and any diagnostic are stated at startup rather than
 * assumed. `CompanySettings` has no provenance field (the generated schema is
 * closed with `additionalProperties: false`), so this line is the observable
 * seam today; a schema that grows one should read it from there instead.
 */
function reportBoardModelRoles(modelRoles: CompanyModelResolution): void {
  const selectors = COMPANY_ROLES.map((role) => {
    const assignment = modelRoles.assignments[role];
    return `${role}=${assignment.model}:${assignment.thinking}`;
  }).join(' ');
  const detail = modelRoles.diagnostic ? ` — ${modelRoles.diagnostic}` : '';
  const line = `[Pixel Agents] Company board models (${modelRoles.source}): ${selectors}${detail}`;
  if (modelRoles.source === 'host') console.log(line);
  else console.warn(line);
}

async function openOwnerCompanyHost(
  options: WorkspaceCompanyHostOptions,
  store: CompanyStore,
  ownership: CompanyOwnership,
  modelRoles: CompanyModelResolution,
): Promise<WorkspaceCompanyHost> {
  const authority = options.authority ?? TRUST_BROKER_PEER_AUTHORITY;
  // A channel for another instance's runs would let two owners schedule work,
  // so an occupied endpoint is a hard failure rather than a retry.
  const descriptor = await readCompanyOwnerDescriptor(store.workspaceKey);
  if (!descriptor || descriptor.pid !== process.pid || descriptor.instanceNonce.length === 0) {
    await ownership.release().catch(() => undefined);
    throw companyHostError('owner_descriptor_unreadable');
  }
  const endpoint = ownerEndpoint(descriptor, store.namespaceDir);

  const events = new OwnerEventRegistry();
  let runtime: CompanyRuntime | null = null;
  let coordinator: WorkspaceCompanyCoordinator | null = null;
  let broker: CompanyBrokerHandle | null = null;
  let disposed = false;
  let unregisterWorkItems: (() => void) | null = null;
  let workItemsWiring: WorkItemWiring | null = null;
  let squadWiring: SquadWiring | null = null;
  const publish = (message: ServerMessage): void => {
    if (message.type === 'companyStateChanged') workItemsWiring?.service.scheduleReconcile();
    const key = terminalSessionKey(message);
    if (key === null) {
      // Board-wide: every authorized surface renders these already.
      options.onMessage(message);
      events.publish(message);
      return;
    }
    // Terminal traffic belongs to the session's CURRENT viewer and nobody
    // else. Sending it to both would hand one surface's terminal — and the
    // other surface's keystrokes — to a client that never attached.
    if (events.isLocallyViewed(key)) options.onMessage(message);
    else events.publish(message);
  };

  const cleanup: { failure?: unknown } = {};
  try {
    broker = await createCompanyBrokerServer({
      endpoint,
      nonce: descriptor.instanceNonce,
      onRequest: createCompanyHostDispatcher({
        coordinator: () => {
          if (!coordinator) throw companyHostError('owner_unavailable');
          return coordinator;
        },
        terminal: () => {
          if (!runtime) throw companyHostError('terminal_unavailable');
          return runtime.terminal;
        },
        modelCatalog: () => {
          if (!runtime) throw companyHostError('model_catalog_unavailable');
          return runtime.modelCatalog();
        },
        sessionInfo: (sessionId) => {
          if (!runtime) throw companyHostError('owner_unavailable');
          return runtime.sessionInfo(sessionId);
        },
        authority,
        events,
        isDisposed: () => disposed,
      }),
      onEvent: options.onBrokerEvent,
    });
    const usageLedger = new UsageLedger();
    const factory = options.runtimeFactory ?? DEFAULT_RUNTIME_FACTORY;
    runtime = await factory({
      store,
      usageLedger,
      getCoordinator: () => {
        if (!coordinator) throw companyHostError('owner_unavailable');
        return coordinator;
      },
      onMessage: publish,
      runnerCommand: options.runnerCommand,
      extensionPath: options.extensionPath,
      helperPath: options.helperPath,
    });
    coordinator = new WorkspaceCompanyCoordinator({
      store,
      state: createInitialCompanyState(store.workspacePath, modelRoles),
      usageLedger,
      isOwner: () => true,
      effects: runtime.effects,
      isTerminalAttached: runtime.isTerminalAttached,
      workspaceRoot: store.workspacePath,
      checkPrerequisite: options.checkPrerequisite ?? runtime.checkPrerequisite,
    });
    await coordinator.start();
    // Each leader or judge turn reads its engine and models from the folder's squad settings.
    const squadSettingsNow = (): SquadSettings =>
      workItemsWiring?.service.currentSettings() ?? SQUAD_SETTINGS_DEFAULT;
    workItemsWiring = await startWorkItems({
      workspacePath: store.workspacePath,
      namespaceDir: store.namespaceDir,
      herdr: options.herdr,
      coordinator,
      publish,
      judge: createEngineRunner({
        engine: () => squadSettingsNow().brain,
        omp: createOmpLeaderRunner({
          command: hostModelRolesCommand(options),
          cwd: store.workspacePath,
          model: modelRoles.assignments.judge.model,
          thinking:
            modelRoles.assignments.judge.thinking === ''
              ? null
              : modelRoles.assignments.judge.thinking,
          label: 'Giám khảo',
        }),
        claude: createClaudeTurnRunner({
          cwd: store.workspacePath,
          label: 'Giám khảo',
          model: () => squadSettingsNow().claudeModelJudge,
          schema: JUDGE_REPLY_SCHEMA,
        }),
      }),
      ledger: options.ledger ?? NO_LEDGER,
    });
    unregisterWorkItems = registerWorkItemService(store.namespaceDir, workItemsWiring.service);
    const director = modelRoles.assignments.director;
    squadWiring = await startSquad({
      workspacePath: store.workspacePath,
      namespaceDir: store.namespaceDir,
      herdr: options.herdr,
      coordinator,
      workItems: workItemsWiring.service,
      leader: createEngineRunner({
        engine: () => squadSettingsNow().brain,
        omp: createOmpLeaderRunner({
          command: hostModelRolesCommand(options),
          cwd: store.workspacePath,
          model: director.model,
          thinking: director.thinking === '' ? null : director.thinking,
        }),
        claude: createClaudeTurnRunner({
          cwd: store.workspacePath,
          label: 'Trưởng đội',
          model: () => squadSettingsNow().claudeModelLeader,
          schema: SQUAD_LEADER_REPLY_SCHEMA,
        }),
      }),
      publish,
    });
  } catch (error) {
    // Reverse order, and always: a half-composed owner would hold the lock and
    // refuse every command sent to it.
    unregisterWorkItems?.();
    unregisterWorkItems = null;
    await runStep(cleanup, async () => {
      await runtime?.dispose();
    });
    await runStep(cleanup, async () => {
      await broker?.dispose();
    });
    await runStep(cleanup, async () => ownership.release());
    throw cleanup.failure ?? error;
  }

  const ownerCoordinator = coordinator;
  const ownerRuntime = runtime;
  const ownerBroker = broker;
  const ownerWorkItems = workItemsWiring;
  const ownerSquad = squadWiring;
  const services: CompanyCommandServices = {
    coordinator: ownerCoordinator,
    store,
    workspaceRoot: store.workspacePath,
    terminal: ownerSurfaceTerminal(
      ownerRuntime.terminal,
      events,
      options.clientId ?? COMPANY_HOST_LOCAL_CLIENT,
    ),
    modelCatalog: () => ownerRuntime.modelCatalog(),
    sessionInfo: (sessionId) => ownerRuntime.sessionInfo(sessionId),
    workItems: ownerWorkItems.service,
    squad: ownerSquad.service,
  };

  return {
    workspacePath: store.workspacePath,
    workspaceKey: store.workspaceKey,
    role: 'owner',
    isOwner: true,
    services,
    async dispose(): Promise<void> {
      if (disposed) return;
      // Stop accepting commands, quiesce owned runs, close the channel, and
      // only then hand the lock to whoever asks next.
      disposed = true;
      const steps: { failure?: unknown } = {};
      await runStep(steps, async () => ownerSquad.dispose());
      unregisterWorkItems?.();
      unregisterWorkItems = null;
      await runStep(steps, async () => ownerWorkItems.dispose());
      await runStep(steps, async () => ownerCoordinator.dispose());
      await runStep(steps, async () => ownerBroker.dispose());
      await runStep(steps, async () => ownership.release());
      if (steps.failure !== undefined) throw steps.failure;
    },
  };
}

async function openFollowerCompanyHost(
  options: WorkspaceCompanyHostOptions,
  store: CompanyStore,
  ownership: CompanyOwnership,
): Promise<WorkspaceCompanyHost> {
  const clientId = options.clientId ?? COMPANY_HOST_LOCAL_CLIENT;
  const descriptor = await readCompanyOwnerDescriptor(store.workspaceKey);
  if (!descriptor || descriptor.instanceNonce.length === 0) {
    // No owner to name: this instance does not get the workspace, and it does
    // not get to guess that the owner is gone. Closing is the fail-closed move.
    await ownership.release().catch(() => undefined);
    throw companyHostError('owner_unavailable');
  }
  const endpoint = ownerEndpoint(descriptor, store.namespaceDir);
  const proxy = new CompanyFollowerProxy({
    endpoint,
    nonce: descriptor.instanceNonce,
    clientId,
    connectTimeoutMs: options.connectTimeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    eventPollIntervalMs: options.eventPollIntervalMs,
  });
  try {
    // Proves the owner answers before this surface believes it is connected.
    await proxy.start((messages) => {
      for (const message of messages) options.onMessage(message);
    });
  } catch (error) {
    await proxy.dispose().catch(() => undefined);
    throw error;
  }

  let disposed = false;
  return {
    workspacePath: store.workspacePath,
    workspaceKey: store.workspaceKey,
    role: 'follower',
    isOwner: false,
    services: {
      coordinator: proxy.coordinator,
      store,
      workspaceRoot: store.workspacePath,
      terminal: proxy.terminal,
      modelCatalog: () => proxy.modelCatalog(),
      sessionInfo: (sessionId) => proxy.sessionInfo(sessionId),
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      // A follower owns no lock, no runner and no PTY: it stops polling, drops
      // its own viewer claims, and leaves the owner's work running.
      await proxy.dispose();
    },
  };
}
