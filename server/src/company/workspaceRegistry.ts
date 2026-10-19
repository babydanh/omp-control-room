/**
 * workspaceRegistry: every Company folder this server has open, and which one
 * the board is showing.
 *
 * One process holds several folders at once. Each is its own
 * `WorkspaceCompanyHost` with its own namespace, runtime, sessions and
 * Contracts. Exactly one is ACTIVE: the folder a `folder` view shows, and the one
 * unnamed company commands answer. Every folder's board messages carry its path, so
 * an `all` view shows them side by side. The others keep running in the background, and
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
  CompanyWorkspaceSession,
  ServerMessage,
} from '../../../core/src/messages.js';
import { companyFolderNameFor } from '../configPersistence.js';
import { toPathKey } from '../pathKey.js';
import type { CompanyCommandServices, CompanyWorkspaceControl } from './clientCommands.js';
import { CompanyError } from './companyError.js';
import { COMPANY_HOST_TERMINAL_MESSAGE_TYPES } from './companyFollowerProxy.js';
import { canonicalizeWorkspace } from './companyStore.js';
import type { WorkspaceCompanyHost, WorkspaceCompanyHostOptions } from './workspaceCompanyHost.js';

/** Quiet window before recounting work: a burst of frames collapses into one check. */
export const COMPANY_WORKSPACE_COUNT_DEBOUNCE_MS = 250;

/** How often the list re-checks that its folders are still on disk, so a folder removed while open shows at once. */
export const COMPANY_WORKSPACE_PRESENCE_CHECK_MS = 5000;

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

/** Work counts for a folder that cannot answer yet: it counts as idle rather than failing the list. */
const IDLE_WORK: CompanyWorkCounts = { working: 0, waiting: 0 };

/** The host's snapshot, or null while it cannot answer yet. */
function snapshotOf(host: WorkspaceCompanyHost): CompanySnapshot | null {
  try {
    return host.services.coordinator.snapshot();
  } catch {
    return null;
  }
}

/** Whether a folder is on disk now. A path that cannot be read, or is a file, is not a folder. */
function folderOnDisk(workspacePath: string): boolean {
  try {
    return fs.statSync(workspacePath).isDirectory();
  } catch {
    return false;
  }
}

/** The most sessions one folder lists in the board's tree; the wire contract allows the same. */
export const COMPANY_WORKSPACE_SESSION_LIMIT = 100;

/** Where a session sorts in its folder's list: what waits on the user, then what is working, then the rest. */
function sessionListRank(status: string): number {
  if (status === 'waiting_input') return 0;
  if (WORKING_SESSION_STATUSES[status] === true) return 1;
  return 2;
}

/**
 * One folder's sessions for the board's tree: its live ones (archived sessions are left out),
 * ordered by {@link sessionListRank} and then by code, capped at {@link COMPANY_WORKSPACE_SESSION_LIMIT}.
 */
export function companyWorkspaceSessions(snapshot: CompanySnapshot): CompanyWorkspaceSession[] {
  return snapshot.sessions
    .filter((session) => session.status !== 'archived')
    .sort(
      (left, right) =>
        sessionListRank(left.status) - sessionListRank(right.status) ||
        left.code.localeCompare(right.code, 'en', { numeric: true }) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, COMPANY_WORKSPACE_SESSION_LIMIT)
    .map((session) => ({
      id: session.id,
      code: session.code,
      name: session.name,
      role: session.role,
      status: session.status,
    }));
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
    /** Take a folder off the recent list. Returns whether the change reached the disk. */
    forget(workspacePath: string): boolean;
  };
  /**
   * Display names of Company folders, keyed by path key. `set` stores a name (or clears it with `null`) and reports
   * whether the write reached the disk.
   */
  readonly names: {
    read(): Record<string, string>;
    set(workspacePath: string, name: string | null): boolean;
  };
  /** Overrides the recount window; production uses the default. */
  readonly countDebounceMs?: number;
  /**
   * Whether a folder is on disk now. A folder that is not is left out of the list: a recent one is dropped, and an
   * open one is flagged `missing`. Production asks the file system; tests pass a fake.
   */
  readonly folderExists?: (workspacePath: string) => boolean;
  /**
   * Called with the open folders' paths whenever the set of open folders changes, before the list is broadcast.
   * Production uses it to re-tag herdr and ledger items against the folders as they now stand.
   */
  readonly onFoldersChanged?: (openPaths: readonly string[]) => void;
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
  private presenceTimer: NodeJS.Timeout | undefined;
  private readonly folderExists: (workspacePath: string) => boolean;
  /** The folder list last broadcast, serialised, so unchanged lists are not resent. */
  private lastPublished: string | null = null;
  private lastOpenPaths: string | null = null;
  private disposed = false;
  private disposing: Promise<void> | null = null;

  constructor(private readonly options: CompanyWorkspaceRegistryOptions) {
    this.recentPaths = options.recents.read();
    this.folderExists = options.folderExists ?? folderOnDisk;
    // Re-check the folders on a timer, so a folder removed while open shows as missing without waiting for work.
    this.presenceTimer = setInterval(
      () => this.publishWorkspaces(),
      COMPANY_WORKSPACE_PRESENCE_CHECK_MS,
    );
    this.presenceTimer.unref?.();
  }

  /** Services of the active folder, or `null` when none is active or the server is shutting down. */
  activeServices(): CompanyCommandServices | null {
    if (this.disposed || this.activeKey === null) return null;
    return this.folders.get(this.activeKey)?.host.services ?? null;
  }

  /** Path of the active folder, or `null` when none is active or the server is shutting down. */
  activePath(): string | null {
    if (this.disposed || this.activeKey === null) return null;
    return this.folders.get(this.activeKey)?.path ?? null;
  }

  /** Services of the open folder at this path, or `null` when it is not open. */
  servicesFor(workspacePath: string): CompanyCommandServices | null {
    if (this.disposed) return null;
    const key = toPathKey(workspacePath);
    for (const folder of this.folders.values()) {
      if (toPathKey(folder.path) === key) return folder.host.services;
    }
    return null;
  }

  /** Services of the first open folder, in open order, whose state holds this id; `null` when none does. */
  servicesHolding(id: string): CompanyCommandServices | null {
    if (this.disposed) return null;
    for (const folder of this.folders.values()) {
      if (folder.host.services.coordinator.holdsId(id)) return folder.host.services;
    }
    return null;
  }

  /**
   * Folders for the board: open ones in open order, then recently used ones that are not open.
   * An open folder carries its live sessions; a recent one carries none.
   */
  entries(): CompanyWorkspaceEntry[] {
    const names = this.options.names.read();
    const openKeys = new Set<string>();
    const openEntries: CompanyWorkspaceEntry[] = [];
    for (const folder of this.folders.values()) {
      openKeys.add(toPathKey(folder.path));
      const snapshot = snapshotOf(folder.host);
      const work = snapshot === null ? IDLE_WORK : countCompanyWork(snapshot);
      const name = companyFolderNameFor(names, folder.path);
      openEntries.push({
        path: folder.path,
        ...(name === undefined ? {} : { name }),
        active: folder.key === this.activeKey,
        open: true,
        working: work.working,
        waiting: work.waiting,
        // An open folder whose directory was removed stays listed once, flagged, until it is forgotten.
        ...(this.folderExists(folder.path) ? {} : { missing: true }),
        // Without a readable state the folder is listed by its counts alone, so no sessions are sent.
        ...(snapshot === null ? {} : { sessions: companyWorkspaceSessions(snapshot) }),
      });
    }
    // A recent folder that is no longer on disk is left out. Its display name stays in the names store.
    const recentEntries: CompanyWorkspaceEntry[] = this.recentPaths
      .filter((recent) => !openKeys.has(toPathKey(recent)) && this.folderExists(recent))
      .map((recent) => {
        const name = companyFolderNameFor(names, recent);
        return {
          path: recent,
          ...(name === undefined ? {} : { name }),
          active: false,
          open: false,
          working: 0,
          waiting: 0,
        };
      });
    return [...openEntries, ...recentEntries];
  }

  /**
   * Store or clear (`null`) one folder's display name, then republish the folder list so every board shows it. The
   * path is already canonical. A save that did not reach the disk is refused rather than reported as done.
   */
  setFolderName(workspacePath: string, name: string | null): void {
    this.assertRunning();
    if (!this.options.names.set(workspacePath, name)) {
      throw new CompanyError('company_command_failed', 'Không lưu được tên thư mục.');
    }
    this.publishWorkspaces();
  }

  /**
   * Remove a folder from the list: its recent entry is dropped and, when it is open, its Company is stopped. Refused
   * while that folder still has working or waiting sessions, so a list edit never stops live work. The path is taken
   * as listed rather than resolved on disk, so a folder that is already gone can still be taken off the list.
   */
  forget(workspacePath: string): Promise<void> {
    const run = this.queue.then(() => this.forgetFolder(workspacePath));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  open(workspacePath: string): Promise<void> {
    const run = this.queue.then(() => this.openAndActivate(workspacePath));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Services of the folder at this path, opening it first when it is not open. Unlike
   * {@link open}, the folder does not become the active one: the board's view stays where it was.
   */
  ensure(workspacePath: string): Promise<CompanyCommandServices> {
    const run = this.queue.then(() => this.ensureOpen(workspacePath));
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
      clearInterval(this.presenceTimer);
      this.presenceTimer = undefined;
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

  /** Open a folder for a command without making it active. A folder already open answers as it is. */
  private async ensureOpen(workspacePath: string): Promise<CompanyCommandServices> {
    this.assertRunning();
    const target = await resolveFolder(workspacePath);
    const existing = this.folders.get(target.key);
    if (existing !== undefined) return existing.host.services;
    const folder = await this.openFolder(target);
    const snapshot = folder.host.services.coordinator.snapshot();
    this.publishWorkspaces();
    this.options.broadcast({
      type: 'companySnapshot',
      requestId: COMPANY_WORKSPACE_PUSH_REQUEST_ID,
      snapshot,
      workspacePath: folder.path,
    });
    return folder.host.services;
  }

  /** Drop a folder from the list and stop its Company when it is open. The active folder then becomes none. */
  private async forgetFolder(workspacePath: string): Promise<void> {
    this.assertRunning();
    const key = toPathKey(workspacePath);
    const open = [...this.folders.values()].find((folder) => toPathKey(folder.path) === key);
    if (open !== undefined) {
      const snapshot = snapshotOf(open.host);
      const work = snapshot === null ? IDLE_WORK : countCompanyWork(snapshot);
      if (work.working > 0 || work.waiting > 0) {
        throw new CompanyError(
          'workspace_busy',
          'Thư mục này còn phiên đang chạy hoặc đang chờ bạn. Hãy xử lý xong rồi gỡ.',
        );
      }
    }
    if (!this.options.recents.forget(workspacePath)) {
      throw new CompanyError('company_command_failed', 'Không lưu được danh sách thư mục.');
    }
    this.recentPaths = this.options.recents.read();
    if (open !== undefined) {
      this.folders.delete(open.key);
      if (this.activeKey === open.key) this.activeKey = null;
    }
    this.publishWorkspaces();
    if (open !== undefined) await open.host.dispose();
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
      workspacePath: folder.path,
    });
  }

  /**
   * Route one folder's frame. Every open folder's board frames reach the board tagged with their
   * folder, and the egress gate decides who sees them. Terminal frames stay untagged, since their
   * delivery is decided by the session's lease. Every folder may change the counts.
   */
  private receive(key: string, message: ServerMessage): void {
    if (this.disposed) return;
    const folder = this.folders.get(key);
    if (folder !== undefined) {
      // Terminal frames stay untagged; every other frame carries its folder's path.
      const frame: ServerMessage & { workspacePath?: string } =
        COMPANY_HOST_TERMINAL_MESSAGE_TYPES[message.type] === true
          ? message
          : { ...message, workspacePath: folder.path };
      this.options.broadcast(frame);
    }
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
    const openPaths = workspaces.filter((entry) => entry.open).map((entry) => entry.path);
    const openKey = JSON.stringify(openPaths);
    if (openKey !== this.lastOpenPaths) {
      this.lastOpenPaths = openKey;
      this.options.onFoldersChanged?.(openPaths);
    }
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
