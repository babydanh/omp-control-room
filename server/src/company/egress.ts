/**
 * Company egress gate: what one connected socket is allowed to receive.
 *
 * Authorization is decided per connection, and it has to be enforced in BOTH
 * directions. The dispatcher refuses unprivileged commands (ingress); this gate
 * refuses to hand private state to an unprivileged subscriber (egress). A
 * socket that may watch the office must not also receive company snapshots,
 * prompts, quota data or terminal frames -- an ingress-only check would leak
 * everything through the broadcast path.
 *
 * Terminal traffic is narrower still: it reaches only the socket that holds
 * that session's current controller lease, so two viewers of the same company
 * never see each other's keystrokes or output.
 *
 * Messages are taken as wire records (`Record<string, unknown>`) because that
 * is what both the store broadcast and the socket layer actually carry; every
 * field is narrowed at runtime rather than trusted.
 */

import { toPathKey } from '../pathKey.js';

/** Which folders a socket's company views cover: the active one, or every open one. */
export type CompanyViewMode = 'all' | 'folder';

/** Where the gate learns the active folder; a process without a folder registry has none. */
export interface CompanyViewSource {
  activePath(): string | null;
}

const NO_COMPANY_VIEW: CompanyViewSource = { activePath: () => null };

/** Server messages that carry company-private state. */
const COMPANY_PRIVATE_TYPES: ReadonlySet<string> = new Set([
  'companySnapshot',
  'companyStateChanged',
  'companyWorkItems',
  'companySquad',
  'companyCommandResult',
  'companyTextDelta',
  'companySessionLog',
  'companySessionInfo',
  'companyModelCatalog',
  'companyWorkspaces',
  'companyOmpSessions',
  'companyArtifactPage',
  'companyFileList',
  'companyFolderBrowse',
  'companyFileRead',
  'companyAttachmentUploaded',
  'herdrAgents',
  'herdrScreen',
  'herdrInfo',
  'browserReaperStatus',
  'usageLimits',
  'usageHistory',
  'usageStats',
]);

/** Server messages bound to exactly one attached session. */
const TERMINAL_SESSION_TYPES: ReadonlySet<string> = new Set([
  'terminalAttached',
  'terminalData',
  'terminalSnapshot',
  'terminalClosed',
]);

function stringOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export class CompanyClientGate {
  private readonly terminalLeases = new Map<string, string>();
  private disposed = false;
  private viewMode: CompanyViewMode = 'folder';

  constructor(
    private readonly privileged: boolean,
    private readonly currentTerminalLeases: Map<string, string> = new Map(),
    private readonly companyView: CompanyViewSource = NO_COMPANY_VIEW,
  ) {}

  /** Which folders this socket's company views cover; a socket that never chose one sees the active folder. */
  get companyViewMode(): CompanyViewMode {
    return this.viewMode;
  }

  /** Switch the company view: `all` admits every open folder, `folder` only the active one. */
  setCompanyView(mode: CompanyViewMode): void {
    this.viewMode = mode;
  }

  /** True when this socket may receive any company-private message. */
  get isPrivileged(): boolean {
    return this.privileged;
  }

  /** Whether this socket holds the current lease for a session's terminal. */
  isAttached(sessionId: string, leaseId?: string): boolean {
    const held = this.terminalLeases.get(sessionId);
    if (held === undefined || this.currentTerminalLeases.get(sessionId) !== held) return false;
    return leaseId === undefined || held === leaseId;
  }

  /**
   * Record what the server just sent to this socket. An attach reply grants the
   * lease, so the gate tracks attachments without the PTY owner needing to know
   * that sockets exist.
   */
  observeOutbound(message: Record<string, unknown>): void {
    if (message.type !== 'terminalAttached') return;
    const sessionId = stringOf(message.sessionId);
    const leaseId = stringOf(message.leaseId);
    if (sessionId && leaseId) this.grant(sessionId, leaseId);
  }

  /** Grant egress ownership before the attach reply can race with PTY output. */
  grant(sessionId: string, leaseId: string): void {
    if (this.disposed || !sessionId || !leaseId) return;
    this.terminalLeases.set(sessionId, leaseId);
    this.currentTerminalLeases.set(sessionId, leaseId);
  }

  release(sessionId: string, leaseId?: string): void {
    const held = this.terminalLeases.get(sessionId);
    if (held === undefined || (leaseId !== undefined && held !== leaseId)) return;
    this.terminalLeases.delete(sessionId);
    if (this.currentTerminalLeases.get(sessionId) === held) {
      this.currentTerminalLeases.delete(sessionId);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [sessionId, leaseId] of this.terminalLeases) this.release(sessionId, leaseId);
  }

  /** True when this socket may receive `message`. */
  allowsDelivery(message: Record<string, unknown>): boolean {
    const type = stringOf(message.type);
    if (type === null) return true; // unidentifiable: legacy path owns it
    if (TERMINAL_SESSION_TYPES.has(type)) {
      if (!this.privileged) return false;
      const sessionId = stringOf(message.sessionId);
      return sessionId !== null && this.isAttached(sessionId);
    }
    const workspacePath = stringOf(message.workspacePath);
    if (workspacePath !== null) {
      // A folder-tagged message is that folder's company state, whatever its type.
      return this.privileged && this.showsFolder(workspacePath);
    }
    if (COMPANY_PRIVATE_TYPES.has(type)) {
      return this.privileged;
    }
    // Legacy office traffic: an observer keeps seeing the office it always saw.
    return true;
  }

  /** Whether the current company view covers the folder at `workspacePath`. */
  private showsFolder(workspacePath: string): boolean {
    if (this.viewMode === 'all') return true;
    const active = this.companyView.activePath();
    return active !== null && toPathKey(active) === toPathKey(workspacePath);
  }
}
