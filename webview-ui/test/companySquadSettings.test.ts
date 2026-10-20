import { describe, expect, it } from 'vitest';

import type { SquadSettings } from '../../core/src/messages.js';
import { squadSettingsSet } from '../src/company/companyMessages.js';
import {
  type SquadSettingsDraft,
  squadSettingsDraftOf,
  squadSettingsFromDraft,
} from '../src/company/squadSettingsView.js';

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
  claudePermission: 'acceptEdits',
  claudeAllowedTools: ['Bash(git status*)', 'Edit'],
  claudeWorkerMcp: ['github'],
};

/** The draft the form holds once a person has changed the given fields of the saved settings. */
function draftWith(overrides: Partial<SquadSettingsDraft>): SquadSettingsDraft {
  return { ...squadSettingsDraftOf(SETTINGS), ...overrides };
}

describe('squadSettingsDraftOf', () => {
  it('holds each number as text and each switch as it is', () => {
    expect(squadSettingsDraftOf(SETTINGS)).toEqual({
      maxParallel: '4',
      maxSquadSessions: '3',
      minFreeRamGb: '2',
      autoJudge: true,
      autoApproveNext: false,
      brain: 'omp',
      claudeModelLeader: 'opus',
      claudeModelJudge: 'sonnet',
      preferClaude: false,
      maxClaudeRuns: '2',
      claudeMaxTurns: '40',
      claudeMaxBudgetUsd: '3',
      claudePermission: 'acceptEdits',
      claudeAllowedTools: 'Bash(git status*)\nEdit',
      claudeWorkerMcp: ['github'],
    });
  });

  it('copies the chosen MCP servers, so changing the draft leaves the settings alone', () => {
    const draft = squadSettingsDraftOf(SETTINGS);
    draft.claudeWorkerMcp.push('docs');
    expect(SETTINGS.claudeWorkerMcp).toEqual(['github']);
  });
});

describe('squadSettingsFromDraft', () => {
  it('reads back the settings the draft was drawn from', () => {
    expect(squadSettingsFromDraft(squadSettingsDraftOf(SETTINGS))).toEqual({
      ok: true,
      settings: SETTINGS,
    });
  });

  it('accepts the bounds of each count, and trims the text around a number', () => {
    expect(squadSettingsFromDraft(draftWith({ maxParallel: ' 8 ', maxSquadSessions: '0' }))).toEqual(
      {
        ok: true,
        settings: { ...SETTINGS, maxParallel: 8, maxSquadSessions: 0 },
      },
    );
    expect(squadSettingsFromDraft(draftWith({ maxParallel: '1' })).ok).toBe(true);
    expect(squadSettingsFromDraft(draftWith({ maxSquadSessions: '6' })).ok).toBe(true);
  });

  it('refuses a parallel count outside 1 to 8, or one that is not a whole number', () => {
    for (const maxParallel of ['0', '9', '2.5', '', 'abc']) {
      expect(squadSettingsFromDraft(draftWith({ maxParallel }))).toEqual({
        ok: false,
        reason: 'Việc chạy song song là số nguyên từ 1 đến 8.',
      });
    }
  });

  it('refuses a session count outside 0 to 6, or one that is not a whole number', () => {
    for (const maxSquadSessions of ['-1', '7', '1.5', '']) {
      expect(squadSettingsFromDraft(draftWith({ maxSquadSessions }))).toEqual({
        ok: false,
        reason: 'Phiên đội tối đa là số nguyên từ 0 đến 6.',
      });
    }
  });

  it('accepts half gigabytes of free RAM, and refuses a floor below zero or not a number', () => {
    expect(squadSettingsFromDraft(draftWith({ minFreeRamGb: '0.5' }))).toEqual({
      ok: true,
      settings: { ...SETTINGS, minFreeRamGb: 0.5 },
    });
    for (const minFreeRamGb of ['-0.5', 'abc', '']) {
      expect(squadSettingsFromDraft(draftWith({ minFreeRamGb }))).toEqual({
        ok: false,
        reason: 'RAM trống tối thiểu là số GB, từ 0 trở lên.',
      });
    }
  });

  it('carries the two switches through unchanged', () => {
    expect(
      squadSettingsFromDraft(draftWith({ autoJudge: false, autoApproveNext: true })),
    ).toEqual({
      ok: true,
      settings: { ...SETTINGS, autoJudge: false, autoApproveNext: true },
    });
  });
});

describe('squadSettingsSet', () => {
  it('builds the save command with its request id, its folder and the whole settings set', () => {
    expect(squadSettingsSet('r9', ACTIVE, SETTINGS)).toEqual({
      type: 'companySquadSettingsSet',
      requestId: 'r9',
      workspacePath: ACTIVE,
      settings: SETTINGS,
    });
  });
});
