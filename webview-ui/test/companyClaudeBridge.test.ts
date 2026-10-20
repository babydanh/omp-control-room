import { describe, expect, it } from 'vitest';

import type { SquadSettings, WorkItemClaudeRun } from '../../core/src/messages.js';
import { assigneeKeyOf, CLAUDE_ASSIGNEE, CLAUDE_OPTION } from '../src/company/assigneeOptions.js';
import {
  CLAUDE_INTERRUPTED_NOTE,
  claudeInterruptedNote,
  claudeProgressLine,
  claudeStatusLabel,
} from '../src/company/claudeCodeView.js';
import { squadClaudeCheck } from '../src/company/companyMessages.js';
import { applyCompanyMessage } from '../src/company/companyState.js';
import {
  brainOf,
  permissionOf,
  type SquadSettingsDraft,
  squadSettingsDraftOf,
  squadSettingsFromDraft,
} from '../src/company/squadSettingsView.js';
import { assigneeLabel, CLAUDE_ASSIGNEE_LABEL, workItemsOf } from '../src/company/workItemView.js';
import { stateFrom } from './companyFixtures.js';

const ACTIVE = 'D:/work/app';

const SETTINGS: SquadSettings = {
  maxParallel: 4,
  maxSquadSessions: 3,
  minFreeRamGb: 2,
  autoJudge: true,
  autoApproveNext: false,
  brain: 'omp',
  claudeModelLeader: 'opus',
  claudeModelJudge: 'sonnet',
  preferClaude: false,
  maxClaudeRuns: 2,
  claudeMaxTurns: 40,
  claudeMaxBudgetUsd: 3,
  claudePermission: 'auto',
  claudeAllowedTools: ['Bash(git status*)', 'Bash(npm run *)'],
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

describe('claudeInterruptedNote', () => {
  it('shows the note only for a run the board restart cut short', () => {
    const interrupted: WorkItemClaudeRun = {
      mode: 'edit',
      startedAt: '2026-10-02T10:00:00.000Z',
      interrupted: true,
    };
    const finished: WorkItemClaudeRun = { mode: 'read', startedAt: '2026-10-02T10:00:00.000Z' };
    expect(claudeInterruptedNote(interrupted)).toBe(CLAUDE_INTERRUPTED_NOTE);
    expect(CLAUDE_INTERRUPTED_NOTE).toBe(
      'Bị gián đoạn khi board khởi động lại. Gửi tiếp để tiếp tục.',
    );
    expect(claudeInterruptedNote(finished)).toBeNull();
    expect(claudeInterruptedNote(undefined)).toBeNull();
    expect(claudeInterruptedNote(null)).toBeNull();
  });
});

describe('claudeProgressLine', () => {
  const run: WorkItemClaudeRun = {
    mode: 'edit',
    startedAt: '2026-10-02T10:00:00.000Z',
    progress: '  Đang sửa workItemView.ts  ',
  };

  it('shows the trimmed progress of a running item', () => {
    expect(claudeProgressLine({ status: 'running', claudeRun: run })).toBe(
      'Đang sửa workItemView.ts',
    );
  });

  it('shows nothing while the item is not running', () => {
    expect(claudeProgressLine({ status: 'queued', claudeRun: run })).toBeNull();
    expect(claudeProgressLine({ status: 'review', claudeRun: run })).toBeNull();
  });

  it('shows nothing when the run has reported no progress', () => {
    const blank: WorkItemClaudeRun = { ...run, progress: '   ' };
    expect(claudeProgressLine({ status: 'running', claudeRun: blank })).toBeNull();
    expect(claudeProgressLine({ status: 'running' })).toBeNull();
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

describe('brainOf', () => {
  it('names claude only for the claude choice, and omp otherwise', () => {
    expect(brainOf('claude')).toBe('claude');
    expect(brainOf('omp')).toBe('omp');
    expect(brainOf('')).toBe('omp');
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
        brain: 'claude',
        claudeModelLeader: '  opus  ',
        claudeModelJudge: 'sonnet',
        preferClaude: true,
        maxClaudeRuns: '4',
        claudeMaxTurns: '200',
        claudeMaxBudgetUsd: '0.1',
      }),
    );
    expect(reading).toEqual({
      ok: true,
      settings: {
        ...SETTINGS,
        brain: 'claude',
        claudeModelLeader: 'opus',
        preferClaude: true,
        maxClaudeRuns: 4,
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
    }).state;
    expect(workItemsOf(newer, ACTIVE).claudeStatus).toEqual({ state: 'signed_out' });
    expect(workItemsOf(newer, ACTIVE).revision).toBe(2);
  });
});
