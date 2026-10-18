import { describe, expect, it, vi } from 'vitest';

import type { ServerMessage } from '../../core/src/messages.js';
import type {
  CompanyCommandContext,
  CompanyWorkspaceControl,
} from '../src/company/clientCommands.js';
import { handleCompanyCommand } from '../src/company/clientCommands.js';
import { CompanyError } from '../src/company/companyError.js';
import { CompanyClientGate } from '../src/company/egress.js';

const REQUEST_ID = '6f1c1d7e-0b1e-4d6e-9d8a-2f0c7a1b9e11';

function fakeControl(open: (workspacePath: string) => Promise<void> = () => Promise.resolve()): {
  control: CompanyWorkspaceControl;
  opened: string[];
} {
  const opened: string[] = [];
  const control: CompanyWorkspaceControl = {
    entries: () => [{ path: 'D:/alpha', active: true, open: true, working: 1, waiting: 2 }],
    open: async (workspacePath) => {
      opened.push(workspacePath);
      await open(workspacePath);
    },
  };
  return { control, opened };
}

function context(overrides: Partial<CompanyCommandContext> = {}): CompanyCommandContext {
  return { services: null, privileged: true, executionAllowed: true, ...overrides };
}

function collector(): { sent: ServerMessage[]; send: (message: ServerMessage) => void } {
  const sent: ServerMessage[] = [];
  return {
    sent,
    send: (message) => {
      sent.push(message);
    },
  };
}

describe('companyWorkspaceOpen command', () => {
  it('opens the folder through the control and answers ok', async () => {
    const { control, opened } = fakeControl();
    const { sent, send } = collector();

    const handled = handleCompanyCommand(
      { type: 'companyWorkspaceOpen', requestId: REQUEST_ID, path: 'D:/alpha' },
      send,
      context({ workspaces: control }),
    );

    expect(handled).toBe(true);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(opened).toEqual(['D:/alpha']);
    expect(sent[0]).toMatchObject({
      type: 'companyCommandResult',
      requestId: REQUEST_ID,
      ok: true,
    });
  });

  it('answers the control refusal with its code and its Vietnamese message', async () => {
    const { control } = fakeControl(() =>
      Promise.reject(new CompanyError('workspace_invalid', 'Không tìm thấy thư mục: D:/nope')),
    );
    const { sent, send } = collector();

    handleCompanyCommand(
      { type: 'companyWorkspaceOpen', requestId: REQUEST_ID, path: 'D:/nope' },
      send,
      context({ workspaces: control }),
    );

    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toMatchObject({
      type: 'companyCommandResult',
      requestId: REQUEST_ID,
      ok: false,
      errorCode: 'workspace_invalid',
      message: 'Không tìm thấy thư mục: D:/nope',
    });
  });

  it('refuses without execution trust before the control is reached', async () => {
    const { control, opened } = fakeControl();
    const { sent, send } = collector();

    handleCompanyCommand(
      { type: 'companyWorkspaceOpen', requestId: REQUEST_ID, path: 'D:/alpha' },
      send,
      context({ workspaces: control, executionAllowed: false }),
    );

    expect(sent).toEqual([
      expect.objectContaining({ ok: false, errorCode: 'workspace_untrusted' }),
    ]);
    expect(opened).toEqual([]);
  });

  it('refuses from an unprivileged socket before the control is reached', async () => {
    const { control, opened } = fakeControl();
    const { sent, send } = collector();

    handleCompanyCommand(
      { type: 'companyWorkspaceOpen', requestId: REQUEST_ID, path: 'D:/alpha' },
      send,
      context({ workspaces: control, privileged: false }),
    );

    expect(sent).toEqual([expect.objectContaining({ ok: false, errorCode: 'forbidden' })]);
    expect(opened).toEqual([]);
  });

  it('answers invalid_request when the path is missing', () => {
    const { control, opened } = fakeControl();
    const { sent, send } = collector();

    handleCompanyCommand(
      { type: 'companyWorkspaceOpen', requestId: REQUEST_ID },
      send,
      context({ workspaces: control }),
    );

    expect(sent).toEqual([expect.objectContaining({ ok: false, errorCode: 'invalid_request' })]);
    expect(opened).toEqual([]);
  });

  it('answers company_unavailable when this surface has no folder control', () => {
    const { sent, send } = collector();

    handleCompanyCommand(
      { type: 'companyWorkspaceOpen', requestId: REQUEST_ID, path: 'D:/alpha' },
      send,
      context({ workspaces: null }),
    );

    expect(sent).toEqual([
      expect.objectContaining({ ok: false, errorCode: 'company_unavailable' }),
    ]);
  });
});

describe('companyWorkspaces list', () => {
  it('a snapshot request also carries the folder list to the requester', () => {
    const { control } = fakeControl();
    const { sent, send } = collector();

    handleCompanyCommand(
      { type: 'companySnapshotRequest', requestId: REQUEST_ID },
      send,
      context({ workspaces: control }),
    );

    expect(sent).toContainEqual({
      type: 'companyWorkspaces',
      workspaces: [{ path: 'D:/alpha', active: true, open: true, working: 1, waiting: 2 }],
    });
  });

  it('is withheld from unprivileged sockets and delivered to privileged ones', () => {
    const message: Record<string, unknown> = { type: 'companyWorkspaces', workspaces: [] };

    expect(new CompanyClientGate(false).allowsDelivery(message)).toBe(false);
    expect(new CompanyClientGate(true).allowsDelivery(message)).toBe(true);
  });
});
