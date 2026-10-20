import { describe, expect, it } from 'vitest';

import type { CompanyWorkItemsMessage, WorkItem } from '../../core/src/messages.js';
import { assigneeKeyOf,AUTO_ASSIGNEE } from '../src/company/assigneeOptions.js';
import { workItemAssign, workItemCreate } from '../src/company/companyMessages.js';
import { applyCompanyMessage, emptyCompanyState } from '../src/company/companyState.js';
import {
  areaChipsOf,
  assigneeLabel,
  AUTO_ASSIGNEE_LABEL,
  blockerSentence,
  normalizeAreas,
  repoShortName,
  WORK_ITEM_AREAS_MAX,
  workItemsOf,
} from '../src/company/workItemView.js';

const ACTIVE = 'D:/work/app';

const SETTINGS = {
  maxParallel: 4,
  maxSquadSessions: 3,
  minFreeRamGb: 2,
  autoJudge: true,
  autoApproveNext: false,
  engineLeader: 'omp' as const,
  engineJudge: 'omp' as const,
  engineWorker: 'omp' as const,
  claudeModelLeader: 'opus',
  claudeModelJudge: 'sonnet',
  maxClaudeRuns: 2,
  maxAgyRuns: 2,
  claudeMaxTurns: 40,
  claudeMaxBudgetUsd: 3,
  claudePermission: 'auto' as const,
  claudeAllowedTools: [] as string[],
  claudeWorkerMcp: [] as string[],
};

function workItem(overrides: Pick<WorkItem, 'id'> & Partial<WorkItem>): WorkItem {
  return {
    text: 'Sửa đăng nhập',
    assignee: { kind: 'auto' },
    status: 'queued',
    sequence: 1,
    priority: 2,
    dependsOn: [],
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    history: [],
    ...overrides,
  };
}

describe('repoShortName', () => {
  it('returns the last path segment under either slash', () => {
    expect(repoShortName('D:/work/app')).toBe('app');
    expect(repoShortName('D:\\work\\app-wt\\')).toBe('app-wt');
  });

  it('returns an empty name for a path with no segments', () => {
    expect(repoShortName('')).toBe('');
    expect(repoShortName('/')).toBe('');
  });
});

describe('normalizeAreas', () => {
  it('trims and lowercases, then drops blanks and repeats, keeping the first order', () => {
    expect(normalizeAreas([' Auth ', 'auth', '', '  ', 'Billing', 'AUTH', 'billing'])).toEqual([
      'auth',
      'billing',
    ]);
  });

  it('keeps at most WORK_ITEM_AREAS_MAX areas', () => {
    const many = Array.from({ length: WORK_ITEM_AREAS_MAX + 4 }, (_, index) => `area${index}`);
    const kept = normalizeAreas(many);
    expect(kept).toHaveLength(WORK_ITEM_AREAS_MAX);
    expect(kept[0]).toBe('area0');
    expect(kept.at(-1)).toBe(`area${WORK_ITEM_AREAS_MAX - 1}`);
  });
});

describe('areaChipsOf', () => {
  it('shows the first two areas and counts the rest', () => {
    expect(areaChipsOf(['auth', 'billing', 'ui'])).toEqual({
      shown: ['auth', 'billing'],
      more: 1,
    });
  });

  it('counts nothing more when two or fewer areas are given', () => {
    expect(areaChipsOf(['auth'])).toEqual({ shown: ['auth'], more: 0 });
    expect(areaChipsOf([])).toEqual({ shown: [], more: 0 });
  });
});

describe('blockerSentence', () => {
  it('is null when nothing holds the item', () => {
    expect(blockerSentence(null)).toBeNull();
    expect(blockerSentence(undefined)).toBeNull();
  });

  it('says what the item waits for, naming its #n when the folder knows it', () => {
    expect(blockerSentence({ kind: 'agent' })).toBe('Chờ agent rảnh để nhận việc.');
    expect(blockerSentence({ kind: 'dependency' })).toBe('Chờ một việc khác xong.');
    expect(blockerSentence({ kind: 'dependency', sequence: 3 })).toBe('Chờ việc #3 xong.');
    expect(blockerSentence({ kind: 'failed', sequence: 2 })).toBe(
      'Việc #2 bị lỗi. Gỡ chờ hoặc giao lại.',
    );
  });

  it('gives the running count of a full folder, and names the held area', () => {
    expect(blockerSentence({ kind: 'capacity', running: 4, limit: 4 })).toBe(
      'Đang chạy 4/4 việc, chờ có chỗ trống.',
    );
    expect(blockerSentence({ kind: 'capacity' })).toBe('Hết chỗ chạy, chờ có chỗ trống.');
    expect(blockerSentence({ kind: 'area', area: 'auth' })).toBe(
      'Vùng auth đang có việc khác giữ.',
    );
    expect(blockerSentence({ kind: 'no_member' })).toBe(
      'Thư mục chưa có agent nào để nhận việc này.',
    );
  });

  it('says where a busy repo, a worktree not yet made and a full pool hold the item', () => {
    expect(blockerSentence({ kind: 'busy_checkout', area: 'web' })).toBe(
      'Repo web đang có agent làm việc, chờ agent đó rảnh.',
    );
    expect(blockerSentence({ kind: 'busy_checkout' })).toBe(
      'Repo của việc này đang có agent làm việc, chờ agent đó rảnh.',
    );
    expect(blockerSentence({ kind: 'worktree', detail: 'git fetch lỗi' })).toBe(
      'Chưa tạo được worktree riêng cho việc này, việc vẫn đang chờ: git fetch lỗi',
    );
    expect(blockerSentence({ kind: 'worktree' })).toBe(
      'Chưa tạo được worktree riêng cho việc này, việc vẫn đang chờ.',
    );
    expect(blockerSentence({ kind: 'pool_full' })).toBe(
      'Đã hết phiên chạy của công ty, việc chờ có chỗ trống.',
    );
  });
});

describe('the auto assignee', () => {
  it('is keyed as auto and labelled as the picker names it', () => {
    expect(assigneeKeyOf(AUTO_ASSIGNEE)).toBe('auto');
    expect(assigneeLabel(AUTO_ASSIGNEE, emptyCompanyState(), ACTIVE)).toBe(AUTO_ASSIGNEE_LABEL);
    expect(AUTO_ASSIGNEE_LABEL).toBe('Tự chọn agent');
  });
});

describe('companyWorkItems ingest of repos, agents, settings and areas', () => {
  it('stores the repos, agents and settings the server sends', () => {
    const state = applyCompanyMessage(emptyCompanyState(), {
      type: 'companyWorkItems',
      workspacePath: ACTIVE,
      revision: 1,
      items: [],
      roles: [],
      repos: ['D:/work/app', 'D:/work/app-wt'],
      agents: [{ name: 'reviewer', description: 'Rà soát mã', readOnly: true, source: 'bundled' }],
      settings: SETTINGS,
      claudeMcpServers: [],
    }).state;
    const held = workItemsOf(state, ACTIVE);
    expect(held.repos).toEqual(['D:/work/app', 'D:/work/app-wt']);
    expect(held.agents).toEqual([
      { name: 'reviewer', description: 'Rà soát mã', readOnly: true, source: 'bundled' },
    ]);
    expect(held.settings).toEqual(SETTINGS);
  });

  it('reads an older server’s missing lists as empty, its missing settings as null, and an item with no areas as none', () => {
    const older = {
      type: 'companyWorkItems',
      workspacePath: ACTIVE,
      revision: 1,
      items: [workItem({ id: 'a' })],
      roles: [],
    } as unknown as CompanyWorkItemsMessage;
    const held = workItemsOf(applyCompanyMessage(emptyCompanyState(), older).state, ACTIVE);
    expect(held.repos).toEqual([]);
    expect(held.agents).toEqual([]);
    expect(held.settings).toBeNull();
    expect(held.claudeMcpServers).toEqual([]);
    expect(held.items[0]?.areas).toEqual([]);
  });
});

describe('work item builders carry the squad fields', () => {
  it('sends repo, role, areas and agent on create when they are given', () => {
    expect(
      workItemCreate('r1', ACTIVE, 'Sửa đăng nhập', AUTO_ASSIGNEE, {
        repo: 'D:/work/app-wt',
        role: 'qa',
        areas: ['auth'],
        agent: 'reviewer',
      }),
    ).toMatchObject({
      type: 'companyWorkItemCreate',
      assignee: { kind: 'auto' },
      repo: 'D:/work/app-wt',
      role: 'qa',
      areas: ['auth'],
      agent: 'reviewer',
    });
  });

  it('sends the four fields on assign when they are given', () => {
    expect(
      workItemAssign(
        'r2',
        ACTIVE,
        'w1',
        { kind: 'herdr', paneId: 'p1' },
        { repo: 'D:/work/app-wt', role: 'worker', areas: ['ui'], agent: 'reviewer' },
      ),
    ).toMatchObject({
      type: 'companyWorkItemAssign',
      repo: 'D:/work/app-wt',
      role: 'worker',
      areas: ['ui'],
      agent: 'reviewer',
    });
  });

  it('leaves absent fields off the wire on assign, so the server clears them', () => {
    expect(JSON.parse(JSON.stringify(workItemAssign('r3', ACTIVE, 'w1', AUTO_ASSIGNEE)))).toEqual({
      type: 'companyWorkItemAssign',
      requestId: 'r3',
      workspacePath: ACTIVE,
      id: 'w1',
      assignee: { kind: 'auto' },
    });
  });
});
