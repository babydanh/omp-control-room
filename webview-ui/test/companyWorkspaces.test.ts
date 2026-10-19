import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { TRANSPORT_DISCONNECTED_ERROR } from '../../core/src/messageDelivery.js';
import type { ClientMessage, CompanyWorkspaceEntry } from '../../core/src/messages.js';
import { CompanyClient } from '../src/company/companyClient.js';
import {
  applyCompanyMessage,
  type CompanyViewState,
  EMPTY_SELECTION,
  type TerminalView,
} from '../src/company/companyState.js';
import { activeWorkspace, folderLabel, workspaceActivity } from '../src/company/workspaces.js';
import type { MessageTransport } from '../src/transport/types.js';
import { session, snapshot, stateFrom } from './companyFixtures.js';

const DU_AN = 'D:\\du-an';
const KHAC = 'D:\\khac';

function folder(
  path: string,
  active: boolean,
  counts: { working?: number; waiting?: number } = {},
): CompanyWorkspaceEntry {
  return {
    path,
    active,
    open: true,
    working: counts.working ?? 0,
    waiting: counts.waiting ?? 0,
  };
}

function terminal(sessionId: string): TerminalView {
  return {
    sessionId,
    runEpoch: 1,
    attached: true,
    leaseId: 'lease-1',
    cols: null,
    rows: null,
    lastSeq: 0,
    frames: [],
    overflow: false,
    closedReason: null,
  };
}

describe('folder names and activity', () => {
  it('names a folder by its last segment, whatever the separator', () => {
    expect(folderLabel({ path: 'D:\\du-an' })).toBe('du-an');
    expect(folderLabel({ path: 'D:\\du-an\\' })).toBe('du-an');
    expect(folderLabel({ path: '/home/me/app/' })).toBe('app');
    expect(folderLabel({ path: 'D:\\' })).toBe('D:');
  });

  it('reads an idle folder as idle and counts only what is happening', () => {
    expect(workspaceActivity(folder(DU_AN, false))).toBe('rảnh');
    expect(workspaceActivity(folder(DU_AN, false, { working: 2, waiting: 1 }))).toBe(
      'đang chạy 2 · chờ 1',
    );
    expect(workspaceActivity(folder(DU_AN, false, { waiting: 3 }))).toBe('chờ 3');
  });
});

describe('the active folder', () => {
  const list = [folder(DU_AN, true), folder(KHAC, false)];

  it('finds the active folder, and none before a list arrives', () => {
    expect(activeWorkspace(list)?.path).toBe(DU_AN);
    expect(activeWorkspace(null)).toBeNull();
  });
});

/** A board that has a session selected, holding the terminal and resume list of its folder. */
function stateWithFolders(workspaces: CompanyWorkspaceEntry[] | null): CompanyViewState {
  return {
    ...stateFrom({ sessions: [session({ id: 's1' })] }, DU_AN),
    workspaces,
    viewMode: 'folder',
    selection: { sessionId: 's1', taskId: null, tab: 'activity', herdrPaneId: null },
    terminals: { s1: terminal('s1') },
    ompSessions: { requestId: 'r1', folder: DU_AN, sessions: [] },
    openingSessionId: 's2',
  };
}

describe('the board follows the folder the server reports', () => {
  it('keeps the selection, terminals, and resume list when the active folder is unchanged', () => {
    const before = stateWithFolders([folder(DU_AN, true), folder(KHAC, false)]);
    const after = applyCompanyMessage(before, {
      type: 'companyWorkspaces',
      workspaces: [folder(KHAC, false, { working: 1 }), folder(DU_AN, true, { waiting: 2 })],
    }).state;
    expect(after.selection.sessionId).toBe('s1');
    expect(after.terminals.s1).toBeDefined();
    expect(after.ompSessions).not.toBeNull();
    expect(after.workspaces?.find((entry) => entry.active)?.waiting).toBe(2);
  });

  it('drops what the old folder held when the active folder changes', () => {
    const before = stateWithFolders([folder(DU_AN, true), folder(KHAC, false)]);
    const after = applyCompanyMessage(before, {
      type: 'companyWorkspaces',
      workspaces: [folder(DU_AN, false), folder(KHAC, true)],
    }).state;
    expect(after.selection).toEqual(EMPTY_SELECTION);
    expect(after.terminals).toEqual({});
    expect(after.ompSessions).toBeNull();
    expect(after.openingSessionId).toBeNull();
  });

  it('does not treat the first folder list as a switch', () => {
    const before = stateWithFolders(null);
    const after = applyCompanyMessage(before, {
      type: 'companyWorkspaces',
      workspaces: [folder(DU_AN, true)],
    }).state;
    expect(after.selection.sessionId).toBe('s1');
    expect(after.terminals.s1).toBeDefined();
  });
});

interface FakeTransport {
  transport: MessageTransport;
  sent: ClientMessage[];
  setConnected(connected: boolean): void;
}

function fakeTransport(): FakeTransport {
  const sent: ClientMessage[] = [];
  let connected = true;
  return {
    sent,
    setConnected(value: boolean) {
      connected = value;
    },
    transport: {
      send(message: ClientMessage) {
        if (!connected) throw new Error(TRANSPORT_DISCONNECTED_ERROR);
        sent.push(message);
      },
      onMessage: () => () => {},
      ready: Promise.resolve(),
      state: 'connected',
      onStateChange: () => () => {},
      dispose: () => {},
    } as MessageTransport,
  };
}

/** A client on a board with one selected session and two folders, one of them active. */
function clientWithSession() {
  const fake = fakeTransport();
  const client = new CompanyClient(fake.transport);
  client.accept({
    type: 'companySnapshot',
    requestId: randomUUID(),
    workspacePath: DU_AN,
    snapshot: snapshot({ sessions: [session({ id: 's1' })] }),
  });
  client.accept({
    type: 'companyWorkspaces',
    workspaces: [folder(DU_AN, true), folder(KHAC, false)],
  });
  client.select({ sessionId: 's1' });
  return { client, sent: fake.sent, setConnected: fake.setConnected };
}

describe('opening a folder through the client', () => {
  it('sends the switch and holds it in flight until its verdict', () => {
    const { client, sent } = clientWithSession();
    const handle = client.openWorkspace(KHAC);
    expect(handle.ok).toBe(true);
    expect(sent.at(-1)).toEqual({
      type: 'companyWorkspaceOpen',
      requestId: handle.requestId,
      path: KHAC,
    });
    expect(client.getState().pendingWorkspaceOpen).toBe(handle.requestId);
  });

  it('a success clears the in-flight mark and the selection, and asks for a fresh snapshot', () => {
    const { client, sent } = clientWithSession();
    const handle = client.openWorkspace(KHAC);
    client.accept({ type: 'companyCommandResult', requestId: handle.requestId, ok: true });
    const state = client.getState();
    expect(state.pendingWorkspaceOpen).toBeNull();
    expect(state.selection.sessionId).toBeNull();
    expect(sent.some((message) => message.type === 'companySnapshotRequest')).toBe(true);
  });

  it('a refusal keeps the selection and holds the server message under the handle', () => {
    const { client } = clientWithSession();
    const handle = client.openWorkspace(KHAC);
    client.accept({
      type: 'companyCommandResult',
      requestId: handle.requestId,
      ok: false,
      errorCode: 'workspace_invalid',
      message: 'Thư mục không tồn tại.',
    });
    const state = client.getState();
    expect(state.pendingWorkspaceOpen).toBeNull();
    expect(state.selection.sessionId).toBe('s1');
    expect(state.commandResults[handle.requestId]?.message).toBe('Thư mục không tồn tại.');
  });

  it('a send the transport refuses leaves nothing in flight', () => {
    const { client, setConnected } = clientWithSession();
    setConnected(false);
    const handle = client.openWorkspace(KHAC);
    expect(handle.ok).toBe(false);
    expect(handle.errorCode).toBe(TRANSPORT_DISCONNECTED_ERROR);
    expect(client.getState().pendingWorkspaceOpen).toBeNull();
  });

  it('tells the server the folder view before it switches folders', () => {
    const { client, sent } = clientWithSession();
    client.openWorkspace(KHAC);
    const types = sent.map((message) => message.type);
    expect(sent.find((message) => message.type === 'companyViewMode')).toEqual({
      type: 'companyViewMode',
      requestId: expect.any(String),
      mode: 'folder',
    });
    expect(types.indexOf('companyViewMode')).toBeLessThan(types.indexOf('companyWorkspaceOpen'));
  });
});

describe('choosing a session in another folder through the client', () => {
  it('selects the session once the switch is accepted and the new folder snapshot holds it', () => {
    const { client } = clientWithSession();
    const handle = client.openWorkspaceSession(KHAC, 's2');
    expect(client.getState().pendingWorkspaceOpen).toBe(handle.requestId);
    expect(client.getState().pendingWorkspaceSelection).toEqual({
      requestId: handle.requestId,
      path: KHAC,
      sessionId: 's2',
      confirmed: false,
    });

    client.accept({ type: 'companyCommandResult', requestId: handle.requestId, ok: true });
    expect(client.getState().pendingWorkspaceSelection).toMatchObject({ confirmed: true });
    expect(client.getState().selection.sessionId).toBeNull();

    client.accept({
      type: 'companyWorkspaces',
      workspaces: [folder(DU_AN, false), folder(KHAC, true)],
    });
    client.accept({
      type: 'companySnapshot',
      requestId: randomUUID(),
      workspacePath: KHAC,
      snapshot: snapshot({ sessions: [session({ id: 's2' })] }),
    });
    expect(client.getState().pendingWorkspaceSelection).toBeNull();
    expect(client.getState().selection.sessionId).toBe('s2');
  });

  it('says why a refused switch selected nothing, and keeps the current selection', () => {
    const { client } = clientWithSession();
    const handle = client.openWorkspaceSession(KHAC, 's2');
    client.accept({
      type: 'companyCommandResult',
      requestId: handle.requestId,
      ok: false,
      errorCode: 'workspace_invalid',
      message: 'Thư mục không tồn tại.',
    });
    const state = client.getState();
    expect(state.pendingWorkspaceSelection).toBeNull();
    expect(state.workspaceSelectionNotice).toBe('Thư mục không tồn tại.');
    expect(state.selection.sessionId).toBe('s1');
  });

  it('drops the choice with a reason when the new folder snapshot lacks the session', () => {
    const { client } = clientWithSession();
    const handle = client.openWorkspaceSession(KHAC, 's2');
    client.accept({ type: 'companyCommandResult', requestId: handle.requestId, ok: true });
    client.accept({
      type: 'companyWorkspaces',
      workspaces: [folder(DU_AN, false), folder(KHAC, true)],
    });
    client.accept({
      type: 'companySnapshot',
      requestId: randomUUID(),
      workspacePath: KHAC,
      snapshot: snapshot({ sessions: [session({ id: 's9' })] }),
    });
    const state = client.getState();
    expect(state.pendingWorkspaceSelection).toBeNull();
    expect(state.workspaceSelectionNotice).toBe('Phiên không còn trong thư mục này.');
    expect(state.selection.sessionId).toBeNull();
  });

  it('a plain folder switch clears a pending session choice', () => {
    const { client } = clientWithSession();
    client.openWorkspaceSession(KHAC, 's2');
    client.openWorkspace(KHAC);
    expect(client.getState().pendingWorkspaceSelection).toBeNull();
  });

  it('a new choice replaces the pending one', () => {
    const { client } = clientWithSession();
    client.openWorkspaceSession(KHAC, 's2');
    const second = client.openWorkspaceSession(KHAC, 's3');
    expect(client.getState().pendingWorkspaceSelection).toMatchObject({
      requestId: second.requestId,
      sessionId: 's3',
    });
  });

  it('a send the transport refuses holds no choice and names the failure', () => {
    const { client, setConnected } = clientWithSession();
    setConnected(false);
    const handle = client.openWorkspaceSession(KHAC, 's2');
    const state = client.getState();
    expect(handle.ok).toBe(false);
    expect(state.pendingWorkspaceSelection).toBeNull();
    expect(state.workspaceSelectionNotice).not.toBeNull();
  });
});
