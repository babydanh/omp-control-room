import { describe, expect, it, vi } from 'vitest';

import { TRANSPORT_DISCONNECTED_ERROR } from '../../core/src/messageDelivery.js';
import type { ClientMessage, CompanyWorkspaceEntry } from '../../core/src/messages.js';
import { CompanyClient } from '../src/company/companyClient.js';
import { openPickedFolder, pickFolder } from '../src/company/folderPick.js';
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

/** The requestId of the last message the client sent, once it is of `type`. */
async function lastSent(sent: ClientMessage[], type: ClientMessage['type']): Promise<string> {
  await vi.waitFor(() => expect(sent.at(-1)?.type).toBe(type));
  const message = sent.at(-1);
  if (message === undefined || !('requestId' in message) || typeof message.requestId !== 'string') throw new Error(`no ${type} was sent`);
  return message.requestId;
}

describe('choosing a folder in Windows\' dialog', () => {
  it('asks the server for the dialog and answers with the folder its verdict names', async () => {
    const { client, sent } = listedClient();
    const picking = pickFolder(client);
    const requestId = await lastSent(sent, 'companyFolderPick');

    expect(sent.at(-1)).toEqual({ type: 'companyFolderPick', requestId });
    client.accept({ type: 'companyCommandResult', requestId, ok: true, workspacePath: 'D:\\moi' });
    await expect(picking).resolves.toEqual({ path: 'D:\\moi' });
  });

  it('reads a verdict that names no folder as a cancelled dialog', async () => {
    const { client, sent } = listedClient();
    const picking = pickFolder(client);
    client.accept({ type: 'companyCommandResult', requestId: await lastSent(sent, 'companyFolderPick'), ok: true });
    await expect(picking).resolves.toBeNull();
  });

  it('turns a refusal, or a send the transport refuses, into the notice to show', async () => {
    const { client, sent, setConnected } = listedClient();
    const picking = pickFolder(client);
    client.accept({
      type: 'companyCommandResult',
      requestId: await lastSent(sent, 'companyFolderPick'),
      ok: false,
      errorCode: 'folder_pick_busy',
      message: 'Hộp chọn thư mục đang mở. Chọn xong hoặc đóng nó trước.',
    });
    await expect(picking).resolves.toEqual({ notice: 'Hộp chọn thư mục đang mở. Chọn xong hoặc đóng nó trước.' });

    setConnected(false);
    await expect(pickFolder(client)).resolves.toMatchObject({ notice: expect.any(String) });
  });

  it('points the board at the folder chosen, and opens nothing when the dialog is cancelled', async () => {
    const { client, sent } = listedClient();
    const opening = openPickedFolder(client);
    client.accept({ type: 'companyCommandResult', requestId: await lastSent(sent, 'companyFolderPick'), ok: true, workspacePath: KHAC });
    const openId = await lastSent(sent, 'companyWorkspaceOpen');
    expect(sent.at(-1)).toMatchObject({ type: 'companyWorkspaceOpen', path: KHAC });
    client.accept({ type: 'companyCommandResult', requestId: openId, ok: true });
    await expect(opening).resolves.toBe('opened');

    const cancelled = openPickedFolder(client);
    client.accept({ type: 'companyCommandResult', requestId: await lastSent(sent, 'companyFolderPick'), ok: true });
    await expect(cancelled).resolves.toBe('cancelled');
    expect(sent.at(-1)?.type).toBe('companyFolderPick');
  });

  it('shows why the board could not open the folder chosen', async () => {
    const { client, sent } = listedClient();
    const opening = openPickedFolder(client);
    client.accept({ type: 'companyCommandResult', requestId: await lastSent(sent, 'companyFolderPick'), ok: true, workspacePath: KHAC });
    client.accept({
      type: 'companyCommandResult',
      requestId: await lastSent(sent, 'companyWorkspaceOpen'),
      ok: false,
      errorCode: 'workspace_invalid',
      message: 'Không mở được thư mục.',
    });
    await expect(opening).resolves.toEqual({ notice: 'Không mở được thư mục.' });
  });
});

describe('folder commands wait for the folder list', () => {
  it('refuses them before the list arrives, and sends nothing', () => {
    const { client, sent } = loadingClient();
    client.setDraftText('ship it');

    const handles = [
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

describe('naming and forgetting folders', () => {
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

  it('forgets a folder by the path it is listed under, even when it is gone from disk', () => {
    const { client, sent } = listedClient();

    const forget = client.forgetFolder(KHAC);

    expect(sent.at(-1)).toEqual({
      type: 'companyFolderForget',
      requestId: forget.requestId,
      path: KHAC,
    });
  });
});
