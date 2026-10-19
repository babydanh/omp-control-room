import { describe, expect, it } from 'vitest';

import { TRANSPORT_DISCONNECTED_ERROR } from '../../core/src/messageDelivery.js';
import type {
  ClientMessage,
  CompanyWorkspaceEntry,
  ServerMessage,
} from '../../core/src/messages.js';
import { CompanyClient } from '../src/company/companyClient.js';
import { FOLDER_LIST_LOADING_MESSAGE } from '../src/company/folderView.js';
import type { PromptRoute } from '../src/company/promptSubmission.js';
import type { MessageTransport } from '../src/transport/types.js';

const DU_AN = 'D:\\du-an';
const KHAC = 'D:\\khac';
const NEW_CHAT: PromptRoute = { mode: 'chat', delivery: 'prompt', targetSessionId: null };

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

function folder(path: string, active: boolean): CompanyWorkspaceEntry {
  return { path, active, open: true, working: 0, waiting: 0 };
}

/** A client whose folder list has not arrived yet. */
function loadingClient() {
  const fake = fakeTransport();
  return { client: new CompanyClient(fake.transport), ...fake };
}

/** A client whose folder list has arrived: DU_AN is active, KHAC is open beside it. */
function listedClient() {
  const fake = fakeTransport();
  const client = new CompanyClient(fake.transport);
  client.accept({
    type: 'companyWorkspaces',
    workspaces: [folder(DU_AN, true), folder(KHAC, false)],
  });
  return { client, ...fake };
}

/** A folder listing the server sends back for `requestId`, with one folder inside `path`. */
function listingOf(
  requestId: string,
  path: string | null,
): Extract<ServerMessage, { type: 'companyFolderBrowse' }> {
  return {
    type: 'companyFolderBrowse',
    requestId,
    path,
    parent: null,
    roots: [{ kind: 'drive', name: 'D:', path: 'D:\\' }],
    entries: [{ name: 'src', path: 'D:\\du-an\\src' }],
    truncated: false,
  };
}

describe('the folder browse state', () => {
  it('holds the listing that answers the latest browse', () => {
    const { client } = listedClient();
    const handle = client.browseFolders(DU_AN);

    client.accept(listingOf(handle.requestId, DU_AN));

    expect(client.getState().folderBrowseRequest).toBe(handle.requestId);
    expect(client.getState().folderBrowse).toMatchObject({
      requestId: handle.requestId,
      path: DU_AN,
      entries: [{ name: 'src', path: 'D:\\du-an\\src' }],
    });
  });

  it('drops a listing that answers an earlier browse', () => {
    const { client } = listedClient();
    const earlier = client.browseFolders(DU_AN);
    const latest = client.browseFolders(KHAC);

    client.accept(listingOf(earlier.requestId, DU_AN));
    expect(client.getState().folderBrowse).toBeNull();

    client.accept(listingOf(latest.requestId, KHAC));
    expect(client.getState().folderBrowse).toMatchObject({ path: KHAC });
  });

  it('starts from the start view when no path is named, and the reply has no path', () => {
    const { client, sent } = listedClient();
    const handle = client.browseFolders();

    expect(sent.at(-1)).toEqual({
      type: 'companyFolderBrowseRequest',
      requestId: handle.requestId,
    });

    client.accept(listingOf(handle.requestId, null));
    expect(client.getState().folderBrowse).toMatchObject({ path: null, parent: null });
  });

  it('holds a refusal of its browse under the same requestId', async () => {
    const { client } = listedClient();
    const handle = client.browseFolders(DU_AN);
    const outcome = client.waitForCommand(handle);

    client.accept({
      type: 'companyCommandResult',
      requestId: handle.requestId,
      ok: false,
      errorCode: 'folder_unreadable',
      message: 'Không đọc được thư mục này.',
    });

    expect(client.getState().commandResults[handle.requestId]?.message).toBe(
      'Không đọc được thư mục này.',
    );
    await expect(outcome).resolves.toMatchObject({ ok: false, errorCode: 'folder_unreadable' });
  });

  it('reports a browse the transport refuses on its handle', () => {
    const { client, setConnected } = listedClient();
    setConnected(false);

    const handle = client.browseFolders(DU_AN);

    expect(handle).toMatchObject({ ok: false, errorCode: TRANSPORT_DISCONNECTED_ERROR });
    expect(client.getState().folderBrowseRequest).toBe(handle.requestId);
  });

  it('gives each browse its own requestId, so a late answer is told apart', () => {
    const { client } = listedClient();
    const first = client.browseFolders(DU_AN);
    const second = client.browseFolders(DU_AN);

    expect(second.requestId).not.toBe(first.requestId);
  });
});

describe('folder commands wait for the folder list', () => {
  it('refuses them before the list arrives, and sends nothing', () => {
    const { client, sent } = loadingClient();
    client.setDraftText('ship it');

    const handles = [
      client.browseFolders(),
      client.createFolder(DU_AN, 'moi'),
      client.newChatSession(),
      client.resumeSession('D:/omp/sessions/a.jsonl'),
    ];

    for (const handle of handles) {
      expect(handle).toMatchObject({
        ok: false,
        errorCode: 'workspaces_loading',
        message: FOLDER_LIST_LOADING_MESSAGE,
      });
    }
    expect(client.submitPrompt(NEW_CHAT)).toMatchObject({
      ok: false,
      errorCode: 'workspaces_loading',
    });
    expect(client.getState().prompt.error).toMatchObject({ errorCode: 'workspaces_loading' });
    expect(client.getState().prompt.text).toBe('ship it');
    expect(client.getState().folderBrowseRequest).toBeNull();
    expect(sent).toEqual([]);
  });

  it('lets a prompt to a named session through before the list arrives', () => {
    const { client, sent } = loadingClient();
    client.setDraftText('follow up');

    client.submitPrompt({ mode: 'chat', delivery: 'follow_up', targetSessionId: 's1' });

    expect(sent.find((message) => message.type === 'companyPromptSubmit')).toBeDefined();
  });

  it('sends them once the list has arrived, naming the active folder', () => {
    const { client, sent } = listedClient();

    const chat = client.newChatSession();

    expect(chat.ok).toBe(true);
    expect(sent.at(-1)).toEqual({
      type: 'companyChatNew',
      requestId: chat.requestId,
      workspacePath: DU_AN,
    });
  });
});

describe('creating and renaming folders', () => {
  it('creates a folder inside the parent it names', () => {
    const { client, sent } = listedClient();

    const handle = client.createFolder(DU_AN, 'moi');

    expect(handle.ok).toBe(true);
    expect(sent.at(-1)).toEqual({
      type: 'companyFolderCreate',
      requestId: handle.requestId,
      parentPath: DU_AN,
      name: 'moi',
    });
  });

  it('settles a creation with the server verdict on its handle', async () => {
    const { client } = listedClient();
    const handle = client.createFolder(DU_AN, 'moi');
    const outcome = client.waitForCommand(handle);

    client.accept({
      type: 'companyCommandResult',
      requestId: handle.requestId,
      ok: true,
      workspacePath: 'D:\\du-an\\moi',
    });

    await expect(outcome).resolves.toMatchObject({ requestId: handle.requestId, ok: true });
  });

  it('renames a folder, and an empty name asks the server to remove the display name', () => {
    const { client, sent } = listedClient();

    const rename = client.renameFolder(DU_AN, 'Cửa hàng');
    expect(sent.at(-1)).toEqual({
      type: 'companyFolderName',
      requestId: rename.requestId,
      path: DU_AN,
      name: 'Cửa hàng',
    });

    const removal = client.renameFolder(KHAC, '');
    expect(sent.at(-1)).toEqual({
      type: 'companyFolderName',
      requestId: removal.requestId,
      path: KHAC,
      name: '',
    });
  });

  it('reports a create the transport refuses on its handle', () => {
    const { client, setConnected } = listedClient();
    setConnected(false);

    expect(client.createFolder(DU_AN, 'moi')).toMatchObject({
      ok: false,
      errorCode: TRANSPORT_DISCONNECTED_ERROR,
    });
  });
});
