import { describe, expect, it } from 'vitest';

import type {
  SquadSettings,
  WorkItemAgyRun,
  WorkItemClaudeRun,
} from '../../core/src/messages.js';
import {
  AGY_ASSIGNEE,
  AGY_OPTION,
  assigneeKeyOf,
  CLAUDE_ASSIGNEE,
  CLAUDE_OPTION,
} from '../src/company/assigneeOptions.js';
import { claudeStatusLabel } from '../src/company/claudeCodeView.js';
import { squadClaudeCheck } from '../src/company/companyMessages.js';
import { applyCompanyMessage } from '../src/company/companyState.js';
import {
  permissionOf,
  squadEngineOf,
  type SquadSettingsDraft,
  squadSettingsDraftOf,
  squadSettingsFromDraft,
} from '../src/company/squadSettingsView.js';
import {
  AGY_ASSIGNEE_LABEL,
  assigneeLabel,
  CLAUDE_ASSIGNEE_LABEL,
  WORK_ITEM_INTERRUPTED_NOTE,
  workItemInterruptedNote,
  workItemProgressLine,
  workItemsOf,
} from '../src/company/workItemView.js';
import { stateFrom } from './companyFixtures.js';

const ACTIVE = 'D:/work/app';

const SETTINGS: SquadSettings = {
  maxParallel: 4,
  maxSquadSessions: 3,
  maxPerRepo: 4,
  minFreeRamGb: 2,
  autoJudge: true,
  autoApproveNext: false,
  compactSquad: false,
  engineLeader: 'omp',
  engineJudge: 'omp',
  engineWorker: 'omp',
  claudeModelLeader: 'opus',
  claudeModelJudge: 'sonnet',
  maxClaudeRuns: 2,
  maxAgyRuns: 2,
  claudeMaxTurns: 40,
  claudeMaxBudgetUsd: 3,
  claudePermission: 'auto',
  claudeAllowedTools: ['Bash(git status*)', 'Bash(npm run *)'],
  claudeWorkerMcp: ['github'],
};

/** The draft the form holds once a person has changed the given fields of the saved settings. */
function draftWith(overrides: Partial<SquadSettingsDraft>): SquadSettingsDraft {
  return { ...squadSettingsDraftOf(SETTINGS), ...overrides };
}

describe('claudeStatusLabel', () => {
  it('words each install and sign-in state in Vietnamese', () => {
    expect(claudeStatusLabel({ state: 'missing' })).toBe('Claude Code: chưa cài');
    expect(claudeStatusLabel({ state: 'signed_out' })).toBe(
      'Claude Code: chưa đăng nhập — chạy `claude` để đăng nhập',
    );
    expect(claudeStatusLabel({ state: 'signed_in' })).toBe(
      'Claude Code: đã đăng nhập (gói Claude)',
    );
    expect(claudeStatusLabel({ state: 'unknown' })).toBe('Claude Code: chưa kiểm tra');
  });

  it('reads as unknown until a check has answered', () => {
    expect(claudeStatusLabel(null)).toBe('Claude Code: chưa kiểm tra');
  });
});

describe('the Claude Code assignee option', () => {
  it('is a picker row keyed claude that the assign dialog can select', () => {
    expect(CLAUDE_ASSIGNEE).toEqual({ kind: 'claude' });
    expect(assigneeKeyOf(CLAUDE_ASSIGNEE)).toBe('claude');
    expect(CLAUDE_OPTION).toEqual({
      key: 'claude',
      assignee: { kind: 'claude' },
      label: 'Claude Code (claude -p)',
      group: 'claude',
    });
  });

  it('labels a claude-held work item Claude Code', () => {
    expect(CLAUDE_ASSIGNEE_LABEL).toBe('Claude Code');
    expect(assigneeLabel(CLAUDE_ASSIGNEE, stateFrom(), ACTIVE)).toBe('Claude Code');
  });
});

describe('the agy assignee option', () => {
  it('is a picker row keyed agy and labels the holder Antigravity', () => {
    expect(AGY_ASSIGNEE).toEqual({ kind: 'agy' });
    expect(assigneeKeyOf(AGY_ASSIGNEE)).toBe('agy');
    expect(AGY_OPTION).toEqual({
      key: 'agy',
      assignee: { kind: 'agy' },
      label: 'agy (Antigravity)',
      group: 'agy',
    });
    expect(AGY_ASSIGNEE_LABEL).toBe('agy (Antigravity)');
    expect(assigneeLabel(AGY_ASSIGNEE, stateFrom(), ACTIVE)).toBe('agy (Antigravity)');
  });
});

describe('work item CLI run status', () => {
  const claudeRun: WorkItemClaudeRun = {
    mode: 'edit',
    startedAt: '2026-10-02T10:00:00.000Z',
    progress: '  Đang sửa workItemView.ts  ',
  };
  const agyRun: WorkItemAgyRun = {
    mode: 'edit',
    startedAt: '2026-10-02T10:00:00.000Z',
    pid: 91,
    progress: '  Đang sửa bằng agy  ',
  };

  it('shows trimmed progress from either CLI only while an item is running', () => {
    expect(workItemProgressLine({ status: 'running', claudeRun })).toBe(
      'Đang sửa workItemView.ts',
    );
    expect(workItemProgressLine({ status: 'running', agyRun })).toBe('Đang sửa bằng agy');
    expect(workItemProgressLine({ status: 'queued', agyRun })).toBeNull();
    expect(workItemProgressLine({ status: 'review', claudeRun })).toBeNull();
  });

  it('shows one restart-interrupted note for either run and none for finished work', () => {
    expect(workItemInterruptedNote({ claudeRun: { ...claudeRun, interrupted: true } })).toBe(
      WORK_ITEM_INTERRUPTED_NOTE,
    );
    expect(workItemInterruptedNote({ agyRun: { ...agyRun, interrupted: true } })).toBe(
      WORK_ITEM_INTERRUPTED_NOTE,
    );
    expect(workItemInterruptedNote({ claudeRun })).toBeNull();
    expect(workItemInterruptedNote({ agyRun })).toBeNull();
    expect(WORK_ITEM_INTERRUPTED_NOTE).toBe(
      'Bị gián đoạn khi board khởi động lại. Gửi tiếp để tiếp tục.',
    );
  });

  it('omits blank progress', () => {
    expect(
      workItemProgressLine({ status: 'running', agyRun: { ...agyRun, progress: '  ' } }),
    ).toBeNull();
    expect(workItemProgressLine({ status: 'running' })).toBeNull();
  });
});

describe('squadClaudeCheck', () => {
  it('builds the check command with its request id and folder, and nothing else', () => {
    expect(squadClaudeCheck('r1', ACTIVE)).toEqual({
      type: 'companySquadClaudeCheck',
      requestId: 'r1',
      workspacePath: ACTIVE,
    });
  });
});

describe('squadEngineOf', () => {
  it('preserves each known engine and defaults unknown choices to omp', () => {
    expect(squadEngineOf('claude')).toBe('claude');
    expect(squadEngineOf('agy')).toBe('agy');
    expect(squadEngineOf('omp')).toBe('omp');
    expect(squadEngineOf('')).toBe('omp');
  });
});

describe('permissionOf', () => {
  it('names acceptEdits only for the acceptEdits choice, and auto otherwise', () => {
    expect(permissionOf('acceptEdits')).toBe('acceptEdits');
    expect(permissionOf('auto')).toBe('auto');
    expect(permissionOf('bypassPermissions')).toBe('auto');
  });
});

describe('squadSettingsFromDraft for the Claude Code settings', () => {
  it('saves the Claude Code settings, trimming the model names', () => {
    const reading = squadSettingsFromDraft(
      draftWith({
        engineLeader: 'claude',
        engineJudge: 'claude',
        engineWorker: 'claude',
        claudeModelLeader: '  opus  ',
        claudeModelJudge: 'sonnet',
        maxClaudeRuns: '4',
        maxAgyRuns: '4',
        claudeMaxTurns: '200',
        claudeMaxBudgetUsd: '0.1',
      }),
    );
    expect(reading).toEqual({
      ok: true,
      settings: {
        ...SETTINGS,
        engineLeader: 'claude',
        engineJudge: 'claude',
        engineWorker: 'claude',
        claudeModelLeader: 'opus',
        maxClaudeRuns: 4,
        maxAgyRuns: 4,
        claudeMaxTurns: 200,
        claudeMaxBudgetUsd: 0.1,
      },
    });
  });

  it('refuses a blank model name', () => {
    expect(squadSettingsFromDraft(draftWith({ claudeModelLeader: '   ' })).ok).toBe(false);
  });

  it('refuses a run count, turn count or budget outside its bounds', () => {
    expect(squadSettingsFromDraft(draftWith({ maxClaudeRuns: '0' })).ok).toBe(false);
    expect(squadSettingsFromDraft(draftWith({ maxClaudeRuns: '5' })).ok).toBe(false);
    expect(squadSettingsFromDraft(draftWith({ claudeMaxTurns: '2.5' })).ok).toBe(false);
    expect(squadSettingsFromDraft(draftWith({ claudeMaxTurns: '201' })).ok).toBe(false);
    expect(squadSettingsFromDraft(draftWith({ claudeMaxBudgetUsd: '0.05' })).ok).toBe(false);
    expect(squadSettingsFromDraft(draftWith({ claudeMaxBudgetUsd: '50.5' })).ok).toBe(false);
  });

  it('saves the permission mode and reads the allowlist one pattern per line', () => {
    const reading = squadSettingsFromDraft(
      draftWith({
        claudePermission: 'acceptEdits',
        claudeAllowedTools: '  Bash(git status*) \n\nEdit\r\n',
      }),
    );
    expect(reading).toEqual({
      ok: true,
      settings: {
        ...SETTINGS,
        claudePermission: 'acceptEdits',
        claudeAllowedTools: ['Bash(git status*)', 'Edit'],
      },
    });
  });

  it('refuses a tool line that is not one pattern, and a list longer than 32', () => {
    const bad = squadSettingsFromDraft(
      draftWith({ claudeAllowedTools: 'Bash(git status*)\nrm -rf /' }),
    );
    expect(bad.ok).toBe(false);
    const many = Array.from({ length: 33 }, (_, index) => `Bash(cmd${index}*)`).join('\n');
    expect(squadSettingsFromDraft(draftWith({ claudeAllowedTools: many })).ok).toBe(false);
  });

  it('reads the chosen MCP servers back, and refuses a list longer than 32 or a blank name', () => {
    expect(squadSettingsFromDraft(draftWith({ claudeWorkerMcp: ['docs'] }))).toMatchObject({
      ok: true,
      settings: { claudeWorkerMcp: ['docs'] },
    });
    const many = Array.from({ length: 33 }, (_, index) => `server-${index}`);
    expect(squadSettingsFromDraft(draftWith({ claudeWorkerMcp: many })).ok).toBe(false);
    expect(squadSettingsFromDraft(draftWith({ claudeWorkerMcp: [''] })).ok).toBe(false);
  });
});

describe('the folder Claude Code status in work items', () => {
  it('reads as null before any check has answered', () => {
    expect(workItemsOf(stateFrom(), ACTIVE).claudeStatus).toBeNull();
  });

  it('stores the status a snapshot carries', () => {
    const state = applyCompanyMessage(stateFrom(), {
      type: 'companyWorkItems',
      workspacePath: ACTIVE,
      revision: 1,
      items: [],
      roles: [],
      repos: [],
      agents: [],
      settings: SETTINGS,
      claudeMcpServers: [],
      claudeStatus: { state: 'signed_in' },
    }).state;
    expect(workItemsOf(state, ACTIVE).claudeStatus).toEqual({ state: 'signed_in' });
  });

  it('takes a check answer that arrives under a repeated revision', () => {
    const first = applyCompanyMessage(stateFrom(), {
      type: 'companyWorkItems',
      workspacePath: ACTIVE,
      revision: 1,
      items: [],
      roles: [],
      repos: [],
      agents: [],
      settings: SETTINGS,
      claudeMcpServers: [],
    }).state;
    const answered = applyCompanyMessage(first, {
      type: 'companyWorkItems',
      workspacePath: ACTIVE,
      revision: 1,
      items: [],
      roles: [],
      repos: [],
      agents: [],
      settings: SETTINGS,
      claudeMcpServers: [],
      claudeStatus: { state: 'missing' },
    }).state;
    expect(workItemsOf(answered, ACTIVE).claudeStatus).toEqual({ state: 'missing' });
    expect(workItemsOf(answered, ACTIVE).revision).toBe(1);
  });

  it('keeps the held status when a newer snapshot carries none', () => {
    const held = applyCompanyMessage(stateFrom(), {
      type: 'companyWorkItems',
      workspacePath: ACTIVE,
      revision: 1,
      items: [],
      roles: [],
      repos: [],
      agents: [],
      settings: SETTINGS,
      claudeMcpServers: [],
      claudeStatus: { state: 'signed_out' },
    }).state;
    const newer = applyCompanyMessage(held, {
      type: 'companyWorkItems',
      workspacePath: ACTIVE,
      revision: 2,
      items: [],
      roles: [],
      repos: [],
      agents: [],
      settings: SETTINGS,
      claudeMcpServers: [],
    }).state;
    expect(workItemsOf(newer, ACTIVE).claudeStatus).toEqual({ state: 'signed_out' });
    expect(workItemsOf(newer, ACTIVE).revision).toBe(2);
  });
});

describe('the MCP server names in work items', () => {
  it('stores the names a snapshot carries, even under a repeated revision', () => {
    const first = applyCompanyMessage(stateFrom(), {
      type: 'companyWorkItems',
      workspacePath: ACTIVE,
      revision: 1,
      items: [],
      roles: [],
      repos: [],
      agents: [],
      settings: SETTINGS,
      claudeMcpServers: ['docs'],
    }).state;
    expect(workItemsOf(first, ACTIVE).claudeMcpServers).toEqual(['docs']);
    const renamed = applyCompanyMessage(first, {
      type: 'companyWorkItems',
      workspacePath: ACTIVE,
      revision: 1,
      items: [],
      roles: [],
      repos: [],
      agents: [],
      settings: SETTINGS,
      claudeMcpServers: ['docs', 'github'],
    }).state;
    expect(workItemsOf(renamed, ACTIVE).claudeMcpServers).toEqual(['docs', 'github']);
    expect(workItemsOf(renamed, ACTIVE).revision).toBe(1);
  });
});
