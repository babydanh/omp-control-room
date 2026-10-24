import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { CompanyWorkItemsMessage } from '../../core/src/messages.js';
import type { ClaudeRunStart } from '../src/company/claudeCode/claudeRuns.js';
import { GIB } from '../src/company/workItems/squadSettings.js';
import { parseWorkItemsFile } from '../src/company/workItems/workItemModel.js';
import type { WorkItemPorts } from '../src/company/workItems/workItemService.js';
import { WorkItemService } from '../src/company/workItems/workItemService.js';
import { FakeAgyRuns } from './fakeAgy.js';
import { FakeClaudeAuth, FakeClaudeMcp, FakeClaudeRuns } from './fakeClaude.js';

const FOLDER = '/work/folder';
const REPO = `${FOLDER}/repo`;
const SHARED_CHECKOUT = REPO;

class OrderedClaudeRuns extends FakeClaudeRuns {
  constructor(private readonly events: string[]) {
    super();
  }

  override start(input: ClaudeRunStart): { readonly runId: string; readonly pid?: number } {
    this.events.push('runner');
    return super.start(input);
  }
}

function createService(input: {
  readonly events: string[];
  readonly prepareWorktree?: NonNullable<WorkItemPorts['prepareWorktree']>;
}): { readonly service: WorkItemService; readonly claude: OrderedClaudeRuns; readonly worktrees: string[] } {
  const published: CompanyWorkItemsMessage[] = [];
  const claude = new OrderedClaudeRuns(input.events);
  const agy = new FakeAgyRuns();
  const claudeAuth = new FakeClaudeAuth();
  const claudeMcp = new FakeClaudeMcp();
  const worktrees: string[] = [];
  const service = new WorkItemService(FOLDER, {
    roster: { panes: () => ({ available: false, panes: [] }), prompt: async () => undefined, screenText: async () => '' },
    sessions: {
      list: () => [],
      submit: async () => undefined,
      openChat: async () => 'session-id',
      wake: async () => undefined,
      park: async () => true,
    },
    persistence: { load: async () => parseWorkItemsFile(null), save: async () => undefined },
    worktrees: {
      create: async (repo, shortId) => {
        input.events.push('worktree');
        const path = `${repo}/.worktrees/squad-${shortId}`;
        worktrees.push(path);
        return { path, branch: `squad-${shortId}` };
      },
      remove: async () => 'removed',
      exists: () => true,
    },
    ...(input.prepareWorktree === undefined ? {} : { prepareWorktree: input.prepareWorktree }),
    publish: (message) => published.push(message),
    now: () => Date.now(),
    newId: () => randomUUID(),
    schedule: () => () => undefined,
    catalog: async () => ({ repos: [REPO, SHARED_CHECKOUT], agents: [], claudeAgents: [] }),
    freeMemoryBytes: () => 8 * GIB,
    freeDiskBytes: async () => 20 * GIB,
    judge: async () => '',
    overlaps: async () => [],
    boardWatching: () => false,
    claude,
    agy,
    claudeAuth,
    claudeMcp,
  });
  return { service, claude, worktrees };
}

async function startClaude(service: WorkItemService, repo = REPO, inPlace = false): Promise<string> {
  return service.create({
    requestId: randomUUID(),
    text: 'Thực hiện công việc được giao.',
    assignee: { kind: 'claude' },
    repo,
    role: 'worker',
    inPlace,
  });
}

describe('Project work item worktree integration', () => {
  it('runs preparation after checkout creation and before the CLI starts', async () => {
    const events: string[] = [];
    const prepared: { folder: string; repo: string; worktree: string }[] = [];
    const { service, claude } = createService({
      events,
      prepareWorktree: async (input) => {
        events.push('prepare');
        prepared.push(input);
      },
    });
    await service.load();
    await startClaude(service);
    expect(events).toEqual(['worktree', 'prepare', 'runner']);
    const checkout = `${REPO}/.worktrees/squad-${service.snapshot().items[0]?.id.slice(0, 8)}`;
    expect(prepared).toEqual([{ folder: FOLDER, repo: REPO, worktree: checkout }]);
    expect(claude.starts[0]?.input.cwd).toBe(checkout);
    service.dispose();
  });

  it('marks a setup failure and never starts the engine', async () => {
    const events: string[] = [];
    const { service, claude } = createService({
      events,
      prepareWorktree: async () => {
        events.push('prepare');
        throw new Error('Cài đặt worktree lỗi.');
      },
    });
    await service.load();
    const id = await startClaude(service);
    expect(events).toEqual(['worktree', 'prepare']);
    expect(claude.starts).toHaveLength(0);
    expect(service.get(id)).toMatchObject({ status: 'failed', reason: expect.stringContaining('Script chuẩn bị worktree thất bại') });
    service.dispose();
  });

  it('runs in-place at the chosen checkout without allocating a worktree and queues another item on it', async () => {
    const events: string[] = [];
    const { service, claude, worktrees } = createService({ events });
    await service.load();
    const firstId = await startClaude(service, SHARED_CHECKOUT, true);
    const secondId = await startClaude(service, SHARED_CHECKOUT, true);
    expect(worktrees).toEqual([]);
    expect(claude.starts).toHaveLength(1);
    expect(claude.starts[0]?.input.cwd).toBe(SHARED_CHECKOUT);
    expect(service.get(firstId)?.status).toBe('running');
    expect(service.get(secondId)).toMatchObject({ status: 'queued', blocker: { kind: 'area' } });
    service.dispose();
  });
});
