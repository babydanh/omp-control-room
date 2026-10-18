/**
 * workspaceRegistry: every Company folder this server has open, and which one
 * the board is showing.
 *
 * One process holds several folders at once. Each is its own
 * `WorkspaceCompanyHost` with its own namespace, runtime, sessions and
 * Contracts. Exactly one is ACTIVE: its messages reach the board and company
 * commands are answered by it. The others keep running in the background, and
 * because their state is durable, switching back pushes a fresh snapshot rather
 * than replaying what the board missed.
 *
 * Opens are serialised. Opening a folder can take seconds, and the user's last
 * request must be the one left active, so requests land in the order they came.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  CompanySnapshot,
  CompanyWorkspaceEntry,
  ServerMessage,
} from '../../../core/src/messages.js';
import { toPathKey } from '../pathKey.js';
import type { CompanyCommandServices, CompanyWorkspaceControl } from './clientCommands.js';
import { CompanyError } from './companyError.js';
import { COMPANY_HOST_TERMINAL_MESSAGE_TYPES } from './companyFollowerProxy.js';
import { canonicalizeWorkspace } from './companyStore.js';
import type { WorkspaceCompanyHost, WorkspaceCompanyHostOptions } from './workspaceCompanyHost.js';

/** Quiet window before recounting work: a burst of frames collapses into one check. */
export const COMPANY_WORKSPACE_COUNT_DEBOUNCE_MS = 250;

/**
 * Request id on the snapshot pushed to every privileged client when the active
 * folder changes. No client request produced it, so it is a fixed sentinel.
 */
export const COMPANY_WORKSPACE_PUSH_REQUEST_ID = '00000000-0000-4000-8000-000000000000';

/** Session statuses that count as work in progress. */
const WORKING_SESSION_STATUSES: Readonly<Record<string, true>> = { starting: true, busy: true };

/** How much work a folder is doing, and how much is waiting on the user. */
export interface CompanyWorkCounts {
  working: number;
  waiting: number;
}

/**
 * Count one folder's work from its snapshot. `waiting` adds three kinds that
 * can overlap (a session waiting on input may also hold a pending question), so
 * it counts items, not distinct blockers.
 */
export function countCompanyWork(snapshot: CompanySnapshot): CompanyWorkCounts {
  let working = 0;
  let waiting = 0;
  for (const session of snapshot.sessions) {
    if (WORKING_SESSION_STATUSES[session.status] === true) working += 1;
    else if (session.status === 'waiting_input') waiting += 1;
  }
  waiting += snapshot.questions.filter((question) => question.status === 'pending').length;
  waiting += snapshot.contracts.filter(
    (contract) => contract.status === 'awaiting_approval',
  ).length;
  return { working, waiting };
}

/**
 * Whether a frame can change a folder's work counts. Text deltas, session logs
 * and terminal frames stream constantly and never move a session's status, so
 * they do not schedule a recount.
 */
function changesWorkCounts(message: ServerMessage): boolean {
  return (
    message.type !== 'companyTextDelta' &&
    message.type !== 'companySessionLog' &&
    COMPANY_HOST_TERMINAL_MESSAGE_TYPES[message.type] !== true
  );
}

/** Work counts for one folder; a host that cannot answer yet counts as idle rather than failing the list. */
function workOf(host: WorkspaceCompanyHost): CompanyWorkCounts {
  try {
    return countCompanyWork(host.services.coordinator.snapshot());
  } catch {
    return { working: 0, waiting: 0 };
  }
}

/** Options for {@link CompanyWorkspaceRegistry}. */
export interface CompanyWorkspaceRegistryOptions {
  /** Process-level sink: the active folder's messages and the folder list reach the board here. */
  readonly broadcast: (message: ServerMessage) => void;
  /** Opens one folder's host. Production passes `openWorkspaceCompany`. */
  readonly openHost: (options: WorkspaceCompanyHostOptions) => Promise<WorkspaceCompanyHost>;
  /** Options every folder shares, such as the bundled helper paths. */
  readonly hostDefaults: Omit<WorkspaceCompanyHostOptions, 'workspacePath' | 'onMessage'>;
  /** Persisted recently used folders, newest first, and a way to record one. */
  readonly recents: {
    read(): string[];
    remember(workspacePath: string): void;
  };
  /** Overrides the recount window; production uses the default. */
  readonly countDebounceMs?: number;
}

interface OpenFolder {
  readonly key: string;
  readonly path: string;
  readonly host: WorkspaceCompanyHost;
}

interface ResolvedFolder {
  readonly key: string;
  readonly path: string;
}

/** Holds the open Company folders of one server and routes company traffic to the active one. */
export class CompanyWorkspaceRegistry implements CompanyWorkspaceControl {
  /** Open folders keyed by workspace key, in the order they were opened. */
  private readonly folders = new Map<string, OpenFolder>();
  private recentPaths: string[];
  private activeKey: string | null = null;
  /** Each open waits for the previous one, so the last request the user made is the one left active. */
  private queue: Promise<void> = Promise.resolve();
  private recountTimer: NodeJS.Timeout | undefined;
  /** The folder list last broadcast, serialised, so unchanged lists are not resent. */
  private lastPublished: string | null = null;
  private disposed = false;
  private disposing: Promise<void> | null = null;

  constructor(private readonly options: CompanyWorkspaceRegistryOptions) {
    this.recentPaths = options.recents.read();
  }

  /** Services of the active folder, or `null` when none is active or the server is shutting down. */
  activeServices(): CompanyCommandServices | null {
    if (this.disposed || this.activeKey === null) return null;
    return this.folders.get(this.activeKey)?.host.services ?? null;
  }

  /** Folders for the board: open ones in open order, then recently used ones that are not open. */
  entries(): CompanyWorkspaceEntry[] {
    const openKeys = new Set<string>();
    const openEntries: CompanyWorkspaceEntry[] = [];
    for (const folder of this.folders.values()) {
      openKeys.add(toPathKey(folder.path));
      const work = workOf(folder.host);
      openEntries.push({
        path: folder.path,
        active: folder.key === this.activeKey,
        open: true,
        working: work.working,
        waiting: work.waiting,
      });
    }
    const recentEntries: CompanyWorkspaceEntry[] = this.recentPaths
      .filter((recent) => !openKeys.has(toPathKey(recent)))
      .map((recent) => ({ path: recent, active: false, open: false, working: 0, waiting: 0 }));
    return [...openEntries, ...recentEntries];
  }

  open(workspacePath: string): Promise<void> {
    const run = this.queue.then(() => this.openAndActivate(workspacePath));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Stop every folder's host. Idempotent; an open still in flight disposes its own host when it lands. */
  dispose(): Promise<void> {
    if (this.disposing === null) {
      this.disposed = true;
      clearTimeout(this.recountTimer);
      this.recountTimer = undefined;
      const hosts = [...this.folders.values()];
      this.folders.clear();
      this.activeKey = null;
      this.disposing = Promise.allSettled(hosts.map((folder) => folder.host.dispose())).then(
        (results) => {
          const failure = results.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
          );
          if (failure !== undefined) throw failure.reason;
        },
      );
    }
    return this.disposing;
  }

  private async openAndActivate(workspacePath: string): Promise<void> {
    this.assertRunning();
    const target = await resolveFolder(workspacePath);
    const folder = this.folders.get(target.key) ?? (await this.openFolder(target));
    this.assertRunning();
    this.options.recents.remember(folder.path);
    this.recentPaths = this.options.recents.read();
    this.activate(folder);
  }

  private async openFolder(target: ResolvedFolder): Promise<OpenFolder> {
    let host: WorkspaceCompanyHost;
    try {
      host = await this.options.openHost({
        ...this.options.hostDefaults,
        workspacePath: target.path,
        onMessage: (message) => this.receive(target.key, message),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CompanyError(
        'workspace_open_failed',
        `Không mở được thư mục công ty: ${target.path}. ${reason}`,
        { cause: error },
      );
    }
    if (this.disposed) {
      await host.dispose().catch(() => undefined);
      throw unavailable();
    }
    const folder: OpenFolder = { key: target.key, path: target.path, host };
    this.folders.set(target.key, folder);
    return folder;
  }

  /** Make a folder the active one: publish the new list, then push its snapshot to every privileged client. */
  private activate(folder: OpenFolder): void {
    const snapshot = folder.host.services.coordinator.snapshot();
    this.activeKey = folder.key;
    this.publishWorkspaces();
    this.options.broadcast({
      type: 'companySnapshot',
      requestId: COMPANY_WORKSPACE_PUSH_REQUEST_ID,
      snapshot,
    });
  }

  /** Route one folder's message: only the active folder reaches the board, every folder may change the counts. */
  private receive(key: string, message: ServerMessage): void {
    if (this.disposed) return;
    if (key === this.activeKey) this.options.broadcast(message);
    if (changesWorkCounts(message)) this.scheduleRecount();
  }

  /** Coalesce count checks: the first frame starts the window, later frames inside it ride along. */
  private scheduleRecount(): void {
    if (this.recountTimer !== undefined) return;
    this.recountTimer = setTimeout(() => {
      this.recountTimer = undefined;
      if (!this.disposed) this.publishWorkspaces();
    }, this.options.countDebounceMs ?? COMPANY_WORKSPACE_COUNT_DEBOUNCE_MS);
    this.recountTimer.unref?.();
  }

  /** Broadcast the folder list only when it differs from the last one sent. */
  private publishWorkspaces(): void {
    const workspaces = this.entries();
    const serialized = JSON.stringify(workspaces);
    if (serialized === this.lastPublished) return;
    this.lastPublished = serialized;
    this.options.broadcast({ type: 'companyWorkspaces', workspaces });
  }

  private assertRunning(): void {
    if (this.disposed) throw unavailable();
  }
}

function unavailable(): CompanyError {
  return new CompanyError('company_unavailable', 'Máy chủ đang tắt, không mở thêm thư mục.');
}

function workspaceRefused(message: string, cause?: unknown): CompanyError {
  return new CompanyError(
    'workspace_invalid',
    message,
    cause === undefined ? undefined : { cause },
  );
}

/** Validate a typed folder path: it must exist, be a directory, and resolve to one identity. */
async function resolveFolder(input: string): Promise<ResolvedFolder> {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw workspaceRefused('Cần chọn một thư mục để mở.');
  const requested = path.resolve(trimmed);
  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(requested);
  } catch (error) {
    throw workspaceRefused(`Không tìm thấy thư mục: ${requested}`, error);
  }
  if (!stats.isDirectory()) {
    throw workspaceRefused(`Đường dẫn không phải là thư mục: ${requested}`);
  }
  try {
    const canonical = await canonicalizeWorkspace(requested);
    return { key: canonical.key, path: canonical.realPath };
  } catch (error) {
    throw workspaceRefused(`Không mở được thư mục: ${requested}`, error);
  }
}
