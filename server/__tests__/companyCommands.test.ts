import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompanyPrompt, CompanySnapshot, ServerMessage } from '../../core/src/messages.js';
import type {
  CompanyCommandContext,
  CompanyCommandServices,
  CompanyTerminalGateway,
  CompanyWorkspaceControl,
} from '../src/company/clientCommands.js';
import type {
  CompanyCoordinator,
  CompanySessionAction,
} from '../src/company/companyCoordinator.js';
import { COMPANY_SESSION_NAME_MAX_LENGTH } from '../src/company/companyCoordinator.js';
import { CompanyError } from '../src/company/companyError.js';
import type { CompanyStore } from '../src/company/companyStore.js';
import { SessionLog, sessionLogDirectory } from '../src/company/sessionLog.js';
import { parseWorkItemsFile } from '../src/company/workItems/workItemModel.js';
import { WorkItemService } from '../src/company/workItems/workItemService.js';

let tempHome: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof os>('os');
  return { ...actual, homedir: () => tempHome };
});

const { CompanyStore: RealCompanyStore } = await import('../src/company/companyStore.js');
const { handleCompanyCommand } = await import('../src/company/clientCommands.js');

interface Recorded {
  method: string;
  args: unknown[];
}

interface RecordingTerminal extends CompanyTerminalGateway {
  calls: Recorded[];
}

function fakeCoordinator(overrides: Partial<CompanyCoordinator> = {}): {
  coordinator: CompanyCoordinator;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const track =
    (method: string) =>
    async (...args: unknown[]): Promise<void> => {
      calls.push({ method, args });
    };
  const snapshot = {
    revision: 7,
    settings: {
      workspacePath: 'C:/workspace',
      maxRetainedSessions: 10,
      maxLiveRunners: 4,
      maxConcurrentModelCalls: 4,
      maxWorkers: 4,
      idleParkSeconds: 120,
      roleProfiles: {},
      verificationProfiles: {},
    },
    prompts: [],
    contracts: [],
    tasks: [],
    sessions: [],
    questions: [],
    quotas: [],
  } as unknown as CompanySnapshot;
  const coordinator: CompanyCoordinator = {
    submitPrompt: async (input) => {
      calls.push({ method: 'submitPrompt', args: [input] });
      return { id: input.requestId } as unknown as CompanyPrompt;
    },
    decideContract: track('decideContract'),
    answerQuestion: track('answerQuestion'),
    controlSession: track('controlSession'),
    renameSession: track('renameSession'),
    cancelPrompt: track('cancelPrompt'),
    listOmpSessions: async () => {
      calls.push({ method: 'listOmpSessions', args: [] });
      return { folder: 'C:/workspace', sessions: [] };
    },
    resumeOmpSession: async (file) => {
      calls.push({ method: 'resumeOmpSession', args: [file] });
      return 'session-resumed';
    },
    openNewChat: async () => {
      calls.push({ method: 'openNewChat', args: [] });
      return 'session-new-chat';
    },
    updateSettings: track('updateSettings'),
    submitTaskResult: async () => {
      throw new Error('Native task results are not browser commands.');
    },
    verifyTask: async () => {
      throw new Error('Native verification is not a browser command.');
    },
    submitQaResult: async () => {
      throw new Error('Native QA verdicts are not browser commands.');
    },
    submitJudgeResult: async () => {
      throw new Error('Native Judge verdicts are not browser commands.');
    },
    holdsId: () => false,
    snapshot: () => {
      calls.push({ method: 'snapshot', args: [] });
      return snapshot;
    },
    diagnostics: () => {
      calls.push({ method: 'diagnostics', args: [] });
      throw new Error('diagnostics are not exercised here');
    },
    dispose: track('dispose'),
    ...overrides,
  };
  return { coordinator, calls };
}

function fakeTerminal(leaseId = randomUUID()): RecordingTerminal {
  const calls: Recorded[] = [];
  const requireLease = (actual: unknown): void => {
    if (actual !== leaseId) {
      throw Object.assign(new Error('terminal controller lease is stale'), {
        code: 'invalid_terminal_lease',
      });
    }
  };
  return {
    calls,
    attach: async (sessionId, runEpoch, cols, rows, onLeaseGranted?: (leaseId: string) => void) => {
      calls.push({ method: 'attach', args: [sessionId, runEpoch, cols, rows] });
      onLeaseGranted?.(leaseId);
      return { leaseId, cols: cols ?? 120, rows: rows ?? 32 };
    },
    write: async (...args: unknown[]) => {
      requireLease(args[3]);
      calls.push({ method: 'write', args });
    },
    resize: async (...args: unknown[]) => {
      requireLease(args[4]);
      calls.push({ method: 'resize', args });
    },
    detach: async (...args: unknown[]) => {
      requireLease(args[2]);
      calls.push({ method: 'detach', args });
    },
  };
}

function companyCommands(): Record<string, Record<string, unknown>> {
  return {
    companySnapshotRequest: { requestId: randomUUID() },
    companyPromptSubmit: {
      prompt: { requestId: randomUUID(), text: 'do the thing', delivery: 'prompt' },
    },
    companyContractDecision: {
      requestId: randomUUID(),
      contractId: randomUUID(),
      revision: 1,
      decision: 'approve',
    },
    companyQuestionAnswer: {
      answer: { requestId: randomUUID(), questionId: randomUUID(), runEpoch: 0, answers: {} },
    },
    companySessionControl: {
      requestId: randomUUID(),
      sessionId: randomUUID(),
      runEpoch: 2,
      action: 'pause' satisfies CompanySessionAction,
    },
    companySettingsUpdate: { requestId: randomUUID(), roleProfiles: {} },
    companyModelCatalogRequest: { requestId: randomUUID() },
    companyArtifactRequest: { requestId: randomUUID(), artifactId: randomUUID(), offset: 0 },
    companyFileListRequest: { requestId: randomUUID(), path: '' },
    companyFileReadRequest: { requestId: randomUUID(), path: 'README.md', offset: 0 },
    companySessionLogRequest: { requestId: randomUUID(), sessionId: randomUUID(), limit: 10 },
    companySessionRename: { requestId: randomUUID(), sessionId: randomUUID(), name: 'Tên mới' },
    companySessionInfoRequest: { requestId: randomUUID(), sessionId: randomUUID() },
    companyPromptCancel: { requestId: randomUUID(), promptId: randomUUID() },
    companySessionResume: { requestId: randomUUID(), file: '/omp/saved.jsonl' },
    companyOmpSessionsRequest: { requestId: randomUUID() },
    companyChatNew: { requestId: randomUUID() },
    companyViewMode: { requestId: randomUUID(), mode: 'all' },
    companyAttachmentUpload: {
      requestId: randomUUID(),
      fileName: 'shot.png',
      mediaType: 'image/png',
      dataBase64: Buffer.from([1, 2, 3]).toString('base64'),
    },
    terminalAttach: { requestId: randomUUID(), sessionId: randomUUID(), runEpoch: 1 },
    terminalInput: { sessionId: randomUUID(), runEpoch: 1, data: 'ls\n' },
    terminalResize: { sessionId: randomUUID(), runEpoch: 1, cols: 100, rows: 30 },
    terminalDetach: { sessionId: randomUUID(), runEpoch: 1 },
  };
}

describe('company client commands', () => {
  let workspace: string;
  let store: CompanyStore;
  let outbox: ServerMessage[];
  let services: CompanyCommandServices;
  let calls: Recorded[];

  const send = (message: ServerMessage): void => {
    outbox.push(message);
  };

  const context = (overrides: Partial<CompanyCommandContext> = {}): CompanyCommandContext => ({
    services,
    privileged: true,
    executionAllowed: true,
    ...overrides,
  });

  /**
   * Commands execute concurrently, so replies are matched by type rather than
   * by position: the dispatcher promises ordering per command, not across them.
   */
  function replies<T extends ServerMessage['type']>(
    type: T,
  ): Extract<ServerMessage, { type: T }>[] {
    return outbox.filter(
      (message): message is Extract<ServerMessage, { type: T }> => message.type === type,
    );
  }

  function results(): Extract<ServerMessage, { type: 'companyCommandResult' }>[] {
    return replies('companyCommandResult');
  }

  beforeEach(async () => {
    tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pxl-company-cmd-'));
    workspace = path.join(tempHome, 'workspace');
    await fs.promises.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.promises.writeFile(path.join(workspace, 'README.md'), '# hello\n');
    store = await RealCompanyStore.open(workspace);
    await store.load();
    outbox = [];
    const fake = fakeCoordinator();
    calls = fake.calls;
    services = {
      coordinator: fake.coordinator,
      store,
      workspaceRoot: workspace,
      terminal: fakeTerminal(),
      modelCatalog: async () => [],
      sessionInfo: async (sessionId) => {
        calls.push({ method: 'sessionInfo', args: [sessionId] });
        return {
          cwd: workspace,
          launchCwd: workspace,
          collectedFrom: 'transcript',
          collectedAt: '2026-01-01T00:00:00.000Z',
          toolUsage: [],
        };
      },
    };
  });

  afterEach(async () => {
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  });

  it('refuses every company command from an unprivileged connection', async () => {
    for (const [type, msg] of Object.entries(companyCommands())) {
      outbox = [];
      handleCompanyCommand({ type, ...msg }, send, context({ privileged: false }));
      await vi.waitFor(() => expect(results()).toHaveLength(1));
      expect(results()[0]).toMatchObject({ ok: false, errorCode: 'forbidden' });
    }
    expect(calls).toHaveLength(0);
  });

  it('keeps an untrusted workspace readable but refuses execution and terminal control', async () => {
    const commands = companyCommands();
    const readOnly = new Set([
      'companySnapshotRequest',
      'companyModelCatalogRequest',
      'companyArtifactRequest',
      'companyFileListRequest',
      'companyFileReadRequest',
      'companySessionLogRequest',
      'companySessionInfoRequest',
      'companyOmpSessionsRequest',
      'companyViewMode',
    ]);
    for (const [type, msg] of Object.entries(commands)) {
      if (readOnly.has(type)) continue;
      outbox = [];
      handleCompanyCommand({ type, ...msg }, send, context({ executionAllowed: false }));
      await vi.waitFor(() => expect(results()).toHaveLength(1));
      expect(results()[0]).toMatchObject({ ok: false, errorCode: 'workspace_untrusted' });
    }
    expect(calls).toHaveLength(0);
    expect((services.terminal as RecordingTerminal).calls).toHaveLength(0);

    outbox = [];
    handleCompanyCommand(
      { type: 'companySnapshotRequest', requestId: randomUUID() },
      send,
      context({ executionAllowed: false }),
    );
    await vi.waitFor(() => expect(replies('companySnapshot')).toHaveLength(1));
    expect(replies('companySnapshot')[0].snapshot.revision).toBe(7);
  });

  it('refuses prompt execution when the surface omitted its workspace trust decision', async () => {
    handleCompanyCommand(
      { type: 'companyPromptSubmit', ...companyCommands().companyPromptSubmit },
      send,
      context({ executionAllowed: undefined }),
    );
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(results()[0]).toMatchObject({ ok: false, errorCode: 'workspace_untrusted' });
    expect(calls).toHaveLength(0);
  });

  it('reports an unavailable company surface instead of failing silently', async () => {
    const requestId = randomUUID();
    handleCompanyCommand(
      { type: 'companySnapshotRequest', requestId },
      send,
      context({ services: null }),
    );

    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(results()[0]).toMatchObject({
      requestId,
      ok: false,
      errorCode: 'company_unavailable',
    });
  });

  it('sends the current snapshot for an authorized snapshot request', async () => {
    const requestId = randomUUID();
    handleCompanyCommand({ type: 'companySnapshotRequest', requestId }, send, context());

    await vi.waitFor(() => expect(replies('companySnapshot')).toHaveLength(1));
    const [reply] = replies('companySnapshot');
    expect(reply.requestId).toBe(requestId);
    expect(reply.workspacePath).toBe(workspace);
    expect(reply.snapshot.revision).toBe(7);
  });

  it('rejects an oversized prompt instead of truncating it', async () => {
    handleCompanyCommand(
      {
        type: 'companyPromptSubmit',
        prompt: {
          requestId: randomUUID(),
          text: 'x'.repeat(2 * 1024 * 1024 + 1),
          delivery: 'prompt',
        },
      },
      send,
      context(),
    );

    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(results()[0]).toMatchObject({ ok: false, errorCode: 'prompt_too_large' });
    expect(calls.some((call) => call.method === 'submitPrompt')).toBe(false);
  });

  it('forwards a prompt, contract decision, question answer and session control', async () => {
    const contractId = randomUUID();
    const questionId = randomUUID();
    const sessionId = randomUUID();

    handleCompanyCommand(
      {
        type: 'companyPromptSubmit',
        prompt: { requestId: randomUUID(), text: 'ship it', delivery: 'prompt' },
      },
      send,
      context(),
    );
    handleCompanyCommand(
      {
        type: 'companyContractDecision',
        requestId: randomUUID(),
        contractId,
        revision: 3,
        decision: 'approve',
        note: 'looks right',
      },
      send,
      context(),
    );
    handleCompanyCommand(
      {
        type: 'companyQuestionAnswer',
        answer: { requestId: randomUUID(), questionId, runEpoch: 4, answers: {} },
      },
      send,
      context(),
    );
    handleCompanyCommand(
      {
        type: 'companySessionControl',
        requestId: randomUUID(),
        sessionId,
        runEpoch: 5,
        action: 'restart',
      },
      send,
      context(),
    );

    await vi.waitFor(() => expect(results()).toHaveLength(4));
    expect(results().every((message) => message.ok)).toBe(true);
    const byMethod = new Map(calls.map((call) => [call.method, call]));
    expect([...byMethod.keys()].sort()).toEqual([
      'answerQuestion',
      'controlSession',
      'decideContract',
      'submitPrompt',
    ]);
    expect(byMethod.get('decideContract')?.args).toEqual([contractId, 3, 'approve', 'looks right']);
    // The epoch the client saw travels with the control, so a restart can
    // invalidate a control aimed at the previous run.
    expect(byMethod.get('controlSession')?.args).toEqual([sessionId, 'restart', 5]);
  });

  it('renames a session with a trimmed name and answers an info request with the owner description', async () => {
    const sessionId = randomUUID();
    const renameId = randomUUID();
    handleCompanyCommand(
      { type: 'companySessionRename', requestId: renameId, sessionId, name: '  Triển khai API  ' },
      send,
      context(),
    );
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(results()[0]).toMatchObject({ requestId: renameId, ok: true });
    expect(calls).toContainEqual({ method: 'renameSession', args: [sessionId, 'Triển khai API'] });

    outbox = [];
    const infoId = randomUUID();
    handleCompanyCommand(
      { type: 'companySessionInfoRequest', requestId: infoId, sessionId },
      send,
      context({ executionAllowed: false }),
    );
    await vi.waitFor(() => expect(replies('companySessionInfo')).toHaveLength(1));
    expect(replies('companySessionInfo')[0]).toMatchObject({
      requestId: infoId,
      sessionId,
      info: { collectedFrom: 'transcript', toolUsage: [] },
    });
    expect(calls).toContainEqual({ method: 'sessionInfo', args: [sessionId] });
  });

  it('refuses a session rename whose trimmed name is empty or over the limit', async () => {
    const sessionId = randomUUID();
    const tooLong = 'x'.repeat(COMPANY_SESSION_NAME_MAX_LENGTH + 1);
    for (const name of ['   ', tooLong]) {
      outbox = [];
      handleCompanyCommand(
        { type: 'companySessionRename', requestId: randomUUID(), sessionId, name },
        send,
        context(),
      );
      await vi.waitFor(() => expect(results()).toHaveLength(1));
      expect(results()[0]).toMatchObject({ ok: false, errorCode: 'invalid_session_rename' });
    }
    expect(calls.some((call) => call.method === 'renameSession')).toBe(false);
  });

  it('surfaces a rejected coordinator decision instead of reporting success', async () => {
    const requestId = randomUUID();
    const { coordinator } = fakeCoordinator({
      decideContract: async () => {
        throw Object.assign(new Error('stale'), { code: 'company_revision_conflict' });
      },
    });
    handleCompanyCommand(
      {
        type: 'companyContractDecision',
        requestId,
        contractId: randomUUID(),
        revision: 9,
        decision: 'approve',
      },
      send,
      context({ services: { ...services, coordinator } }),
    );

    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(results()[0]).toMatchObject({
      requestId,
      ok: false,
      errorCode: 'company_revision_conflict',
    });
  });

  it('pages artifacts and rejects ids that are not artifact ids', async () => {
    const bytes = Buffer.alloc(100_000, 0x61);
    const artifactId = await store.writeArtifact(bytes, 'text/plain');

    handleCompanyCommand(
      {
        type: 'companyArtifactRequest',
        requestId: randomUUID(),
        artifactId,
        offset: 0,
        limit: 1_000_000,
      },
      send,
      context(),
    );
    handleCompanyCommand(
      {
        type: 'companyArtifactRequest',
        requestId: randomUUID(),
        artifactId: '../state.json',
        offset: 0,
      },
      send,
      context(),
    );

    await vi.waitFor(() => expect(outbox).toHaveLength(2));
    const [page] = replies('companyArtifactPage');
    expect(page.page.totalBytes).toBe(bytes.length);
    // The client asked for more than a page; the server clamps rather than
    // streaming an unbounded response.
    expect(Buffer.from(page.page.dataBase64, 'base64').length).toBe(64 * 1024);
    expect(results()[0]).toMatchObject({ ok: false, errorCode: 'invalid_artifact_id' });
  });

  it('lists and reads workspace files and refuses paths outside the workspace', async () => {
    handleCompanyCommand(
      { type: 'companyFileListRequest', requestId: randomUUID(), path: '' },
      send,
      context(),
    );
    handleCompanyCommand(
      { type: 'companyFileReadRequest', requestId: randomUUID(), path: 'README.md', offset: 0 },
      send,
      context(),
    );
    handleCompanyCommand(
      { type: 'companyFileReadRequest', requestId: randomUUID(), path: '../secret.txt', offset: 0 },
      send,
      context(),
    );

    await vi.waitFor(() => expect(outbox).toHaveLength(3));
    const [listed] = replies('companyFileList');
    expect(listed.entries.map((entry) => entry.name)).toEqual(['README.md', 'src']);
    const [read] = replies('companyFileRead');
    expect(read.content.text).toBe('# hello\n');
    expect(results()[0]).toMatchObject({ ok: false, errorCode: 'path_outside_workspace' });
  });

  it('replays the newest session log entries, also from an untrusted workspace', async () => {
    const sessionId = randomUUID();
    const log = new SessionLog({
      directory: sessionLogDirectory(store.namespaceDir),
      now: () => '2026-01-01T00:00:00.000Z',
      onEntry: () => {},
    });
    for (const text of ['one', 'two', 'three']) {
      log.record(sessionId, { kind: 'state', runEpoch: 1, text });
    }
    await log.drain();

    const limitedId = randomUUID();
    const unknownId = randomUUID();
    const defaultId = randomUUID();
    handleCompanyCommand(
      { type: 'companySessionLogRequest', requestId: limitedId, sessionId, limit: 2 },
      send,
      context(),
    );
    handleCompanyCommand(
      { type: 'companySessionLogRequest', requestId: unknownId, sessionId: randomUUID(), limit: 5 },
      send,
      context(),
    );
    handleCompanyCommand(
      { type: 'companySessionLogRequest', requestId: defaultId, sessionId },
      send,
      context({ executionAllowed: false }),
    );

    await vi.waitFor(() => expect(replies('companySessionLog')).toHaveLength(3));
    const byRequest = new Map(
      replies('companySessionLog').map((reply) => [reply.requestId, reply] as const),
    );
    expect(byRequest.get(limitedId)).toMatchObject({
      type: 'companySessionLog',
      sessionId,
      replay: true,
    });
    expect(byRequest.get(limitedId)?.entries.map((entry) => entry.text)).toEqual(['two', 'three']);
    expect(byRequest.get(unknownId)?.entries).toEqual([]);
    expect(byRequest.get(defaultId)?.entries.map((entry) => entry.seq)).toEqual([0, 1, 2]);
  });

  it('rejects a session log request with an unsafe session id or an out-of-range limit', async () => {
    const sessionId = randomUUID();
    const badBodies: Record<string, unknown>[] = [
      { sessionId: '../escape', limit: 10 },
      { sessionId: '', limit: 10 },
      { sessionId, limit: 0 },
      { sessionId, limit: 501 },
      { sessionId, limit: 1.5 },
      { sessionId, limit: '10' },
      { limit: 10 },
    ];
    for (const body of badBodies) {
      outbox = [];
      handleCompanyCommand(
        { type: 'companySessionLogRequest', requestId: randomUUID(), ...body },
        send,
        context(),
      );
      await vi.waitFor(() => expect(results()).toHaveLength(1));
      expect(results()[0]).toMatchObject({ ok: false, errorCode: 'invalid_session_log_request' });
    }
    expect(replies('companySessionLog')).toHaveLength(0);
  });

  it('stores an uploaded attachment and returns its digest', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

    handleCompanyCommand(
      {
        type: 'companyAttachmentUpload',
        requestId: randomUUID(),
        fileName: 'shot.png',
        mediaType: 'image/png',
        dataBase64: bytes.toString('base64'),
      },
      send,
      context(),
    );

    await vi.waitFor(() => expect(replies('companyAttachmentUploaded')).toHaveLength(1));
    const [reply] = replies('companyAttachmentUploaded');
    expect(reply.attachment.byteLength).toBe(bytes.length);
    expect(reply.attachment.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const page = await store.readArtifact(reply.attachment.artifactId, 0, 1024);
    expect(Buffer.from(page.dataBase64, 'base64').equals(bytes)).toBe(true);
  });

  it('rejects an attachment whose payload is not valid base64', async () => {
    handleCompanyCommand(
      {
        type: 'companyAttachmentUpload',
        requestId: randomUUID(),
        fileName: 'shot.png',
        mediaType: 'image/png',
        dataBase64: 'not base64 %%%',
      },
      send,
      context(),
    );

    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(results()[0]).toMatchObject({ ok: false, errorCode: 'invalid_attachment' });
  });

  it('routes terminal traffic only for privileged clients and rejects oversized input', async () => {
    const terminalLeaseId = randomUUID();
    const terminal = fakeTerminal(terminalLeaseId);
    const sessionId = randomUUID();
    const attachId = randomUUID();

    handleCompanyCommand(
      { type: 'terminalAttach', requestId: attachId, sessionId, runEpoch: 3 },
      send,
      context({ services: { ...services, terminal } }),
    );
    handleCompanyCommand(
      {
        type: 'terminalInput',
        sessionId,
        runEpoch: 3,
        leaseId: terminalLeaseId,
        data: 'x'.repeat(9000),
      },
      send,
      context({ services: { ...services, terminal } }),
    );
    handleCompanyCommand(
      { type: 'terminalInput', sessionId, runEpoch: 3, data: 'y'.repeat(64) },
      send,
      context({ services: { ...services, terminal }, privileged: false }),
    );

    await vi.waitFor(() => expect(outbox).toHaveLength(3));
    const [attached] = replies('terminalAttached');
    expect(attached.requestId).toBe(attachId);
    expect(attached.sessionId).toBe(sessionId);
    // An input chunk over the wire limit never reaches the PTY, and an
    // unprivileged client never writes to a terminal.
    expect(terminal.calls.filter((call) => call.method === 'write')).toHaveLength(0);
    const codes = results().map((message) => message.errorCode);
    expect(codes).toContain('terminal_input_too_large');
    expect(codes).toContain('forbidden');
  });
  it('requires the current lease for terminal input, resize, and detach', async () => {
    const leaseId = randomUUID();
    const terminal = fakeTerminal(leaseId);
    const sessionId = randomUUID();
    const attached: Array<[string, string]> = [];
    const detached: Array<[string, string]> = [];

    handleCompanyCommand(
      { type: 'terminalAttach', requestId: randomUUID(), sessionId, runEpoch: 3 },
      send,
      context({
        services: { ...services, terminal },
        onTerminalAttached: (id, attachedLease) => attached.push([id, attachedLease]),
      }),
    );
    const input = (lease?: string) =>
      handleCompanyCommand(
        {
          type: 'terminalInput',
          sessionId,
          runEpoch: 3,
          data: 'echo lease-check',
          ...(lease === undefined ? {} : { leaseId: lease }),
        },
        send,
        context({ services: { ...services, terminal } }),
      );
    const resize = (lease?: string) =>
      handleCompanyCommand(
        {
          type: 'terminalResize',
          sessionId,
          runEpoch: 3,
          cols: 100,
          rows: 30,
          ...(lease === undefined ? {} : { leaseId: lease }),
        },
        send,
        context({ services: { ...services, terminal } }),
      );
    const detach = (lease?: string) =>
      handleCompanyCommand(
        {
          type: 'terminalDetach',
          sessionId,
          runEpoch: 3,
          ...(lease === undefined ? {} : { leaseId: lease }),
        },
        send,
        context({
          services: { ...services, terminal },
          onTerminalDetached: (id, detachedLease?: string) => {
            if (detachedLease !== undefined) detached.push([id, detachedLease]);
          },
        }),
      );
    const staleLease = randomUUID();

    input();
    input(staleLease);
    input(leaseId);
    resize();
    resize(staleLease);
    resize(leaseId);
    detach();
    detach(staleLease);
    detach(leaseId);

    await vi.waitFor(() => expect(results()).toHaveLength(9));
    const failures = results().filter((result) => !result.ok);
    expect(failures.map((result) => result.errorCode).sort()).toEqual(
      [
        'invalid_terminal_detach',
        'invalid_terminal_input',
        'invalid_terminal_lease',
        'invalid_terminal_lease',
        'invalid_terminal_lease',
        'invalid_terminal_resize',
      ].sort(),
    );
    expect(terminal.calls.filter((call) => call.method === 'write')).toEqual([
      { method: 'write', args: [sessionId, 3, 'echo lease-check', leaseId] },
    ]);
    expect(terminal.calls.filter((call) => call.method === 'resize')).toEqual([
      { method: 'resize', args: [sessionId, 3, 100, 30, leaseId] },
    ]);
    expect(terminal.calls.filter((call) => call.method === 'detach')).toEqual([
      { method: 'detach', args: [sessionId, 3, leaseId] },
    ]);
    expect(attached).toEqual([[sessionId, leaseId]]);
    expect(detached).toEqual([[sessionId, leaseId]]);
  });

  it('answers a model catalog request with catalog entries', async () => {
    handleCompanyCommand(
      { type: 'companyModelCatalogRequest', requestId: randomUUID() },
      send,
      context({
        services: {
          ...services,
          modelCatalog: async () => [
            {
              id: 'provider/model',
              provider: 'provider',
              model: 'model',
              thinking: ['high'],
              acceptsImages: false,
              credentialsConfigured: true,
            },
          ],
        },
      }),
    );

    await vi.waitFor(() => expect(replies('companyModelCatalog')).toHaveLength(1));
    expect(replies('companyModelCatalog')[0].entries).toHaveLength(1);
  });

  it('routes interrupt, delete, prompt withdrawal and resume to the coordinator and lists OMP sessions', async () => {
    const sessionId = randomUUID();
    const promptId = randomUUID();
    const resumeId = randomUUID();
    const listId = randomUUID();
    for (const action of ['interrupt', 'delete'] as const) {
      handleCompanyCommand(
        { type: 'companySessionControl', requestId: randomUUID(), sessionId, runEpoch: 2, action },
        send,
        context(),
      );
    }
    handleCompanyCommand(
      { type: 'companyPromptCancel', requestId: randomUUID(), promptId },
      send,
      context(),
    );
    handleCompanyCommand(
      { type: 'companySessionResume', requestId: resumeId, file: '/omp/saved.jsonl' },
      send,
      context(),
    );
    await vi.waitFor(() => expect(results()).toHaveLength(4));
    expect(results().every((result) => result.ok)).toBe(true);
    expect(results().find((result) => result.requestId === resumeId)).toMatchObject({
      ok: true,
      sessionId: 'session-resumed',
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        { method: 'controlSession', args: [sessionId, 'interrupt', 2] },
        { method: 'controlSession', args: [sessionId, 'delete', 2] },
        { method: 'cancelPrompt', args: [promptId] },
        { method: 'resumeOmpSession', args: ['/omp/saved.jsonl'] },
      ]),
    );

    outbox = [];
    handleCompanyCommand(
      { type: 'companyOmpSessionsRequest', requestId: listId },
      send,
      context({ executionAllowed: false }),
    );
    await vi.waitFor(() => expect(replies('companyOmpSessions')).toHaveLength(1));
    expect(replies('companyOmpSessions')[0]).toMatchObject({
      requestId: listId,
      folder: 'C:/workspace',
      sessions: [],
    });
    expect(calls).toContainEqual({ method: 'listOmpSessions', args: [] });
  });

  it('opens a new chat with no prompt and answers its board session id', async () => {
    const requestId = randomUUID();
    handleCompanyCommand({ type: 'companyChatNew', requestId }, send, context());
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(results()[0]).toMatchObject({ requestId, ok: true, sessionId: 'session-new-chat' });
    expect(calls).toContainEqual({ method: 'openNewChat', args: [] });
  });

  it('refuses a prompt withdrawal or resume without a target before reaching the coordinator', async () => {
    handleCompanyCommand(
      { type: 'companyPromptCancel', requestId: randomUUID(), promptId: '' },
      send,
      context(),
    );
    handleCompanyCommand(
      { type: 'companySessionResume', requestId: randomUUID(), file: '' },
      send,
      context(),
    );
    await vi.waitFor(() => expect(results()).toHaveLength(2));
    expect(
      results()
        .map((result) => result.errorCode)
        .sort(),
    ).toEqual(['invalid_prompt_cancel', 'invalid_session_resume']);
    expect(
      calls.some((call) => call.method === 'cancelPrompt' || call.method === 'resumeOmpSession'),
    ).toBe(false);
  });

  describe('across open folders', () => {
    /** A second open folder beside the active one, with its own coordinator and store. */
    async function openSecondFolder(overrides: Partial<CompanyCoordinator> = {}) {
      const root = path.join(tempHome, 'other');
      await fs.promises.mkdir(root, { recursive: true });
      const otherStore = await RealCompanyStore.open(root);
      await otherStore.load();
      const fake = fakeCoordinator(overrides);
      const folderServices: CompanyCommandServices = {
        ...services,
        coordinator: fake.coordinator,
        store: otherStore,
        workspaceRoot: root,
      };
      return { root, services: folderServices, calls: fake.calls };
    }

    /** A folder control over the given open folders; `activeRoot` names the active one. */
    function controlOver(
      open: Record<string, CompanyCommandServices>,
      activeRoot: string | null,
    ): CompanyWorkspaceControl {
      const find = (root: string): CompanyCommandServices | null =>
        Object.hasOwn(open, root) ? open[root] : null;
      return {
        entries: () =>
          Object.keys(open).map((root) => ({
            path: root,
            active: root === activeRoot,
            open: true,
            working: 0,
            waiting: 0,
          })),
        open: async () => {
          throw new Error('folder switching is not exercised here');
        },
        ensure: async (root) => {
          const found = find(root);
          if (found === null) {
            throw new CompanyError('workspace_invalid', `Không tìm thấy thư mục: ${root}`);
          }
          return found;
        },
        servicesFor: find,
        servicesHolding: (id) =>
          Object.values(open).find((candidate) => candidate.coordinator.holdsId(id)) ?? null,
        activeServices: () => (activeRoot === null ? null : find(activeRoot)),
        activePath: () => activeRoot,
        setFolderName: () => undefined,
        forget: async () => undefined,
      };
    }

    it('runs a command in the folder its workspacePath names, not the active one', async () => {
      const second = await openSecondFolder();
      const workspaces = controlOver(
        { [workspace]: services, [second.root]: second.services },
        workspace,
      );
      handleCompanyCommand(
        { type: 'companyChatNew', requestId: randomUUID(), workspacePath: second.root },
        send,
        context({ workspaces }),
      );
      await vi.waitFor(() => expect(results()).toHaveLength(1));
      expect(results()[0]).toMatchObject({ ok: true, sessionId: 'session-new-chat' });
      expect(second.calls).toEqual([{ method: 'openNewChat', args: [] }]);
      expect(calls).toHaveLength(0);
    });

    it('routes a command bound to an id to the open folder that holds that id', async () => {
      const heldSession = randomUUID();
      const second = await openSecondFolder({ holdsId: (id) => id === heldSession });
      const workspaces = controlOver(
        { [workspace]: services, [second.root]: second.services },
        workspace,
      );
      handleCompanyCommand(
        {
          type: 'companySessionControl',
          requestId: randomUUID(),
          sessionId: heldSession,
          runEpoch: 2,
          action: 'pause',
        },
        send,
        context({ workspaces }),
      );
      await vi.waitFor(() => expect(results()).toHaveLength(1));
      expect(results()[0]).toMatchObject({ ok: true });
      expect(second.calls.map((call) => call.method)).toEqual(['controlSession']);
      expect(calls).toHaveLength(0);
    });

    it('sends an id no open folder holds to the active folder', async () => {
      const second = await openSecondFolder();
      const workspaces = controlOver(
        { [workspace]: services, [second.root]: second.services },
        workspace,
      );
      handleCompanyCommand(
        {
          type: 'companySessionControl',
          requestId: randomUUID(),
          sessionId: randomUUID(),
          runEpoch: 2,
          action: 'pause',
        },
        send,
        context({ workspaces }),
      );
      await vi.waitFor(() => expect(results()).toHaveLength(1));
      expect(calls.map((call) => call.method)).toEqual(['controlSession']);
      expect(second.calls).toHaveLength(0);
    });

    it('refuses a creation command that names no folder, even while a folder is active', async () => {
      const workspaces = controlOver({ [workspace]: services }, workspace);
      handleCompanyCommand(
        { type: 'companyChatNew', requestId: randomUUID() },
        send,
        context({ workspaces }),
      );
      handleCompanyCommand(
        { type: 'companySessionResume', requestId: randomUUID(), file: '/omp/saved.jsonl' },
        send,
        context({ workspaces }),
      );
      handleCompanyCommand(
        {
          type: 'companyPromptSubmit',
          prompt: { requestId: randomUUID(), text: 'start', delivery: 'prompt' },
        },
        send,
        context({ workspaces }),
      );
      await vi.waitFor(() => expect(results()).toHaveLength(3));
      expect(results().map((result) => result.errorCode)).toEqual([
        'workspace_required',
        'workspace_required',
        'workspace_required',
      ]);
      expect(calls).toHaveLength(0);
    });

    it('routes a prompt aimed at a session to the folder holding that session', async () => {
      const heldSession = randomUUID();
      const second = await openSecondFolder({ holdsId: (id) => id === heldSession });
      const workspaces = controlOver(
        { [workspace]: services, [second.root]: second.services },
        workspace,
      );
      handleCompanyCommand(
        {
          type: 'companyPromptSubmit',
          prompt: {
            requestId: randomUUID(),
            text: 'continue',
            delivery: 'prompt',
            targetSessionId: heldSession,
          },
        },
        send,
        context({ workspaces }),
      );
      await vi.waitFor(() => expect(results()).toHaveLength(1));
      expect(results()[0]).toMatchObject({ ok: true });
      expect(second.calls.map((call) => call.method)).toEqual(['submitPrompt']);
      expect(calls).toHaveLength(0);
    });

    it('refuses a command that names a folder which cannot be opened, and runs nothing', async () => {
      const workspaces = controlOver({ [workspace]: services }, workspace);
      handleCompanyCommand(
        {
          type: 'companyChatNew',
          requestId: randomUUID(),
          workspacePath: path.join(tempHome, 'missing'),
        },
        send,
        context({ workspaces }),
      );
      await vi.waitFor(() => expect(results()).toHaveLength(1));
      expect(results()[0]).toMatchObject({ ok: false, errorCode: 'workspace_invalid' });
      expect(calls).toHaveLength(0);
    });

    it('records the company view through the callback and refuses an unknown view', async () => {
      const modes: string[] = [];
      const requestId = randomUUID();
      handleCompanyCommand(
        { type: 'companyViewMode', requestId, mode: 'all' },
        send,
        context({ onCompanyViewMode: (mode) => modes.push(mode) }),
      );
      handleCompanyCommand(
        { type: 'companyViewMode', requestId: randomUUID(), mode: 'everything' },
        send,
        context({ onCompanyViewMode: (mode) => modes.push(mode) }),
      );
      await vi.waitFor(() => expect(results()).toHaveLength(2));
      expect(results().find((result) => result.requestId === requestId)).toMatchObject({
        ok: true,
      });
      expect(results().find((result) => result.errorCode === 'invalid_request')).toBeDefined();
      expect(modes).toEqual(['all']);
    });

    it('answers an all-folders snapshot request with one tagged snapshot per open folder', async () => {
      const second = await openSecondFolder();
      const workspaces = controlOver(
        { [workspace]: services, [second.root]: second.services },
        workspace,
      );
      const requestId = randomUUID();
      handleCompanyCommand(
        { type: 'companySnapshotRequest', requestId },
        send,
        context({ workspaces, companyViewMode: () => 'all' }),
      );
      await vi.waitFor(() => expect(replies('companySnapshot')).toHaveLength(2));
      expect(replies('companySnapshot').map((reply) => reply.workspacePath)).toEqual([
        workspace,
        second.root,
      ]);
      expect(replies('companySnapshot').every((reply) => reply.requestId === requestId)).toBe(true);
    });

    it('answers a snapshot request with the active folder only when the view is folder', async () => {
      const second = await openSecondFolder();
      const workspaces = controlOver(
        { [workspace]: services, [second.root]: second.services },
        workspace,
      );
      handleCompanyCommand(
        { type: 'companySnapshotRequest', requestId: randomUUID() },
        send,
        context({ workspaces, companyViewMode: () => 'folder' }),
      );
      await vi.waitFor(() => expect(replies('companySnapshot')).toHaveLength(1));
      expect(replies('companySnapshot')[0].workspacePath).toBe(workspace);
      expect(second.calls).toHaveLength(0);
    });

    it('answers a snapshot request that names a folder, and refuses one that is not open', async () => {
      const second = await openSecondFolder();
      const workspaces = controlOver(
        { [workspace]: services, [second.root]: second.services },
        workspace,
      );
      handleCompanyCommand(
        { type: 'companySnapshotRequest', requestId: randomUUID(), workspacePath: second.root },
        send,
        context({ workspaces }),
      );
      await vi.waitFor(() => expect(replies('companySnapshot')).toHaveLength(1));
      expect(replies('companySnapshot')[0].workspacePath).toBe(second.root);
      handleCompanyCommand(
        {
          type: 'companySnapshotRequest',
          requestId: randomUUID(),
          workspacePath: path.join(tempHome, 'closed'),
        },
        send,
        context({ workspaces }),
      );
      await vi.waitFor(() => expect(results()).toHaveLength(1));
      expect(results()[0]).toMatchObject({ ok: false, errorCode: 'workspace_not_open' });
    });
  });

  describe('work item commands', () => {
    const PANE = 'wA:p1';

    /** Gives the folder a work item service with in-memory ports, and returns it. */
    async function withWorkItems(): Promise<WorkItemService> {
      const work = new WorkItemService(workspace, {
        roster: {
          panes: () => ({ available: true, panes: [{ paneId: PANE, status: 'idle' }] }),
          prompt: async () => undefined,
          screenText: async () => '',
        },
        sessions: {
          list: () => [],
          submit: async () => undefined,
          openChat: async () => {
            throw new Error('no chat in this test');
          },
        },
        persistence: {
          load: async () => parseWorkItemsFile(null),
          save: async () => undefined,
        },
        publish: (message) => {
          outbox.push(message);
        },
        now: () => Date.now(),
        newId: () => randomUUID(),
        schedule: () => () => undefined,
        catalog: async () => ({ repos: [], agents: [] }),
        freeMemoryBytes: () => 8 * 1024 ** 3,
        worktrees: {
          create: async (repo, shortId) => ({
            path: path.join(repo, '.worktrees', `squad-${shortId}`),
            branch: `squad-${shortId}`,
          }),
        },
      });
      await work.load();
      services = { ...services, workItems: work };
      return work;
    }

    it('creates an item through the dispatcher and replies with its id', async () => {
      await withWorkItems();
      handleCompanyCommand(
        {
          type: 'companyWorkItemCreate',
          requestId: randomUUID(),
          workspacePath: workspace,
          text: 'Việc',
          assignee: { kind: 'herdr', paneId: PANE },
        },
        send,
        context(),
      );
      await vi.waitFor(() => expect(results()).toHaveLength(1));
      expect(results()[0]).toMatchObject({ ok: true, workItemId: expect.any(String) });
      expect(replies('companyWorkItems').at(-1)?.items).toHaveLength(1);
    });

    it('refuses work item commands the folder cannot serve or cannot accept', async () => {
      // A folder with no work item service (a follower) cannot change its items.
      handleCompanyCommand(
        {
          type: 'companyWorkItemCreate',
          requestId: randomUUID(),
          workspacePath: workspace,
          text: 'x',
          assignee: { kind: 'herdr', paneId: PANE },
        },
        send,
        context(),
      );
      await vi.waitFor(() => expect(results()).toHaveLength(1));
      expect(results()[0]).toMatchObject({ ok: false, errorCode: 'company_unavailable' });

      await withWorkItems();
      outbox = [];
      handleCompanyCommand(
        {
          type: 'companyWorkItemCreate',
          requestId: randomUUID(),
          workspacePath: workspace,
          text: 'x',
          assignee: { kind: 'queue' },
        },
        send,
        context(),
      );
      await vi.waitFor(() => expect(results()).toHaveLength(1));
      expect(results()[0]).toMatchObject({ ok: false, errorCode: 'assignee_invalid' });

      outbox = [];
      handleCompanyCommand(
        {
          type: 'companyWorkItemMark',
          requestId: randomUUID(),
          workspacePath: workspace,
          id: 'missing',
          verdict: 'maybe',
        },
        send,
        context(),
      );
      await vi.waitFor(() => expect(results()).toHaveLength(1));
      expect(results()[0]).toMatchObject({ ok: false, errorCode: 'invalid_work_item_verdict' });

      outbox = [];
      handleCompanyCommand(
        {
          type: 'companyWorkItemCancel',
          requestId: randomUUID(),
          workspacePath: workspace,
          id: 'missing',
        },
        send,
        context({ executionAllowed: false }),
      );
      await vi.waitFor(() => expect(results()).toHaveLength(1));
      expect(results()[0]).toMatchObject({ ok: false, errorCode: 'workspace_untrusted' });
    });

    it('sends the folder work items with its snapshot', async () => {
      await withWorkItems();
      handleCompanyCommand(
        { type: 'companySnapshotRequest', requestId: randomUUID(), workspacePath: workspace },
        send,
        context(),
      );
      await vi.waitFor(() => expect(replies('companySnapshot')).toHaveLength(1));
      expect(replies('companyWorkItems')).toEqual([
        expect.objectContaining({ type: 'companyWorkItems', items: [] }),
      ]);
    });
  });
});
