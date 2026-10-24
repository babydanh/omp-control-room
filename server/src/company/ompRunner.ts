import type { RoleProfile } from '../../../core/src/company.js';
import { CompanyError } from './companyError.js';
import {
  COMPANY_DEFAULT_TERMINAL_COLS,
  COMPANY_DEFAULT_TERMINAL_ROWS,
  COMPANY_TERMINAL_NAME,
} from './constants.js';
import {
  createOmpBridge,
  type OmpBridgeEvent,
  type OmpBridgeHandle,
  type OmpBridgeModelCatalog,
  type OmpBridgeOptions,
  type OmpBridgeRpcHandler,
  type OmpBridgeSendPrompt,
  type OmpBridgeSessionDescription,
} from './ompBridge.js';
import type { PtyClient } from './ptyClient.js';
import type { PtyHostEvent, PtySpawnIdentity, PtySpawnSpec } from './ptyHost.js';

/**
 * herdr's own variables (HERDR_*) describe the user's herdr session, not the company agent,
 * so the company child never inherits them. Environment names are case-insensitive on Windows.
 */
const HERDR_ENV_PATTERN = /^HERDR_/i;

export type OmpRunnerState = 'new' | 'starting' | 'running' | 'exited' | 'failed' | 'disposed';

export type OmpRunnerEvent =
  | { readonly kind: 'native'; readonly event: OmpBridgeEvent }
  | { readonly kind: 'terminal_data'; readonly data: string }
  | { readonly kind: 'exit'; readonly exitCode: number; readonly signal?: number };

export type OmpRunnerEventHandler = (event: OmpRunnerEvent) => void;

export interface OmpRunnerCommand {
  /** Native Node executable; never a shell command. */
  readonly file: string;
  /** Trusted executable/module arguments, excluding OMP session flags. */
  readonly args: readonly string[];
}

export interface OmpRunnerStartInput {
  readonly sessionId: string;
  readonly runEpoch: number;
  readonly roleProfile: RoleProfile;
  readonly workspaceRoot: string;
  /** Omit to let omp keep the session in its own default directory for the workspace. */
  readonly sessionDirectory?: string;
  readonly nativeSessionId?: string;
  /** A session file to resume exactly (`omp --resume <file>`), used when the board reopens a session. */
  readonly resumeFile?: string;
  /**
   * True when no one watches the run's terminal (every board run but the user's own chat). omp then
   * asks no approval, since an unanswered dialog stalls the run forever; the board's tool gate
   * still decides every call by the role's policy.
   */
  readonly unattended?: boolean;
  /** Omitted when the run starts idle (capability discovery), so no turn is spent. */
  readonly initialPrompt?: OmpBridgeSendPrompt;
  readonly rpcHandler: OmpBridgeRpcHandler;
}

export interface OmpRunnerOptions {
  readonly ptyClient: Pick<PtyClient, 'spawnPty' | 'kill' | 'onEvent'>;
  readonly command: OmpRunnerCommand;
  readonly extensionPath: string;
  /** Inherited native OMP environment; bridge credentials always override it. */
  readonly environment?: NodeJS.ProcessEnv;
  /** Test seam; production defaults to the authenticated local bridge. */
  readonly createBridge?: (options: OmpBridgeOptions) => OmpBridgeHandle;
}

/**
 * Owns exactly one OMP process generation. The PTY helper owns the process;
 * this object owns its run identity, bridge, and subscriptions.
 */
export class OmpRunner {
  private currentState: OmpRunnerState = 'new';
  private runEpoch: number | null = null;
  private ptySessionId: string | null = null;
  private ptyStarted = false;
  private bridge: OmpBridgeHandle | null = null;
  private bridgeDisposed = false;
  private readonly listeners = new Set<OmpRunnerEventHandler>();
  private unsubscribePty: (() => void) | null = null;
  private unsubscribeBridge: (() => void) | null = null;
  private processIdentity: PtySpawnIdentity | null = null;

  constructor(private readonly options: OmpRunnerOptions) {}

  get state(): OmpRunnerState {
    return this.currentState;
  }

  /**
   * The pid and image the PTY helper reported for the process this run owns,
   * or null before the spawn has answered. The supervisor needs it to prove
   * lineage before it signals anything, so it is captured from the spawn
   * reply rather than assumed from the executable we asked for.
   */
  get identity(): PtySpawnIdentity | null {
    return this.processIdentity;
  }

  onEvent(handler: OmpRunnerEventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  async start(input: OmpRunnerStartInput): Promise<void> {
    if (this.currentState !== 'new') {
      throw new CompanyError('omp_runner_already_started', 'an OMP runner can start only once');
    }
    if (input.runEpoch < 0 || !Number.isSafeInteger(input.runEpoch)) {
      throw new CompanyError(
        'omp_runner_bad_epoch',
        'the OMP run epoch must be a non-negative safe integer',
      );
    }
    if (
      input.sessionId.trim() === '' ||
      input.roleProfile.requestedModel.trim() === '' ||
      input.roleProfile.thinking.trim() === '' ||
      (input.nativeSessionId !== undefined && input.nativeSessionId.trim() === '')
    ) {
      throw new CompanyError(
        'omp_runner_bad_identity',
        'the OMP run needs a session, model, and thinking profile',
      );
    }

    this.currentState = 'starting';
    this.runEpoch = input.runEpoch;
    this.ptySessionId = `${input.sessionId}:${input.runEpoch}`;
    try {
      const createBridge = this.options.createBridge ?? createOmpBridge;
      this.bridge = createBridge({
        sessionId: input.sessionId,
        runEpoch: input.runEpoch,
        role: input.roleProfile.role,
        rpcHandler: input.rpcHandler,
      });
      this.unsubscribeBridge = this.bridge.onEvent((event) => this.emit({ kind: 'native', event }));
      this.unsubscribePty = this.options.ptyClient.onEvent((event) => this.handlePtyEvent(event));

      this.processIdentity = await this.options.ptyClient.spawnPty(
        this.ptySessionId,
        this.spawnSpec(input),
      );
      this.ptyStarted = true;
      await this.bridge.ready;
      if (this.currentState !== 'starting') {
        throw new CompanyError(
          'omp_runner_exited_during_start',
          'the OMP process exited before its run became ready',
        );
      }
      this.currentState = 'running';
      // A run may start idle: nothing is sent, so no model turn is spent.
      if (input.initialPrompt !== undefined) {
        await this.bridge.sendPrompt(input.initialPrompt);
      }
    } catch (error) {
      this.markFailedUnlessDisposed();
      await this.cleanupAfterFailure();
      throw error;
    }
  }

  async sendPrompt(runEpoch: number, prompt: OmpBridgeSendPrompt): Promise<void> {
    this.assertActiveEpoch(runEpoch);
    await this.requireBridge().sendPrompt(prompt);
  }

  async abort(runEpoch: number): Promise<void> {
    this.assertActiveEpoch(runEpoch);
    await this.requireBridge().abort();
  }

  /**
   * Reads the authenticated model catalog from the live OMP process.
   *
   * Fail-closed twice: a stale epoch or a stopped run is refused before the
   * bridge is touched, and the answer is handed back exactly as the runtime
   * stamped it. Nothing is cached, because only a running process knows which
   * models its own credentials expose, and that set changes while it runs.
   */
  async requestModelCatalog(runEpoch: number): Promise<OmpBridgeModelCatalog> {
    this.assertActiveEpoch(runEpoch);
    return this.requireBridge().requestModelCatalog();
  }

  /**
   * Reads what the live native session has loaded. Same fail-closed rules as the
   * catalog read: a stale epoch or a stopped run is refused before the bridge is
   * touched, and the answer is handed back exactly as the bridge validated it.
   */
  async requestSessionInfo(runEpoch: number): Promise<OmpBridgeSessionDescription> {
    this.assertActiveEpoch(runEpoch);
    return this.requireBridge().requestSessionInfo();
  }

  async dispose(): Promise<void> {
    if (this.currentState === 'disposed') return;
    this.currentState = 'disposed';
    this.unsubscribePty?.();
    this.unsubscribePty = null;
    this.unsubscribeBridge?.();
    this.unsubscribeBridge = null;

    const cleanups: Promise<unknown>[] = [];
    if (this.ptyStarted && this.ptySessionId !== null) {
      this.ptyStarted = false;
      cleanups.push(this.options.ptyClient.kill(this.ptySessionId));
    }
    if (this.bridge !== null && !this.bridgeDisposed) {
      this.bridgeDisposed = true;
      cleanups.push(this.bridge.dispose());
    }
    const results = await Promise.allSettled(cleanups);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) throw failure.reason;
  }

  private markFailedUnlessDisposed(): void {
    if (this.currentState !== 'disposed') this.currentState = 'failed';
  }

  private spawnSpec(input: OmpRunnerStartInput): PtySpawnSpec {
    const args = buildOmpRunnerArgs({
      commandArgs: this.options.command.args,
      extensionPath: this.options.extensionPath,
      roleProfile: input.roleProfile,
      ...(input.sessionDirectory === undefined ? {} : { sessionDirectory: input.sessionDirectory }),
      ...(input.nativeSessionId === undefined ? {} : { nativeSessionId: input.nativeSessionId }),
      ...(input.resumeFile === undefined ? {} : { resumeFile: input.resumeFile }),
      ...(input.unattended === true ? { unattended: true } : {}),
    });
    const env = Object.fromEntries(
      Object.entries(this.options.environment ?? process.env).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && !HERDR_ENV_PATTERN.test(entry[0]),
      ),
    );
    Object.assign(env, this.bridge?.childEnv, { TERM: COMPANY_TERMINAL_NAME });

    return {
      file: this.options.command.file,
      args,
      cwd: input.workspaceRoot,
      env,
      cols: COMPANY_DEFAULT_TERMINAL_COLS,
      rows: COMPANY_DEFAULT_TERMINAL_ROWS,
      term: COMPANY_TERMINAL_NAME,
    };
  }

  private handlePtyEvent(event: PtyHostEvent): void {
    if (event.sessionId !== this.ptySessionId) return;
    if (event.type === 'data') {
      this.emit({ kind: 'terminal_data', data: event.data });
      return;
    }

    this.ptyStarted = false;
    this.processIdentity = null;
    // The process is gone, so nothing may be sent to it again. Setting the
    // state BEFORE the bridge is disposed is what makes a catalog read refuse
    // with omp_runner_not_running instead of reaching a dead bridge.
    if (this.currentState !== 'disposed') {
      this.currentState = 'exited';
    }
    this.emit({
      kind: 'exit',
      exitCode: event.exitCode,
      ...(event.signal === undefined ? {} : { signal: event.signal }),
    });
    void this.disposeBridge().catch(() => undefined);
  }

  private assertActiveEpoch(runEpoch: number): void {
    if (this.runEpoch !== runEpoch) {
      throw new CompanyError(
        'stale_company_run_epoch',
        'the operation belongs to an older company run',
      );
    }
    if (this.currentState !== 'running') {
      throw new CompanyError(
        'omp_runner_not_running',
        'the OMP process is not accepting run operations',
      );
    }
  }

  private requireBridge(): OmpBridgeHandle {
    if (this.bridge === null || this.bridgeDisposed) {
      throw new CompanyError(
        'omp_bridge_unavailable',
        'the authenticated OMP bridge is unavailable',
      );
    }
    return this.bridge;
  }

  private async cleanupAfterFailure(): Promise<void> {
    this.unsubscribePty?.();
    this.unsubscribePty = null;
    this.unsubscribeBridge?.();
    this.unsubscribeBridge = null;
    if (this.ptyStarted && this.ptySessionId !== null) {
      this.ptyStarted = false;
      try {
        await this.options.ptyClient.kill(this.ptySessionId);
      } catch {
        // The startup failure is authoritative; still dispose the bridge below.
      }
    }
    try {
      await this.disposeBridge();
    } catch {
      // Preserve the startup failure after attempting both owned cleanups.
    }
  }

  private async disposeBridge(): Promise<void> {
    if (this.bridge === null || this.bridgeDisposed) return;
    this.bridgeDisposed = true;
    await this.bridge.dispose();
  }

  private emit(event: OmpRunnerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export function createOmpRunner(options: OmpRunnerOptions): OmpRunner {
  return new OmpRunner(options);
}

/** Compose native OMP flags without placing prompt content in argv. */
export function buildOmpRunnerArgs(input: {
  readonly commandArgs: readonly string[];
  readonly extensionPath: string;
  readonly roleProfile: RoleProfile;
  readonly sessionDirectory?: string;
  readonly nativeSessionId?: string;
  readonly resumeFile?: string;
  readonly unattended?: boolean;
}): string[] {
  // The user's own chat keeps omp's default approval mode. A run nobody watches asks for no
  // approval: the board's tool gate decides its calls. Any other run stops exec on approval.
  const approval =
    input.unattended === true
      ? ['--approval-mode', 'yolo']
      : input.roleProfile.toolsPolicy === 'omp'
        ? []
        : ['--approval-mode', 'write'];
  const resume = input.resumeFile ?? input.nativeSessionId;
  return [
    ...input.commandArgs,
    '--extension',
    input.extensionPath,
    '--model',
    input.roleProfile.requestedModel,
    '--thinking',
    input.roleProfile.thinking,
    ...approval,
    ...(input.sessionDirectory === undefined ? [] : ['--session-dir', input.sessionDirectory]),
    ...(resume ? ['--resume', resume] : []),
  ];
}
