import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CompanyClientGate } from '../src/company/egress.js';

const LEGACY_AGENT_MESSAGE = { type: 'agentCreated', id: 1 };

function companyMessage(type: string, extra: Record<string, unknown> = {}) {
  return { type, requestId: randomUUID(), ...extra };
}

function terminalMessage(type: string, sessionId: string) {
  return { type, sessionId, runEpoch: 1, seq: 0, data: '' };
}

describe('company egress gate', () => {
  it('withholds every company-private message from an unprivileged socket', () => {
    const gate = new CompanyClientGate(false);

    for (const type of [
      'companySnapshot',
      'companyStateChanged',
      'companyCommandResult',
      'companyTextDelta',
      'companySessionLog',
      'companySessionInfo',
      'companyModelCatalog',
      'companyArtifactPage',
      'companyFileList',
      'companyFileRead',
      'companyAttachmentUploaded',
      'herdrAgents',
      'herdrScreen',
      'herdrInfo',
      'terminalAttached',
      'terminalData',
    ]) {
      expect(gate.allowsDelivery(companyMessage(type))).toBe(false);
    }
  });

  it('still delivers the legacy office to an unprivileged socket', () => {
    const gate = new CompanyClientGate(false);

    expect(gate.allowsDelivery(LEGACY_AGENT_MESSAGE)).toBe(true);
    expect(gate.allowsDelivery({ type: 'layoutLoaded', layout: {} })).toBe(true);
  });

  it('delivers company state to a privileged socket but gates terminal frames per session', () => {
    const sessionId = randomUUID();
    const otherSessionId = randomUUID();
    const gate = new CompanyClientGate(true);

    expect(gate.allowsDelivery(companyMessage('companySnapshot'))).toBe(true);
    // Not attached yet: the socket has no business receiving terminal frames.
    expect(gate.allowsDelivery(terminalMessage('terminalData', sessionId))).toBe(false);
    expect(gate.allowsDelivery({ type: 'terminalAttached', sessionId })).toBe(false);

    const leaseId = randomUUID();
    gate.observeOutbound({
      type: 'terminalAttached',
      sessionId,
      runEpoch: 1,
      leaseId,
      requestId: randomUUID(),
      cols: 120,
      rows: 32,
    });

    expect(gate.allowsDelivery({ type: 'terminalAttached', sessionId })).toBe(true);
    expect(gate.allowsDelivery(terminalMessage('terminalData', sessionId))).toBe(true);
    expect(gate.allowsDelivery(terminalMessage('terminalSnapshot', sessionId))).toBe(true);
    expect(gate.allowsDelivery(terminalMessage('terminalClosed', sessionId))).toBe(true);
    // Another session's frames stay with its own attachment.
    expect(gate.allowsDelivery(terminalMessage('terminalData', otherSessionId))).toBe(false);
  });

  it('stops delivering terminal frames once the socket detaches', () => {
    const sessionId = randomUUID();
    const gate = new CompanyClientGate(true);
    gate.observeOutbound({
      type: 'terminalAttached',
      sessionId,
      runEpoch: 1,
      leaseId: randomUUID(),
      requestId: randomUUID(),
      cols: 80,
      rows: 24,
    });

    gate.release(sessionId);
    expect(gate.allowsDelivery(terminalMessage('terminalData', sessionId))).toBe(false);
  });

  it('revokes terminal output access from the previous controller after a takeover', () => {
    const sessionId = randomUUID();
    const currentLeases = new Map<string, string>();
    const first = new CompanyClientGate(true, currentLeases);
    const second = new CompanyClientGate(true, currentLeases);
    const leaseOne = randomUUID();
    const leaseTwo = randomUUID();

    first.observeOutbound({ type: 'terminalAttached', sessionId, leaseId: leaseOne });
    expect(first.allowsDelivery(terminalMessage('terminalData', sessionId))).toBe(true);

    second.observeOutbound({ type: 'terminalAttached', sessionId, leaseId: leaseTwo });

    expect(first.allowsDelivery(terminalMessage('terminalData', sessionId))).toBe(false);
    expect(second.allowsDelivery(terminalMessage('terminalData', sessionId))).toBe(true);
    first.release(sessionId, leaseOne);
    expect(second.allowsDelivery(terminalMessage('terminalData', sessionId))).toBe(true);
    second.release(sessionId, leaseTwo);
    expect(second.allowsDelivery(terminalMessage('terminalData', sessionId))).toBe(false);
  });

  it('does not grant a terminal lease to a socket that closed during attach', () => {
    const sessionId = randomUUID();
    const currentLeases = new Map<string, string>();
    const gate = new CompanyClientGate(true, currentLeases);
    gate.dispose();

    gate.observeOutbound({
      type: 'terminalAttached',
      sessionId,
      leaseId: randomUUID(),
    });

    expect(gate.isAttached(sessionId)).toBe(false);
    expect(currentLeases.size).toBe(0);
  });

  it('ignores a malformed message rather than granting access', () => {
    const gate = new CompanyClientGate(false);

    expect(gate.allowsDelivery({})).toBe(true); // legacy path owns it
    expect(gate.allowsDelivery({ type: 42 })).toBe(true);
    expect(gate.allowsDelivery({ type: 'terminalData', sessionId: 7 })).toBe(false);
  });
});
