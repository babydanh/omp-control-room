import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  Attempt,
  CompanyChange,
  CompanyEvent,
  CompanySession,
  CompanyState,
  Contract,
  Question,
} from '../../core/src/company.js';
import type { CompanyPrompt } from '../../core/src/messages.js';
import { WorkspaceCompanyCoordinator } from '../src/company/companyCoordinatorRuntime.js';
import { applyCompanyEvent } from '../src/company/companyState.js';
import type { CompanyStore as CompanyStoreType } from '../src/company/companyStore.js';
import { CompanyStore } from '../src/company/companyStore.js';
import { ompSessionDirForFolder, ompSessionsRoot } from '../src/company/ompSessionFiles.js';
import { removeSessionLog, sessionLogDirectory } from '../src/company/sessionLog.js';
import { UsageLedger } from '../src/company/usageService.js';

// The mock factory reads the sandbox at call time; vi.hoisted keeps it ahead of the imports.
const sandbox = vi.hoisted(() => ({ home: '' }));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof os>('os');
  return { ...actual, homedir: () => sandbox.home };
});

let tempHome: string;

type Effects = ConstructorParameters<typeof WorkspaceCompanyCoordinator>[0]['effects'];

const now = '2026-10-02T00:00:00.000Z';

const diagnostics = {
  liveRunners: 0,
  modelLeases: 0,
  nativeJobs: 0,
  queuedTasks: 0,
  pendingQuestions: 0,
  retainedSessions: 0,
  archivedSessions: 0,
  terminalBufferedBytes: 0,
  ownedHandleCount: 0,
  measuredAt: now,
};

function event(state: CompanyState, change: CompanyChange): CompanyEvent {
  return {
    id: randomUUID(),
    sequence: state.revision + 1,
    baseRevision: state.revision,
    at: now,
    changes: [change],
  };
}

function session(id: string, patch: Partial<CompanySession> = {}): CompanySession {
  return {
    id,
    code: 'PA-S0001',
    name: 'Worker 1',
    role: 'worker',
    workstreamId: 'stream-a',
    workspaceKey: 'workspace-a',
    requestedModel: 'provider/model',
    runEpoch: 0,
    status: 'idle',
    lastUsedAt: now,
    ...patch,
  };
}

function prompt(id: string, targetSessionId?: string): CompanyPrompt {
  return {
    id,
    rawTextArtifactId: randomUUID(),
    preview: 'Yêu cầu thử nghiệm',
    createdAt: now,
    fragments: [],
    ...(targetSessionId === undefined ? {} : { targetSessionId }),
  };
}

function contract(id: string, promptIds: string[]): Contract {
  return {
    id,
    code: 'PA-C0001',
    revision: 2,
    promptIds,
    requirements: [],
    phases: [],
    tasks: [],
    assumptions: [],
    decisions: [],
    acceptance: [],
    status: 'awaiting_approval',
  };
}

const put = (value: CompanySession): CompanyChange => ({
  entity: 'session',
  op: 'put',
  id: value.id,
  value,
});

async function seed(store: CompanyStoreType, changes: CompanyChange[]): Promise<CompanyState> {
  let state = await store.load();
  for (const change of changes) {
    const next = event(state, change);
    await store.commit(next);
    state = applyCompanyEvent(state, next);
  }
  return state;
}

function effects(overrides: Partial<Effects> = {}): Effects {
  return {
    getModelCatalog: async () => [],
    diagnostics: () => diagnostics,
    onPromptSubmitted: async () => undefined,
    parkSquadSession: async () => false,
    openChatSession: async () => {
      throw new Error('openChatSession is not used by this test');
    },
    onContractDecision: async () => undefined,
    onQuestionAnswered: async () => undefined,
    controlSession: async (record) => ({ status: record.status }),
    deleteSession: async () => undefined,
    onSettingsUpdated: async () => undefined,
    onStateChanged: () => undefined,
    recover: async () => undefined,
    dispose: async () => undefined,
    ...overrides,
  };
}

describe('session lifecycle on the workspace coordinator', () => {
  let workspace: string;
  let savedAgentDir: string | undefined;

  beforeEach(async () => {
    tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pxl-session-lifecycle-'));
    sandbox.home = tempHome;
    workspace = path.join(tempHome, 'workspace');
    await fs.promises.mkdir(workspace);
    savedAgentDir = process.env['PI_CODING_AGENT_DIR'];
    delete process.env['PI_CODING_AGENT_DIR'];
    // Every OMP file this suite writes must stay under the temporary home.
    expect(ompSessionsRoot().startsWith(tempHome)).toBe(true);
  });

  afterEach(async () => {
    if (savedAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = savedAgentDir;
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  });

  async function open(changes: CompanyChange[], overrides: Partial<Effects> = {}) {
    const store = await CompanyStore.open(workspace);
    const state = await seed(store, changes);
    const coordinator = new WorkspaceCompanyCoordinator({
      store,
      state,
      usageLedger: new UsageLedger(),
      isOwner: () => true,
      now: () => now,
      effects: effects(overrides),
    });
    await coordinator.start();
    return coordinator;
  }

  it('interrupts a busy session through its effect and leaves the board untouched', async () => {
    const interrupted: string[] = [];
    const coordinator = await open([put(session('worker-busy', { status: 'busy', runEpoch: 3 }))], {
      controlSession: async (record, action) => {
        interrupted.push(`${record.id}:${action}`);
        return { status: record.status };
      },
    });
    const before = coordinator.snapshot().revision;

    await coordinator.controlSession('worker-busy', 'interrupt', 3);

    expect(interrupted).toEqual(['worker-busy:interrupt']);
    expect(coordinator.snapshot().revision).toBe(before);
    expect(coordinator.snapshot().sessions.find((s) => s.id === 'worker-busy')?.status).toBe(
      'busy',
    );
    await coordinator.dispose();
  });

  it('refuses to interrupt a session that is not running a turn', async () => {
    const calls: string[] = [];
    const coordinator = await open([put(session('worker-idle'))], {
      controlSession: async (record) => {
        calls.push(record.id);
        return { status: record.status };
      },
    });

    await expect(coordinator.controlSession('worker-idle', 'interrupt', 0)).rejects.toMatchObject({
      code: 'session_not_busy',
    });
    expect(calls).toEqual([]);
    await coordinator.dispose();
  });

  it('deletes an idle session through its effect and drops it from the board', async () => {
    const deleted: string[] = [];
    const coordinator = await open(
      [put(session('worker-idle', { nativeSessionPath: path.join(workspace, 'x.jsonl') }))],
      {
        deleteSession: async (sessionId) => {
          deleted.push(sessionId);
        },
      },
    );

    await coordinator.controlSession('worker-idle', 'delete', 0);

    expect(deleted).toEqual(['worker-idle']);
    expect(coordinator.snapshot().sessions.map((s) => s.id)).not.toContain('worker-idle');
    await coordinator.dispose();
  });

  it('refuses to delete a running session and keeps it on the board', async () => {
    const deleted: string[] = [];
    const coordinator = await open([put(session('worker-busy', { status: 'busy' }))], {
      deleteSession: async (sessionId) => {
        deleted.push(sessionId);
      },
    });

    await expect(coordinator.controlSession('worker-busy', 'delete', 0)).rejects.toMatchObject({
      code: 'session_running',
    });
    expect(deleted).toEqual([]);
    expect(coordinator.snapshot().sessions.map((s) => s.id)).toContain('worker-busy');
    await coordinator.dispose();
  });

  it('refuses to delete a session that still has a running attempt', async () => {
    const attempt: Attempt = {
      id: 'attempt-1',
      taskId: 'task-1',
      sessionId: 'worker-idle',
      runEpoch: 0,
      startedAt: now,
      status: 'running',
      changes: [],
      evidenceIds: [],
    };
    const coordinator = await open([
      put(session('worker-idle')),
      { entity: 'attempt', op: 'put', id: attempt.id, value: attempt },
    ]);

    await expect(coordinator.controlSession('worker-idle', 'delete', 0)).rejects.toMatchObject({
      code: 'session_holds_task',
    });
    expect(coordinator.snapshot().sessions.map((s) => s.id)).toContain('worker-idle');
    await coordinator.dispose();
  });

  it('refuses to delete a session that has a pending question', async () => {
    const question: Question = {
      id: 'question-1',
      sessionId: 'worker-idle',
      runEpoch: 0,
      kind: 'clarification',
      title: 'Hỏi',
      questions: [],
      status: 'pending',
      createdAt: now,
    };
    const coordinator = await open([
      put(session('worker-idle')),
      { entity: 'question', op: 'put', id: question.id, value: question },
    ]);

    await expect(coordinator.controlSession('worker-idle', 'delete', 0)).rejects.toMatchObject({
      code: 'session_holds_question',
    });
    await coordinator.dispose();
  });

  it('refuses to delete a session that an open Contract still holds through a prompt', async () => {
    const coordinator = await open([
      put(session('worker-idle')),
      { entity: 'prompt', op: 'put', id: 'prompt-1', value: prompt('prompt-1', 'worker-idle') },
      {
        entity: 'contract',
        op: 'put',
        id: 'contract-1',
        value: contract('contract-1', ['prompt-1']),
      },
    ]);

    await expect(coordinator.controlSession('worker-idle', 'delete', 0)).rejects.toMatchObject({
      code: 'session_in_contract',
    });
    await coordinator.dispose();
  });

  it('withdraws a prompt no Contract holds and deletes the Director it was routed to', async () => {
    const deleted: string[] = [];
    const coordinator = await open(
      [
        put(session('director-1', { role: 'director', name: 'Director' })),
        { entity: 'prompt', op: 'put', id: 'prompt-1', value: prompt('prompt-1', 'director-1') },
      ],
      {
        deleteSession: async (sessionId) => {
          deleted.push(sessionId);
        },
      },
    );

    await coordinator.cancelPrompt('prompt-1');

    expect(deleted).toEqual(['director-1']);
    expect(coordinator.snapshot().prompts).toEqual([]);
    expect(coordinator.snapshot().sessions.map((s) => s.id)).not.toContain('director-1');
    await coordinator.dispose();
  });

  it('keeps a chat session when the prompt routed to it is withdrawn', async () => {
    const deleted: string[] = [];
    const coordinator = await open(
      [
        put(session('chat-1', { role: 'chat', name: 'Chat' })),
        { entity: 'prompt', op: 'put', id: 'prompt-1', value: prompt('prompt-1', 'chat-1') },
      ],
      {
        deleteSession: async (sessionId) => {
          deleted.push(sessionId);
        },
      },
    );

    await coordinator.cancelPrompt('prompt-1');

    expect(deleted).toEqual([]);
    expect(coordinator.snapshot().prompts).toEqual([]);
    expect(coordinator.snapshot().sessions.map((s) => s.id)).toContain('chat-1');
    await coordinator.dispose();
  });

  it('keeps a Director that still holds another prompt when one of its prompts is withdrawn', async () => {
    const deleted: string[] = [];
    const coordinator = await open(
      [
        put(session('director-1', { role: 'director', name: 'Director' })),
        { entity: 'prompt', op: 'put', id: 'prompt-1', value: prompt('prompt-1', 'director-1') },
        { entity: 'prompt', op: 'put', id: 'prompt-2', value: prompt('prompt-2', 'director-1') },
      ],
      {
        deleteSession: async (sessionId) => {
          deleted.push(sessionId);
        },
      },
    );

    await coordinator.cancelPrompt('prompt-1');

    expect(deleted).toEqual([]);
    expect(coordinator.snapshot().prompts.map((p) => p.id)).toEqual(['prompt-2']);
    expect(coordinator.snapshot().sessions.map((s) => s.id)).toContain('director-1');
    await coordinator.dispose();
  });

  it('refuses to withdraw a prompt that a Contract holds and reports an unknown prompt', async () => {
    const coordinator = await open([
      put(session('director-1', { role: 'director', name: 'Director' })),
      { entity: 'prompt', op: 'put', id: 'prompt-1', value: prompt('prompt-1', 'director-1') },
      {
        entity: 'contract',
        op: 'put',
        id: 'contract-1',
        value: contract('contract-1', ['prompt-1']),
      },
    ]);

    await expect(coordinator.cancelPrompt('prompt-1')).rejects.toMatchObject({
      code: 'prompt_in_contract',
    });
    await expect(coordinator.cancelPrompt('prompt-missing')).rejects.toMatchObject({
      code: 'prompt_not_found',
    });
    expect(coordinator.snapshot().prompts.map((p) => p.id)).toEqual(['prompt-1']);
    await coordinator.dispose();
  });

  it('lists the workspace OMP sessions newest first and links the ones a board session holds', async () => {
    const dir = ompSessionDirForFolder(workspace);
    await fs.promises.mkdir(dir, { recursive: true });
    const older = path.join(dir, 'older.jsonl');
    const newer = path.join(dir, 'newer.jsonl');
    await fs.promises.writeFile(
      older,
      `${JSON.stringify({ type: 'title', title: 'Thiết kế API' })}\n`,
    );
    await fs.promises.writeFile(newer, '{"type":"session","id":"n"}\n');
    await fs.promises.writeFile(path.join(dir, 'notes.txt'), 'bỏ qua');
    await fs.promises.utimes(older, new Date('2026-01-01'), new Date('2026-01-01'));
    await fs.promises.utimes(newer, new Date('2026-02-01'), new Date('2026-02-01'));
    const coordinator = await open([put(session('worker-1', { nativeSessionPath: newer }))]);

    const listing = await coordinator.listOmpSessions();

    expect(path.basename(listing.folder)).toBe('workspace');
    expect(listing.sessions.map((entry) => path.basename(entry.file))).toEqual([
      'newer.jsonl',
      'older.jsonl',
    ]);
    expect(listing.sessions[0]).toMatchObject({ boardSessionId: 'worker-1' });
    expect(listing.sessions[1]).toMatchObject({ title: 'Thiết kế API' });
    expect(listing.sessions[1]?.boardSessionId).toBeUndefined();
    await coordinator.dispose();
  });

  it('lists the OMP sessions of the repos the folder holds and of board sessions inside it', async () => {
    const repo = path.join(workspace, 'repo-a');
    const sessionCwd = path.join(workspace, 'worktree-b');
    await fs.promises.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.promises.mkdir(sessionCwd);
    const repoFile = path.join(ompSessionDirForFolder(repo), 'repo.jsonl');
    const boardFile = path.join(ompSessionDirForFolder(sessionCwd), 'board.jsonl');
    await fs.promises.mkdir(path.dirname(repoFile), { recursive: true });
    await fs.promises.mkdir(path.dirname(boardFile), { recursive: true });
    await fs.promises.writeFile(repoFile, '{}\n');
    await fs.promises.writeFile(boardFile, '{}\n');
    const coordinator = await open([
      put(session('worker-b', { cwd: sessionCwd, nativeSessionPath: boardFile })),
    ]);

    const listing = await coordinator.listOmpSessions();

    expect(listing.sessions.map((entry) => path.basename(entry.file)).sort()).toEqual([
      'board.jsonl',
      'repo.jsonl',
    ]);
    expect(listing.sessions.find((entry) => entry.file === boardFile)).toMatchObject({
      boardSessionId: 'worker-b',
    });
    await coordinator.dispose();
  });

  it('opens a saved OMP session as a chat session through the effect', async () => {
    const dir = ompSessionDirForFolder(workspace);
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'saved.jsonl');
    await fs.promises.writeFile(file, '{}\n');
    const opened: (string | undefined)[] = [];
    const coordinator = await open([], {
      openChatSession: async (input) => {
        opened.push(input.resumeFile);
        return session('chat-1', { role: 'chat', name: 'Chat' });
      },
    });

    await expect(coordinator.resumeOmpSession(file)).resolves.toBe('chat-1');

    expect(opened).toEqual([file]);
    await coordinator.dispose();
  });

  it('resumes a repo session in its repo, taking the directory from the file header', async () => {
    const repo = path.join(workspace, 'repo-a');
    await fs.promises.mkdir(path.join(repo, '.git'), { recursive: true });
    const dir = ompSessionDirForFolder(repo);
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'repo.jsonl');
    await fs.promises.writeFile(
      file,
      `${JSON.stringify({ type: 'session', id: 'repo', cwd: repo })}\n`,
    );
    const opened: unknown[] = [];
    const coordinator = await open([], {
      openChatSession: async (input) => {
        opened.push(input);
        return session('chat-repo', { role: 'chat', name: 'Chat' });
      },
    });

    await expect(coordinator.resumeOmpSession(file)).resolves.toBe('chat-repo');

    expect(opened).toEqual([{ resumeFile: file, cwd: await fs.promises.realpath(repo) }]);
    await coordinator.dispose();
  });

  it('resumes a session whose header names a directory outside the folder in the folder root', async () => {
    const repo = path.join(workspace, 'repo-a');
    const elsewhere = path.join(tempHome, 'elsewhere');
    await fs.promises.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.promises.mkdir(elsewhere);
    const dir = ompSessionDirForFolder(repo);
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'stray.jsonl');
    await fs.promises.writeFile(
      file,
      `${JSON.stringify({ type: 'session', id: 'stray', cwd: elsewhere })}\n`,
    );
    const opened: unknown[] = [];
    const coordinator = await open([], {
      openChatSession: async (input) => {
        opened.push(input);
        return session('chat-stray', { role: 'chat', name: 'Chat' });
      },
    });

    await expect(coordinator.resumeOmpSession(file)).resolves.toBe('chat-stray');

    expect(opened).toEqual([{ resumeFile: file }]);
    await coordinator.dispose();
  });

  it('refuses a saved file in the session directory of a folder outside the workspace', async () => {
    const other = path.join(tempHome, 'other-folder');
    await fs.promises.mkdir(other);
    const dir = ompSessionDirForFolder(other);
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'foreign.jsonl');
    await fs.promises.writeFile(file, '{}\n');
    const coordinator = await open([]);

    await expect(coordinator.resumeOmpSession(file)).rejects.toMatchObject({
      code: 'omp_session_outside_folder',
    });
    await coordinator.dispose();
  });

  it('answers a resume of a file a board session already holds with that session, opening nothing', async () => {
    const dir = ompSessionDirForFolder(workspace);
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'held.jsonl');
    await fs.promises.writeFile(file, '{}\n');
    const opened: (string | undefined)[] = [];
    const coordinator = await open([put(session('worker-1', { nativeSessionPath: file }))], {
      openChatSession: async (input) => {
        opened.push(input.resumeFile);
        return session('chat-x', { role: 'chat' });
      },
    });

    await expect(coordinator.resumeOmpSession(file)).resolves.toBe('worker-1');

    expect(opened).toEqual([]);
    await coordinator.dispose();
  });

  it('refuses to resume a file outside the workspace OMP folder', async () => {
    const outside = path.join(workspace, 'outside.jsonl');
    await fs.promises.writeFile(outside, '{}\n');
    const coordinator = await open([]);

    await expect(coordinator.resumeOmpSession(outside)).rejects.toMatchObject({
      code: 'omp_session_outside_folder',
    });
    await coordinator.dispose();
  });

  it('refuses a second resume of a file that is still opening', async () => {
    const dir = ompSessionDirForFolder(workspace);
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'busy.jsonl');
    await fs.promises.writeFile(file, '{}\n');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const opened: (string | undefined)[] = [];
    const coordinator = await open([], {
      openChatSession: async (input) => {
        opened.push(input.resumeFile);
        await gate;
        return session('chat-1', { role: 'chat' });
      },
    });

    const first = coordinator.resumeOmpSession(file);
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    await expect(coordinator.resumeOmpSession(file)).rejects.toMatchObject({
      code: 'omp_session_resuming',
    });
    release();

    await expect(first).resolves.toBe('chat-1');
    await coordinator.dispose();
  });

  it('opens a new chat with no prompt through the effect and answers its board id', async () => {
    const inputs: unknown[] = [];
    const coordinator = await open([], {
      openChatSession: async (input) => {
        inputs.push(input);
        return session('chat-new', { role: 'chat', name: 'Chat' });
      },
    });

    await expect(coordinator.openNewChat()).resolves.toBe('chat-new');

    expect(inputs).toEqual([{}]);
    await coordinator.dispose();
  });

  it('opens a new chat in a directory inside the folder, and refuses a directory outside it', async () => {
    const repo = path.join(workspace, 'repo-a');
    await fs.promises.mkdir(repo);
    const inputs: unknown[] = [];
    const coordinator = await open([], {
      openChatSession: async (input) => {
        inputs.push(input);
        return session('chat-in-repo', { role: 'worker', name: 'Worker', cwd: repo });
      },
    });

    await expect(coordinator.openNewChat({ cwd: repo, role: 'worker' })).resolves.toBe(
      'chat-in-repo',
    );
    await expect(coordinator.openNewChat({ cwd: tempHome })).rejects.toMatchObject({
      code: 'cwd_outside_folder',
    });
    await expect(
      coordinator.openNewChat({ cwd: path.join(workspace, 'missing') }),
    ).rejects.toMatchObject({ code: 'cwd_invalid' });

    expect(inputs).toEqual([{ cwd: await fs.promises.realpath(repo), role: 'worker' }]);
    await coordinator.dispose();
  });

  it('answers a resume of a file a live chat session holds, opening nothing', async () => {
    const dir = ompSessionDirForFolder(workspace);
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'live.jsonl');
    await fs.promises.writeFile(file, '{}\n');
    const opened: unknown[] = [];
    const coordinator = await open(
      [put(session('chat-live', { role: 'chat', status: 'idle', nativeSessionPath: file }))],
      {
        openChatSession: async (input) => {
          opened.push(input);
          return session('chat-x', { role: 'chat' });
        },
      },
    );

    await expect(coordinator.resumeOmpSession(file)).resolves.toBe('chat-live');

    expect(opened).toEqual([]);
    await coordinator.dispose();
  });

  it('reopens a parked chat session on its own omp file under the same record', async () => {
    const dir = ompSessionDirForFolder(workspace);
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'parked.jsonl');
    await fs.promises.writeFile(file, '{}\n');
    const controlled: { id: string; action: string; runEpoch: number; file?: string }[] = [];
    const opened: unknown[] = [];
    const coordinator = await open(
      [
        put(
          session('chat-parked', {
            role: 'chat',
            status: 'parked',
            runEpoch: 2,
            nativeSessionPath: file,
          }),
        ),
      ],
      {
        openChatSession: async (input) => {
          opened.push(input);
          return session('chat-x', { role: 'chat' });
        },
        controlSession: async (record, action) => {
          controlled.push({
            id: record.id,
            action,
            runEpoch: record.runEpoch,
            file: record.nativeSessionPath,
          });
          return { status: 'starting' };
        },
      },
    );

    await expect(coordinator.resumeOmpSession(file)).resolves.toBe('chat-parked');

    expect(opened).toEqual([]);
    expect(controlled).toEqual([{ id: 'chat-parked', action: 'resume', runEpoch: 2, file }]);
    expect(coordinator.snapshot().sessions.find((s) => s.id === 'chat-parked')?.status).toBe(
      'starting',
    );
    await coordinator.dispose();
  });

  it('restarts a stopped chat session on its own omp file with the next epoch', async () => {
    const dir = ompSessionDirForFolder(workspace);
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'stopped.jsonl');
    await fs.promises.writeFile(file, '{}\n');
    const controlled: { id: string; action: string; runEpoch: number; file?: string }[] = [];
    const coordinator = await open(
      [
        put(
          session('chat-stopped', {
            role: 'chat',
            status: 'stopped',
            runEpoch: 3,
            nativeSessionPath: file,
          }),
        ),
      ],
      {
        controlSession: async (record, action) => {
          controlled.push({
            id: record.id,
            action,
            runEpoch: record.runEpoch,
            file: record.nativeSessionPath,
          });
          return { status: 'starting' };
        },
      },
    );

    await expect(coordinator.resumeOmpSession(file)).resolves.toBe('chat-stopped');

    expect(controlled).toEqual([{ id: 'chat-stopped', action: 'restart', runEpoch: 4, file }]);
    await coordinator.dispose();
  });

  it('refuses to reopen a parked chat session that never recorded its omp file', async () => {
    const controlled: string[] = [];
    const coordinator = await open(
      [put(session('chat-blank', { role: 'chat', status: 'parked', runEpoch: 1 }))],
      {
        controlSession: async (record, action) => {
          controlled.push(`${record.id}:${action}`);
          return { status: 'starting' };
        },
      },
    );

    await expect(coordinator.controlSession('chat-blank', 'resume', 1)).rejects.toMatchObject({
      code: 'session_reopen_refused',
    });
    await expect(coordinator.controlSession('chat-blank', 'restart', 1)).rejects.toMatchObject({
      code: 'session_reopen_refused',
    });

    expect(controlled).toEqual([]);
    expect(coordinator.snapshot().sessions.find((s) => s.id === 'chat-blank')?.status).toBe(
      'parked',
    );
    await coordinator.dispose();
  });

  it('refuses to resume a file whose chat session is archived, opening nothing', async () => {
    const dir = ompSessionDirForFolder(workspace);
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'archived.jsonl');
    await fs.promises.writeFile(file, '{}\n');
    const opened: unknown[] = [];
    const coordinator = await open(
      [
        put(
          session('chat-archived', { role: 'chat', status: 'archived', nativeSessionPath: file }),
        ),
      ],
      {
        openChatSession: async (input) => {
          opened.push(input);
          return session('chat-x', { role: 'chat' });
        },
      },
    );

    await expect(coordinator.resumeOmpSession(file)).rejects.toMatchObject({
      code: 'omp_session_archived',
    });

    expect(opened).toEqual([]);
    await coordinator.dispose();
  });

  it('erases one session board log and tolerates one that is already gone', async () => {
    const logs = sessionLogDirectory(path.join(tempHome, 'namespace'));
    await fs.promises.mkdir(logs, { recursive: true });
    const sessionId = randomUUID();
    const log = path.join(logs, `${sessionId}.jsonl`);
    const kept = path.join(logs, `${randomUUID()}.jsonl`);
    await fs.promises.writeFile(log, '{}\n');
    await fs.promises.writeFile(kept, '{}\n');

    await removeSessionLog(logs, sessionId);

    expect(fs.existsSync(log)).toBe(false);
    expect(fs.existsSync(kept)).toBe(true);
    await expect(removeSessionLog(logs, sessionId)).resolves.toBeUndefined();
    await expect(removeSessionLog(logs, '../escape')).rejects.toMatchObject({
      code: 'session_log_invalid',
    });
  });
});
