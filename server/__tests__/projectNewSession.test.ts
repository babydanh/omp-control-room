import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SubmitPromptInput } from '../../core/src/company.js';
import type { ProjectSessionStartMessage, ProjectTreeNode, WorkItem } from '../../core/src/messages.js';
import type { CompanyCoordinator } from '../src/company/companyCoordinator.js';
import type { WorkItemService } from '../src/company/workItems/workItemService.js';
import { type ProjectSessionServices, startProjectSession } from '../src/projects/newSession.js';
import { createProjectSessionRuntime } from '../src/projects/newSessionRuntime.js';
import { createProjectSessionWorktree, taskSlug } from '../src/projects/projectSessionWorktree.js';
import type { ProjectStore } from '../src/projects/projectStore.js';

let root: string;
let repo: string;
let bare: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

function createRepository(): void {
  fs.mkdirSync(repo);
  fs.mkdirSync(bare);
  git(root, 'init', '--bare', '-q', bare);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'repo\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'initial');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-qu', 'origin', 'main');
}

function createServices(overrides: Partial<ProjectSessionServices> = {}) {
  return {
    effectiveSettings: vi.fn(async () => ({})),
    runGit: async (file: string, argv: readonly string[], cwd: string) => {
      try {
        const stdout = execFileSync(file, [...argv], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, stdout, stderr: '' };
      } catch (error) {
        const failure = error as { status?: number; stderr?: Buffer };
        return { code: failure.status ?? 1, stdout: '', stderr: failure.stderr?.toString() ?? '' };
      }
    },
    openChat: vi.fn(async () => 'omp-id'),
    startClaudeRun: vi.fn(async () => ({ sessionId: 'claude-id', checkout: repo })),
    startAgyRun: vi.fn(async () => ({ sessionId: 'agy-id', checkout: repo })),
    runSetupScript: vi.fn(async () => ({ code: 0, stderr: '' })),
    ...overrides,
  } satisfies ProjectSessionServices;
}

function tree(): { nodes: ProjectTreeNode[] } {
  return {
    nodes: [
      { id: 'folder', kind: 'folder', name: 'Project', path: root },
      { id: 'repo', parentId: 'folder', kind: 'repository', name: 'repo', path: repo },
      { id: repo, parentId: 'repo', kind: 'checkout', name: 'repo', path: repo },
      { id: 'worktree', parentId: 'repo', kind: 'checkout', name: 'branch', path: path.join(root, 'repo.worktrees', 'branch') },
    ],
  };
}

function request(
  engine: ProjectSessionStartMessage['engine'],
  worktree: ProjectSessionStartMessage['worktree'],
  nodeId = 'repo',
): ProjectSessionStartMessage {
  return {
    type: 'projectSessionStart',
    requestId: 'request-1',
    nodeId,
    engine,
    worktree,
    taskName: 'Sửa lỗi đăng nhập',
    initialPrompt: 'Hãy sửa lỗi đăng nhập.',
  };
}

function deps(services: ProjectSessionServices) {
  return {
    store: {} as ProjectStore,
    loadTree: async () => tree(),
    services,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-session-'));
  repo = path.join(root, 'repo');
  bare = path.join(root, 'origin.git');
  createRepository();
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('project session start', () => {
  it('creates a slugged worktree alongside the repo from origin/main', async () => {
    const result = await createProjectSessionWorktree({ repo, taskName: 'Sửa lỗi đăng nhập!', run: async (file, argv, cwd) => {
      try {
        const stdout = execFileSync(file, [...argv], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, stdout, stderr: '' };
      } catch (error) {
        const failure = error as { status?: number; stderr?: Buffer };
        return { code: failure.status ?? 1, stdout: '', stderr: failure.stderr?.toString() ?? '' };
      }
    } });
    expect(result.path).toBe(path.join(root, 'repo.worktrees', 'sua-loi-dang-nhap'));
    expect(git(result.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('project/sua-loi-dang-nhap');
  });

  it('adds a suffix when a task slug already exists', async () => {
    const runner = async (file: string, argv: readonly string[], cwd: string) => {
      try {
        const stdout = execFileSync(file, [...argv], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, stdout, stderr: '' };
      } catch (error) {
        const failure = error as { status?: number; stderr?: Buffer };
        return { code: failure.status ?? 1, stdout: '', stderr: failure.stderr?.toString() ?? '' };
      }
    };
    const first = await createProjectSessionWorktree({ repo, taskName: 'Review', run: runner });
    const second = await createProjectSessionWorktree({ repo, taskName: 'Review', run: runner });
    expect(first.path).toBe(path.join(root, 'repo.worktrees', 'review'));
    expect(second.path).toBe(path.join(root, 'repo.worktrees', 'review-2'));
  });

  it.each([
    ['omp', 'omp-id', 'openChat'],
    ['claude', 'claude-id', 'startClaudeRun'],
    ['agy', 'agy-id', 'startAgyRun'],
  ] as const)('starts %s with the selected checkout cwd', async (engine, sessionId, runnerName) => {
    const services = createServices();
    const result = await startProjectSession(request(engine, 'shared'), deps(services));
    expect(result).toMatchObject({ ok: true, sessionId, checkout: repo });
    expect(services[runnerName]).toHaveBeenCalledWith(expect.objectContaining({ cwd: repo }));
  });
  it('uses the exact checkout node selected in the tree', async () => {
    const checkout = path.join(root, 'repo.worktrees', 'branch');
    const services = createServices({
      startClaudeRun: vi.fn(async ({ cwd }) => ({ sessionId: 'claude-id', checkout: cwd })),
    });
    const result = await startProjectSession(request('claude', 'shared', 'worktree'), deps(services));
    expect(result).toMatchObject({ sessionId: 'claude-id', checkout });
    expect(services.startClaudeRun).toHaveBeenCalledWith(expect.objectContaining({ cwd: checkout }));
  });

  it('refuses a shared checkout at the protected main repository root', async () => {
    const protectedPath = path.join(root, 'Duancanhan', 'Project_QuanLyGiaiDau', 'GiaiDau');
    const protectedTree = { nodes: [
      { id: 'folder', kind: 'folder', name: 'Project', path: path.dirname(protectedPath) },
      { id: 'repo', parentId: 'folder', kind: 'repository', name: 'GiaiDau', path: protectedPath },
    ] satisfies ProjectTreeNode[] };
    const services = createServices();
    await expect(startProjectSession(request('omp', 'shared'), {
      store: {} as ProjectStore,
      loadTree: async () => protectedTree,
      services,
    })).rejects.toThrow('Không thể dùng chung thư mục chính');
    expect(services.openChat).not.toHaveBeenCalled();
  });

  it('opens an omp chat right in a folder that holds no repo, and refuses what needs git there', async () => {
    const plain = { nodes: [{ id: 'folder', kind: 'folder', name: 'Notes', path: root }] satisfies ProjectTreeNode[] };
    const services = createServices();
    const plainDeps = { store: {} as ProjectStore, loadTree: async () => plain, services };
    await expect(startProjectSession(request('omp', 'shared', 'folder'), plainDeps)).resolves.toMatchObject({ ok: true, checkout: root });
    expect(services.openChat).toHaveBeenCalledWith(expect.objectContaining({ cwd: root }));
    await expect(startProjectSession(request('omp', 'separate', 'folder'), plainDeps)).rejects.toThrow('không tạo được worktree');
    await expect(startProjectSession(request('claude', 'shared', 'folder'), plainDeps)).rejects.toThrow('cần repo');
  });

  it('adapts the coordinator and work-item service using their runtime contracts', async () => {
    const coordinator: Pick<CompanyCoordinator, 'openNewChat' | 'submitPrompt'> = {
      openNewChat: vi.fn(async () => 'board-session'),
      submitPrompt: vi.fn(async (_input: SubmitPromptInput) => ({}) as never),
    };
    const workItems: Pick<WorkItemService, 'create' | 'get'> = {
      create: vi.fn(async () => 'work-item-id'),
      get: vi.fn(() => ({ id: 'work-item-id', claudeRun: { sessionId: 'claude-session' } }) as WorkItem),
    };
    const runtime = createProjectSessionRuntime({
      coordinatorFor: vi.fn(async () => coordinator),
      workItemServiceFor: vi.fn(async () => workItems),
      runProcess: vi.fn(async () => ({
        ok: true, code: 0, stdout: '', stderr: '', timedOut: false, truncated: false,
      })),
      effectiveSettings: async () => ({}),
    });
    const omp = await startProjectSession(request('omp', 'shared'), deps(runtime));
    expect(omp.sessionId).toBe('board-session');
    expect(coordinator.openNewChat).toHaveBeenCalledWith({ cwd: repo, role: 'chat' });
    expect(coordinator.submitPrompt).toHaveBeenCalledWith(expect.objectContaining({
      targetSessionId: 'board-session',
      text: 'Hãy sửa lỗi đăng nhập.',
      mode: 'chat',
    }));

    const claude = await startProjectSession(request('claude', 'shared'), deps(runtime));
    expect(claude.sessionId).toBe('claude-session');
    expect(claude.checkout).toBe(repo);
    expect(workItems.create).toHaveBeenCalledWith(expect.objectContaining({
      repo,
      assignee: { kind: 'claude' },
      text: 'Hãy sửa lỗi đăng nhập.',
      inPlace: true,
    }));
  });

  it('lets Claude work items create the separate checkout and reports it when available', async () => {
    const worktree = path.join(root, 'repo', '.worktrees', 'squad-12345678');
    const workItems: Pick<WorkItemService, 'create' | 'get'> = {
      create: vi.fn(async () => 'work-item-id'),
      get: vi.fn(() => ({
        id: 'work-item-id',
        claudeRun: { sessionId: 'claude-session' },
        worktree: { path: worktree, branch: 'squad-12345678' },
      }) as WorkItem),
    };
    const runtime = createProjectSessionRuntime({
      coordinatorFor: vi.fn(async () => ({
        openNewChat: vi.fn(async () => ''),
        submitPrompt: vi.fn(async (_input: SubmitPromptInput) => ({}) as never),
      })),
      workItemServiceFor: vi.fn(async () => workItems),
      runProcess: vi.fn(async () => ({
        ok: true, code: 0, stdout: '', stderr: '', timedOut: false, truncated: false,
      })),
      effectiveSettings: async () => ({}),
    });
    const result = await startProjectSession(request('claude', 'separate'), deps(runtime));
    expect(result).toMatchObject({ sessionId: 'claude-session', checkout: worktree });
    expect(workItems.create).toHaveBeenCalledWith(expect.objectContaining({ repo, inPlace: false }));
  });

  it('uses the prepare script for the OMP worktree before opening the chat', async () => {
    const services = createServices({
      effectiveSettings: vi.fn(async () => ({ worktreePrepare: { argv: ['npm', 'install'], timeoutMs: 1234 } })),
    });
    await startProjectSession(request('omp', 'separate'), deps(services));
    expect(services.runSetupScript).toHaveBeenCalledWith(['npm', 'install'], path.join(root, 'repo.worktrees', 'sua-loi-dang-nhap'), 1234);
    expect(services.openChat).toHaveBeenCalledWith(expect.objectContaining({ cwd: path.join(root, 'repo.worktrees', 'sua-loi-dang-nhap') }));
  });


  it('normalizes task names to safe path slugs', () => {
    expect(taskSlug('../../ A/B !!!')).toBe('a-b');
  });
});
