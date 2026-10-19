import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
  renamed: { path: string; name: string | null }[];
  forgotten: string[];
} {
  const opened: string[] = [];
  const renamed: { path: string; name: string | null }[] = [];
  const forgotten: string[] = [];
  const control: CompanyWorkspaceControl = {
    entries: () => [{ path: 'D:/alpha', active: true, open: true, working: 1, waiting: 2 }],
    open: async (workspacePath) => {
      opened.push(workspacePath);
      await open(workspacePath);
    },
    ensure: async () => {
      throw new Error('ensure is not exercised by these tests');
    },
    servicesFor: () => null,
    servicesHolding: () => null,
    activeServices: () => null,
    activePath: () => null,
    setFolderName: (workspacePath, name) => {
      renamed.push({ path: workspacePath, name });
    },
    forget: async (workspacePath) => {
      forgotten.push(workspacePath);
    },
  };
  return { control, opened, renamed, forgotten };
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

describe('company folder commands', () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A real folder holding two sub-folders and a file, so browse and create run against the disk. */
  function tempRoot(): { root: string; canonical: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-commands-'));
    temps.push(root);
    fs.mkdirSync(path.join(root, 'beta'));
    fs.mkdirSync(path.join(root, 'Alpha'));
    fs.writeFileSync(path.join(root, 'notes.txt'), '');
    return { root, canonical: fs.realpathSync(root) };
  }

  /** Run one command and return the single reply it sends. */
  async function reply(
    msg: Record<string, unknown>,
    overrides: Partial<CompanyCommandContext> = {},
  ): Promise<ServerMessage> {
    const { sent, send } = collector();
    handleCompanyCommand(msg, send, context(overrides));
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    const [message] = sent;
    if (message === undefined) throw new Error('no reply was sent');
    return message;
  }

  it('browses the start view when no path is sent', async () => {
    expect(
      await reply({ type: 'companyFolderBrowseRequest', requestId: REQUEST_ID }),
    ).toMatchObject({
      type: 'companyFolderBrowse',
      requestId: REQUEST_ID,
      path: null,
      parent: null,
      entries: [],
      truncated: false,
    });
  });

  it('lists only the folders inside a named folder, sorted by name', async () => {
    const { root, canonical } = tempRoot();
    expect(
      await reply({ type: 'companyFolderBrowseRequest', requestId: REQUEST_ID, path: root }),
    ).toMatchObject({
      type: 'companyFolderBrowse',
      path: canonical,
      parent: path.dirname(canonical),
      entries: [
        { name: 'Alpha', path: path.join(canonical, 'Alpha') },
        { name: 'beta', path: path.join(canonical, 'beta') },
      ],
      truncated: false,
    });
  });

  it('answers a browse of a missing folder with its code and message', async () => {
    const { root } = tempRoot();
    expect(
      await reply({
        type: 'companyFolderBrowseRequest',
        requestId: REQUEST_ID,
        path: path.join(root, 'missing'),
      }),
    ).toMatchObject({
      type: 'companyCommandResult',
      requestId: REQUEST_ID,
      ok: false,
      errorCode: 'folder_not_found',
      message: 'Thư mục không tồn tại.',
    });
  });

  it('answers a browse of a file with not_a_folder', async () => {
    const { root } = tempRoot();
    expect(
      await reply({
        type: 'companyFolderBrowseRequest',
        requestId: REQUEST_ID,
        path: path.join(root, 'notes.txt'),
      }),
    ).toMatchObject({ ok: false, errorCode: 'not_a_folder', message: 'Đây không phải thư mục.' });
  });

  it('refuses a relative path before it reaches the disk', async () => {
    expect(
      await reply({
        type: 'companyFolderBrowseRequest',
        requestId: REQUEST_ID,
        path: 'relative/folder',
      }),
    ).toMatchObject({
      ok: false,
      errorCode: 'folder_path_invalid',
      message: 'Đường dẫn không hợp lệ.',
    });
  });

  it('refuses a path that climbs with a .. segment', async () => {
    const { root } = tempRoot();
    expect(
      await reply({
        type: 'companyFolderBrowseRequest',
        requestId: REQUEST_ID,
        path: `${root}${path.sep}..${path.sep}escape`,
      }),
    ).toMatchObject({ ok: false, errorCode: 'folder_path_invalid' });
  });

  it('creates a folder named by the trimmed name and answers with its canonical path', async () => {
    const { root, canonical } = tempRoot();
    expect(
      await reply({
        type: 'companyFolderCreate',
        requestId: REQUEST_ID,
        parentPath: root,
        name: '  Gamma  ',
      }),
    ).toMatchObject({
      type: 'companyCommandResult',
      requestId: REQUEST_ID,
      ok: true,
      workspacePath: path.join(canonical, 'Gamma'),
    });
    expect(fs.existsSync(path.join(canonical, 'Gamma'))).toBe(true);
  });

  it('refuses a name that already exists in the parent with folder_exists', async () => {
    const { root } = tempRoot();
    expect(
      await reply({
        type: 'companyFolderCreate',
        requestId: REQUEST_ID,
        parentPath: root,
        name: 'Alpha',
      }),
    ).toMatchObject({ ok: false, errorCode: 'folder_exists', message: 'Thư mục đã tồn tại.' });
  });

  it('refuses a name with a forbidden character with folder_name_invalid', async () => {
    const { root } = tempRoot();
    expect(
      await reply({
        type: 'companyFolderCreate',
        requestId: REQUEST_ID,
        parentPath: root,
        name: 'a/b',
      }),
    ).toMatchObject({ ok: false, errorCode: 'folder_name_invalid' });
  });

  it('refuses a name longer than 255 characters with folder_name_too_long', async () => {
    const { root } = tempRoot();
    expect(
      await reply({
        type: 'companyFolderCreate',
        requestId: REQUEST_ID,
        parentPath: root,
        name: 'x'.repeat(256),
      }),
    ).toMatchObject({
      ok: false,
      errorCode: 'folder_name_too_long',
      message: 'Tên thư mục quá dài.',
    });
  });

  it('refuses to create inside a folder that does not exist', async () => {
    const { root } = tempRoot();
    expect(
      await reply({
        type: 'companyFolderCreate',
        requestId: REQUEST_ID,
        parentPath: path.join(root, 'missing'),
        name: 'Gamma',
      }),
    ).toMatchObject({ ok: false, errorCode: 'folder_not_found' });
  });

  it('stores a display name through the control and answers with the canonical path', async () => {
    const { root, canonical } = tempRoot();
    const { control, renamed } = fakeControl();
    expect(
      await reply(
        { type: 'companyFolderName', requestId: REQUEST_ID, path: root, name: 'Mốc A' },
        { workspaces: control },
      ),
    ).toMatchObject({
      type: 'companyCommandResult',
      requestId: REQUEST_ID,
      ok: true,
      workspacePath: canonical,
    });
    expect(renamed).toEqual([{ path: canonical, name: 'Mốc A' }]);
  });

  it('clears a display name when the sent name is blank', async () => {
    const { root, canonical } = tempRoot();
    const { control, renamed } = fakeControl();
    await reply(
      { type: 'companyFolderName', requestId: REQUEST_ID, path: root, name: '   ' },
      { workspaces: control },
    );
    expect(renamed).toEqual([{ path: canonical, name: null }]);
  });

  it('refuses a display name when this process keeps no folder list', async () => {
    const { root } = tempRoot();
    expect(
      await reply({ type: 'companyFolderName', requestId: REQUEST_ID, path: root, name: 'Mốc A' }),
    ).toMatchObject({
      ok: false,
      errorCode: 'company_unavailable',
      message: 'Máy chủ này không quản lý nhiều thư mục.',
    });
  });

  it('answers a failed save with the control refusal', async () => {
    const { root } = tempRoot();
    const { control } = fakeControl();
    const failing: CompanyWorkspaceControl = {
      ...control,
      setFolderName: () => {
        throw new CompanyError('company_command_failed', 'Không lưu được tên thư mục.');
      },
    };
    expect(
      await reply(
        { type: 'companyFolderName', requestId: REQUEST_ID, path: root, name: 'Mốc A' },
        { workspaces: failing },
      ),
    ).toMatchObject({
      ok: false,
      errorCode: 'company_command_failed',
      message: 'Không lưu được tên thư mục.',
    });
  });

  it('takes a folder off the list through the control, by the path as listed, and answers ok', async () => {
    const { control, forgotten } = fakeControl();
    expect(
      await reply(
        { type: 'companyFolderForget', requestId: REQUEST_ID, path: 'D:/gone' },
        { workspaces: control },
      ),
    ).toMatchObject({ type: 'companyCommandResult', requestId: REQUEST_ID, ok: true });
    expect(forgotten).toEqual(['D:/gone']);
  });

  it('refuses a forget with a blank path before the control is reached', async () => {
    const { control, forgotten } = fakeControl();
    expect(
      await reply(
        { type: 'companyFolderForget', requestId: REQUEST_ID, path: '  ' },
        { workspaces: control },
      ),
    ).toMatchObject({ ok: false, errorCode: 'invalid_request' });
    expect(forgotten).toEqual([]);
  });

  it('answers a forget refusal from the control with its code and message', async () => {
    const { control } = fakeControl();
    const busy: CompanyWorkspaceControl = {
      ...control,
      forget: async () => {
        throw new CompanyError('workspace_busy', 'Thư mục này còn phiên đang chạy.');
      },
    };
    expect(
      await reply(
        { type: 'companyFolderForget', requestId: REQUEST_ID, path: 'D:/alpha' },
        { workspaces: busy },
      ),
    ).toMatchObject({
      ok: false,
      errorCode: 'workspace_busy',
      message: 'Thư mục này còn phiên đang chạy.',
    });
  });

  it('refuses folder commands from an unprivileged connection', async () => {
    expect(
      await reply(
        { type: 'companyFolderBrowseRequest', requestId: REQUEST_ID },
        { privileged: false },
      ),
    ).toMatchObject({ ok: false, errorCode: 'forbidden' });
  });

  it('refuses folder creation in an untrusted workspace before touching the disk', async () => {
    const { root } = tempRoot();
    expect(
      await reply(
        { type: 'companyFolderCreate', requestId: REQUEST_ID, parentPath: root, name: 'Gamma' },
        { executionAllowed: false },
      ),
    ).toMatchObject({ ok: false, errorCode: 'workspace_untrusted' });
    expect(fs.existsSync(path.join(root, 'Gamma'))).toBe(false);
  });
});
