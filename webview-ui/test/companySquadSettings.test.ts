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
  maxParallel: 12,
  maxSquadSessions: 12,
  maxPerRepo: 4,
  minFreeRamGb: 2,
  autoJudge: true,
  autoApproveNext: false,
  compactSquad: true,
  engineLeader: 'omp',
  engineJudge: 'omp',
  engineWorker: 'omp',
  claudeModelLeader: 'opus',
  claudeModelJudge: 'sonnet',
  maxClaudeRuns: 2,
  maxAgyRuns: 2,
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
      maxParallel: '12',
      maxSquadSessions: '12',
      maxPerRepo: '4',
      minFreeRamGb: '2',
      autoJudge: true,
      autoApproveNext: false,
      compactSquad: true,
      engineLeader: 'omp',
      engineJudge: 'omp',
      engineWorker: 'omp',
      claudeModelLeader: 'opus',
      claudeModelJudge: 'sonnet',
      maxClaudeRuns: '2',
      maxAgyRuns: '2',
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
    expect(squadSettingsFromDraft(draftWith({
      maxParallel: ' 24 ',
      maxSquadSessions: '24',
      maxPerRepo: '8',
    }))).toEqual({
      ok: true,
      settings: { ...SETTINGS, maxParallel: 24, maxSquadSessions: 24, maxPerRepo: 8 },
    });
    expect(squadSettingsFromDraft(draftWith({ maxParallel: '1' })).ok).toBe(true);
    expect(squadSettingsFromDraft(draftWith({ maxSquadSessions: '0' })).ok).toBe(true);
  });

  it('saves each selected engine and the agy concurrency limit', () => {
    expect(
      squadSettingsFromDraft(
        draftWith({
          engineLeader: 'claude',
          engineJudge: 'agy',
          engineWorker: 'agy',
          maxAgyRuns: '4',
        }),
      ),
    ).toEqual({
      ok: true,
      settings: {
        ...SETTINGS,
        engineLeader: 'claude',
        engineJudge: 'agy',
        engineWorker: 'agy',
        maxAgyRuns: 4,
      },
    });
  });

  it('refuses an agy run count outside the allowed whole-number range', () => {
    for (const maxAgyRuns of ['0', '5', '2.5', '']) {
      expect(squadSettingsFromDraft(draftWith({ maxAgyRuns }))).toEqual({
        ok: false,
        reason: 'Số lượt agy chạy cùng lúc là số nguyên từ 1 đến 4.',
      });
    }
  });

  it('refuses a parallel count outside 1 to 24, or one that is not a whole number', () => {
    for (const maxParallel of ['0', '25', '2.5', '', 'abc']) {
      expect(squadSettingsFromDraft(draftWith({ maxParallel }))).toEqual({
        ok: false,
        reason: 'Việc chạy song song là số nguyên từ 1 đến 24.',
      });
    }
  });

  it('refuses a session count outside 0 to 24, or one that is not a whole number', () => {
    for (const maxSquadSessions of ['-1', '25', '1.5', '']) {
      expect(squadSettingsFromDraft(draftWith({ maxSquadSessions }))).toEqual({
        ok: false,
        reason: 'Phiên đội tối đa là số nguyên từ 0 đến 24.',
      });
    }
  });
  it('refuses a per-repo count outside 1 to 8', () => {
    for (const maxPerRepo of ['0', '9', '2.5', '']) {
      expect(squadSettingsFromDraft(draftWith({ maxPerRepo }))).toEqual({
        ok: false,
        reason: 'Số việc mỗi repo chạy cùng lúc là số nguyên từ 1 đến 8.',
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

  it('carries all switches through unchanged', () => {
    expect(
      squadSettingsFromDraft(
        draftWith({ autoJudge: false, autoApproveNext: true, compactSquad: false }),
      ),
    ).toEqual({
      ok: true,
      settings: { ...SETTINGS, autoJudge: false, autoApproveNext: true, compactSquad: false },
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
