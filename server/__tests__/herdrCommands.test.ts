import { describe, expect, it, vi } from 'vitest';

import type {
  AgentInfo,
  HerdrAgentsMessage,
  HerdrScreenMessage,
  ServerMessage,
} from '../../core/src/messages.js';
import type { CompanyCommandContext } from '../src/company/clientCommands.js';
import { handleCompanyCommand, isCompanyCommand } from '../src/company/clientCommands.js';
import type { HerdrLink } from '../src/herdr/herdrLink.js';
import { HerdrError } from '../src/herdr/herdrLink.js';

const ROSTER: HerdrAgentsMessage = {
  type: 'herdrAgents',
  available: true,
  agents: [{ paneId: 'wA:p2', workspaceId: 'wA', kind: 'omp', status: 'idle' }],
  sleeping: [],
};

const SCREEN_TEXT = 'màn hình';

const INFO: AgentInfo = {
  cwd: 'D:\\',
  collectedFrom: 'herdr',
  collectedAt: '2026-01-01T00:00:00.000Z',
};

function stubLink(overrides: Partial<HerdrLink> = {}): HerdrLink {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    snapshot: vi.fn((): HerdrAgentsMessage => ROSTER),
    onAgents: vi.fn(() => () => undefined),
    onScreen: vi.fn(() => () => undefined),
    read: vi.fn(async (paneId: string): Promise<HerdrScreenMessage> => ({
      type: 'herdrScreen',
      paneId,
      text: SCREEN_TEXT,
      at: '2026-01-01T00:00:00.000Z',
    })),
    prompt: vi.fn(async (): Promise<void> => undefined),
    keys: vi.fn(async (): Promise<void> => undefined),
    focus: vi.fn(async (): Promise<void> => undefined),
    rename: vi.fn(async (): Promise<void> => undefined),
    info: vi.fn(async (): Promise<AgentInfo> => INFO),
    wake: vi.fn(async (): Promise<void> => undefined),
    ...overrides,
  };
}

function context(overrides: Partial<CompanyCommandContext> = {}): CompanyCommandContext {
  return {
    services: null,
    privileged: true,
    executionAllowed: true,
    herdr: stubLink(),
    ...overrides,
  };
}

/** Deferred; `Promise.withResolvers` needs a newer lib than this project targets. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Collects what the dispatcher sends. Replies (results and screens) can arrive
 * before or after the caller asks for them, so they are queued in order.
 */
function recorder() {
  const sent: ServerMessage[] = [];
  const queued: ServerMessage[] = [];
  const waiting: Array<(message: ServerMessage) => void> = [];
  const send = (message: ServerMessage): void => {
    sent.push(message);
    if (
      message.type !== 'companyCommandResult' &&
      message.type !== 'herdrScreen' &&
      message.type !== 'herdrInfo'
    ) {
      return;
    }
    const resolve = waiting.shift();
    if (resolve) resolve(message);
    else queued.push(message);
  };
  const next = (): Promise<ServerMessage> => {
    const ready = queued.shift();
    if (ready) return Promise.resolve(ready);
    const { promise, resolve } = deferred<ServerMessage>();
    waiting.push(resolve);
    return promise;
  };
  return { sent, send, next };
}

describe('herdr board commands', () => {
  it('registers herdr commands with the company dispatcher', () => {
    for (const type of [
      'herdrRead',
      'herdrPrompt',
      'herdrKeys',
      'herdrFocus',
      'herdrRename',
      'herdrInfoRequest',
      'herdrWake',
    ]) {
      expect(isCompanyCommand({ type })).toBe(true);
    }
  });

  it('refuses herdr commands from an unprivileged socket', async () => {
    const herdr = stubLink();
    const rec = recorder();

    expect(
      handleCompanyCommand(
        { type: 'herdrRead', requestId: 'req-1', paneId: 'wA:p2' },
        rec.send,
        context({ privileged: false, herdr }),
      ),
    ).toBe(true);

    expect(await rec.next()).toEqual({
      type: 'companyCommandResult',
      requestId: 'req-1',
      ok: false,
      errorCode: 'forbidden',
      message: 'Kết nối này không được phép chạy lệnh công ty.',
    });
    expect(herdr.read).not.toHaveBeenCalled();
  });

  it('lets read-only screen reads through an untrusted workspace', async () => {
    const rec = recorder();

    handleCompanyCommand(
      { type: 'herdrRead', requestId: 'req-2', paneId: 'wA:p2' },
      rec.send,
      context({ executionAllowed: false }),
    );

    expect(await rec.next()).toMatchObject({
      type: 'herdrScreen',
      requestId: 'req-2',
      paneId: 'wA:p2',
      text: SCREEN_TEXT,
    });
  });

  it('refuses prompts, keys and focus in an untrusted workspace', async () => {
    const herdr = stubLink();
    const messages: Record<string, unknown>[] = [
      { type: 'herdrPrompt', requestId: 'r-1', paneId: 'wA:p2', text: 'tiếp tục' },
      { type: 'herdrKeys', requestId: 'r-2', paneId: 'wA:p2', keys: ['enter'] },
      { type: 'herdrFocus', requestId: 'r-3', paneId: 'wA:p2' },
      { type: 'herdrWake', requestId: 'r-4', paneId: 'wA:p2', prompt: 'tiếp tục' },
    ];

    for (const message of messages) {
      const rec = recorder();
      handleCompanyCommand(message, rec.send, context({ executionAllowed: false, herdr }));
      expect(await rec.next()).toMatchObject({
        type: 'companyCommandResult',
        ok: false,
        errorCode: 'workspace_untrusted',
      });
    }

    expect(herdr.prompt).not.toHaveBeenCalled();
    expect(herdr.keys).not.toHaveBeenCalled();
    expect(herdr.focus).not.toHaveBeenCalled();
    expect(herdr.wake).not.toHaveBeenCalled();
  });

  it('wakes a sleeping session with the typed prompt and answers ok', async () => {
    const herdr = stubLink();
    const rec = recorder();

    handleCompanyCommand(
      { type: 'herdrWake', requestId: 'w-1', paneId: 'wF:p2', prompt: 'tiếp tục' },
      rec.send,
      context({ herdr }),
    );

    expect(await rec.next()).toEqual({ type: 'companyCommandResult', requestId: 'w-1', ok: true });
    expect(herdr.wake).toHaveBeenCalledWith('wF:p2', 'tiếp tục');
  });

  it('wakes a sleeping session without a prompt when none is given', async () => {
    const herdr = stubLink();
    const rec = recorder();

    handleCompanyCommand(
      { type: 'herdrWake', requestId: 'w-2', paneId: 'wF:p2' },
      rec.send,
      context({ herdr }),
    );

    expect(await rec.next()).toMatchObject({ requestId: 'w-2', ok: true });
    expect(herdr.wake).toHaveBeenCalledWith('wF:p2', undefined);
  });

  it('reports a refused wake with the herdr error code and message', async () => {
    const herdr = stubLink({
      wake: vi.fn(async (): Promise<void> => {
        throw new HerdrError('not_sleeping', 'Phiên này không còn ngủ đông. Hãy làm mới bảng.');
      }),
    });
    const rec = recorder();

    handleCompanyCommand(
      { type: 'herdrWake', requestId: 'w-3', paneId: 'wF:p2' },
      rec.send,
      context({ herdr }),
    );

    expect(await rec.next()).toEqual({
      type: 'companyCommandResult',
      requestId: 'w-3',
      ok: false,
      errorCode: 'not_sleeping',
      message: 'Phiên này không còn ngủ đông. Hãy làm mới bảng.',
    });
  });

  it('reads the default window of 200 lines and answers with the request id', async () => {
    const herdr = stubLink();
    const rec = recorder();

    handleCompanyCommand(
      { type: 'herdrRead', requestId: 'req-3', paneId: 'wA:p2' },
      rec.send,
      context({ herdr }),
    );

    expect(await rec.next()).toMatchObject({
      type: 'herdrScreen',
      requestId: 'req-3',
      paneId: 'wA:p2',
    });
    expect(herdr.read).toHaveBeenCalledWith('wA:p2', 200);
  });

  it('forwards a requested line count and rejects a non-numeric one before reading', async () => {
    const herdr = stubLink();
    const rec = recorder();

    handleCompanyCommand(
      { type: 'herdrRead', requestId: 'req-4', paneId: 'wA:p2', lines: 50 },
      rec.send,
      context({ herdr }),
    );
    expect(await rec.next()).toMatchObject({ type: 'herdrScreen', requestId: 'req-4' });
    expect(herdr.read).toHaveBeenLastCalledWith('wA:p2', 50);

    handleCompanyCommand(
      { type: 'herdrRead', requestId: 'req-5', paneId: 'wA:p2', lines: 'many' },
      rec.send,
      context({ herdr }),
    );
    expect(await rec.next()).toEqual({
      type: 'companyCommandResult',
      requestId: 'req-5',
      ok: false,
      errorCode: 'invalid_request',
      message: 'Yêu cầu herdr không hợp lệ.',
    });
    expect(herdr.read).toHaveBeenCalledTimes(1);
  });

  it('forwards prompts, keys and focus and rejects an unknown key name', async () => {
    const herdr = stubLink();
    const rec = recorder();

    handleCompanyCommand(
      { type: 'herdrPrompt', requestId: 'p-1', paneId: 'wA:p2', text: 'tiếp tục' },
      rec.send,
      context({ herdr }),
    );
    expect(await rec.next()).toEqual({ type: 'companyCommandResult', requestId: 'p-1', ok: true });
    expect(herdr.prompt).toHaveBeenCalledWith('wA:p2', 'tiếp tục');

    handleCompanyCommand(
      { type: 'herdrKeys', requestId: 'k-1', paneId: 'wA:p2', keys: ['down', 'enter'] },
      rec.send,
      context({ herdr }),
    );
    expect(await rec.next()).toEqual({ type: 'companyCommandResult', requestId: 'k-1', ok: true });
    expect(herdr.keys).toHaveBeenCalledWith('wA:p2', ['down', 'enter']);

    handleCompanyCommand(
      { type: 'herdrKeys', requestId: 'k-2', paneId: 'wA:p2', keys: ['down', 'delete'] },
      rec.send,
      context({ herdr }),
    );
    expect(await rec.next()).toMatchObject({
      requestId: 'k-2',
      ok: false,
      errorCode: 'invalid_request',
    });
    expect(herdr.keys).toHaveBeenCalledTimes(1);

    handleCompanyCommand(
      { type: 'herdrFocus', requestId: 'f-1', paneId: 'wA:p2' },
      rec.send,
      context({ herdr }),
    );
    expect(await rec.next()).toEqual({ type: 'companyCommandResult', requestId: 'f-1', ok: true });
    expect(herdr.focus).toHaveBeenCalledWith('wA:p2');
  });

  it('maps a link error to its board code and its Vietnamese message', async () => {
    const herdr = stubLink({
      prompt: vi.fn(async () => {
        throw new HerdrError('agent_blocked', 'Agent đang chờ xác nhận (blocked).');
      }),
    });
    const rec = recorder();

    handleCompanyCommand(
      { type: 'herdrPrompt', requestId: 'b-1', paneId: 'wA:p2', text: 'tiếp tục' },
      rec.send,
      context({ herdr }),
    );

    expect(await rec.next()).toEqual({
      type: 'companyCommandResult',
      requestId: 'b-1',
      ok: false,
      errorCode: 'agent_blocked',
      message: 'Agent đang chờ xác nhận (blocked).',
    });
  });

  it('hides unexpected failures behind a Vietnamese fallback', async () => {
    const herdr = stubLink({
      prompt: vi.fn(async () => {
        throw new Error('ECONNRESET 10.0.0.1 internal');
      }),
    });
    const rec = recorder();

    handleCompanyCommand(
      { type: 'herdrPrompt', requestId: 'u-1', paneId: 'wA:p2', text: 'tiếp tục' },
      rec.send,
      context({ herdr }),
    );

    expect(await rec.next()).toEqual({
      type: 'companyCommandResult',
      requestId: 'u-1',
      ok: false,
      errorCode: 'herdr_failed',
      message: 'Không thực hiện được lệnh herdr.',
    });
  });

  it('answers herdr commands with herdr_unavailable when no link is attached', async () => {
    const rec = recorder();

    handleCompanyCommand(
      { type: 'herdrRead', requestId: 'n-1', paneId: 'wA:p2' },
      rec.send,
      context({ herdr: null }),
    );

    expect(await rec.next()).toEqual({
      type: 'companyCommandResult',
      requestId: 'n-1',
      ok: false,
      errorCode: 'herdr_unavailable',
      message: 'Máy chủ này chưa kết nối herdr.',
    });
  });

  it('sends the herdr roster on a snapshot request even without a company workspace', async () => {
    const herdr = stubLink();
    const rec = recorder();

    handleCompanyCommand(
      { type: 'companySnapshotRequest', requestId: 's-1' },
      rec.send,
      context({ herdr }),
    );

    expect(rec.sent).toContainEqual(ROSTER);
    expect(await rec.next()).toMatchObject({
      type: 'companyCommandResult',
      errorCode: 'company_unavailable',
    });
  });

  it('sends an unavailable roster on a snapshot request when herdr is not linked', () => {
    const rec = recorder();

    handleCompanyCommand(
      { type: 'companySnapshotRequest', requestId: 's-2' },
      rec.send,
      context({ herdr: null }),
    );

    expect(rec.sent[0]).toEqual({
      type: 'herdrAgents',
      available: false,
      reason: 'Máy chủ này chưa kết nối herdr.',
      agents: [],
      sleeping: [],
    });
  });

  it('answers a herdr command without a request id using the fallback correlation id', async () => {
    const rec = recorder();

    handleCompanyCommand({ type: 'herdrFocus', paneId: 'wA:p2' }, rec.send, context());

    expect(await rec.next()).toEqual({
      type: 'companyCommandResult',
      requestId: '00000000-0000-4000-8000-000000000000',
      ok: false,
      errorCode: 'invalid_request',
      message: 'Yêu cầu herdr không hợp lệ.',
    });
  });

  it('refuses a rename without a name before reaching herdr', async () => {
    const herdr = stubLink();
    const rec = recorder();

    handleCompanyCommand(
      { type: 'herdrRename', requestId: 'n-3', paneId: 'wA:p2' },
      rec.send,
      context({ herdr }),
    );

    expect(await rec.next()).toMatchObject({
      type: 'companyCommandResult',
      requestId: 'n-3',
      ok: false,
      errorCode: 'invalid_request',
    });
    expect(herdr.rename).not.toHaveBeenCalled();
  });

  it('renames an agent and acknowledges the request', async () => {
    const herdr = stubLink();
    const rec = recorder();

    handleCompanyCommand(
      { type: 'herdrRename', requestId: 'n-2', paneId: 'wA:p2', name: 'reviewer_2' },
      rec.send,
      context({ herdr }),
    );

    expect(await rec.next()).toEqual({ type: 'companyCommandResult', requestId: 'n-2', ok: true });
    expect(herdr.rename).toHaveBeenCalledWith('wA:p2', 'reviewer_2');
  });

  it('refuses a rename in an untrusted workspace', async () => {
    const herdr = stubLink();
    const rec = recorder();

    handleCompanyCommand(
      { type: 'herdrRename', requestId: 'n-4', paneId: 'wA:p2', name: 'reviewer' },
      rec.send,
      context({ executionAllowed: false, herdr }),
    );

    expect(await rec.next()).toMatchObject({
      type: 'companyCommandResult',
      requestId: 'n-4',
      ok: false,
      errorCode: 'workspace_untrusted',
    });
    expect(herdr.rename).not.toHaveBeenCalled();
  });

  it('answers an info request with the link facts, even in an untrusted workspace', async () => {
    const herdr = stubLink();
    const rec = recorder();

    handleCompanyCommand(
      { type: 'herdrInfoRequest', requestId: 'i-1', paneId: 'wA:p2' },
      rec.send,
      context({ executionAllowed: false, herdr }),
    );

    expect(await rec.next()).toEqual({
      type: 'herdrInfo',
      requestId: 'i-1',
      paneId: 'wA:p2',
      info: INFO,
    });
    expect(herdr.info).toHaveBeenCalledWith('wA:p2');
  });

  it('refuses rename and info requests from an unprivileged socket', async () => {
    const herdr = stubLink();
    const messages: Record<string, unknown>[] = [
      { type: 'herdrRename', requestId: 'u-2', paneId: 'wA:p2', name: 'reviewer' },
      { type: 'herdrInfoRequest', requestId: 'u-3', paneId: 'wA:p2' },
    ];

    for (const message of messages) {
      const rec = recorder();
      handleCompanyCommand(message, rec.send, context({ privileged: false, herdr }));
      expect(await rec.next()).toMatchObject({
        type: 'companyCommandResult',
        ok: false,
        errorCode: 'forbidden',
      });
    }

    expect(herdr.rename).not.toHaveBeenCalled();
    expect(herdr.info).not.toHaveBeenCalled();
  });
});
