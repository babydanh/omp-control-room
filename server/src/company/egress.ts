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

/** Server messages that carry company-private state. */
const COMPANY_PRIVATE_TYPES: ReadonlySet<string> = new Set([
  'companySnapshot',
  'companyStateChanged',
  'companyCommandResult',
  'companyTextDelta',
  'companySessionLog',
  'companyModelCatalog',
  'companyArtifactPage',
  'companyFileList',
  'companyFileRead',
  'companyAttachmentUploaded',
  'herdrAgents',
  'herdrScreen',
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

  constructor(
    private readonly privileged: boolean,
    private readonly currentTerminalLeases: Map<string, string> = new Map(),
  ) {}

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
    if (COMPANY_PRIVATE_TYPES.has(type)) {
      return this.privileged;
    }
    // Legacy office traffic: an observer keeps seeing the office it always saw.
    return true;
  }
}
