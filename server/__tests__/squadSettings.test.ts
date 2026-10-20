import { describe, expect, it } from 'vitest';

import {
  isSquadSettings,
  parseSquadSettings,
  SQUAD_SETTINGS_DEFAULT,
} from '../src/company/workItems/squadSettings.js';

const VALID = {
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

describe('parseSquadSettings', () => {
  it('returns the defaults for a missing or non-object value', () => {
    expect(parseSquadSettings(undefined)).toEqual(SQUAD_SETTINGS_DEFAULT);
    expect(parseSquadSettings('bad')).toEqual(SQUAD_SETTINGS_DEFAULT);
  });

  it('keeps each valid field and defaults each invalid one', () => {
    expect(
      parseSquadSettings({
        maxParallel: 9,
        maxSquadSessions: 2,
        minFreeRamGb: 1.5,
        autoJudge: 'yes',
        autoApproveNext: true,
        brain: 'claude',
        claudeModelLeader: 'haiku',
        maxClaudeRuns: 9,
        claudeMaxBudgetUsd: 0.05,
      }),
    ).toEqual({
      maxParallel: SQUAD_SETTINGS_DEFAULT.maxParallel,
      maxSquadSessions: 2,
      minFreeRamGb: 1.5,
      autoJudge: SQUAD_SETTINGS_DEFAULT.autoJudge,
      autoApproveNext: true,
      brain: 'claude',
      claudeModelLeader: 'haiku',
      claudeModelJudge: SQUAD_SETTINGS_DEFAULT.claudeModelJudge,
      preferClaude: SQUAD_SETTINGS_DEFAULT.preferClaude,
      maxClaudeRuns: SQUAD_SETTINGS_DEFAULT.maxClaudeRuns,
      claudeMaxTurns: SQUAD_SETTINGS_DEFAULT.claudeMaxTurns,
      claudeMaxBudgetUsd: SQUAD_SETTINGS_DEFAULT.claudeMaxBudgetUsd,
      claudePermission: SQUAD_SETTINGS_DEFAULT.claudePermission,
      claudeAllowedTools: SQUAD_SETTINGS_DEFAULT.claudeAllowedTools,
    });
  });

  it('keeps each valid tool pattern in order and drops the invalid ones', () => {
    expect(
      parseSquadSettings({
        claudePermission: 'acceptEdits',
        claudeAllowedTools: ['Bash(git status*)', 'Bash(', 'Edit', 'Bash(a(b))', 42, ''],
      }),
    ).toMatchObject({
      claudePermission: 'acceptEdits',
      claudeAllowedTools: ['Bash(git status*)', 'Edit'],
    });
  });

  it('defaults an unknown permission mode and a stored value that is not a list', () => {
    expect(
      parseSquadSettings({ claudePermission: 'bypassPermissions', claudeAllowedTools: 'Edit' }),
    ).toMatchObject({
      claudePermission: SQUAD_SETTINGS_DEFAULT.claudePermission,
      claudeAllowedTools: SQUAD_SETTINGS_DEFAULT.claudeAllowedTools,
    });
  });

  it('caps the allowlist at 32 patterns', () => {
    const many = Array.from({ length: 40 }, (_, index) => `Bash(cmd${index}*)`);
    const kept = parseSquadSettings({ claudeAllowedTools: many }).claudeAllowedTools;
    expect(kept).toHaveLength(32);
    expect(kept[0]).toBe('Bash(cmd0*)');
  });

  it('gives each caller its own copy of the default allowlist', () => {
    parseSquadSettings(undefined).claudeAllowedTools.push('Edit');
    expect(SQUAD_SETTINGS_DEFAULT.claudeAllowedTools).not.toContain('Edit');
  });
});

describe('isSquadSettings', () => {
  it('accepts a complete, in-range value', () => {
    expect(isSquadSettings(VALID)).toBe(true);
  });

  it('accepts the bounds themselves', () => {
    expect(isSquadSettings({ ...VALID, maxParallel: 8, maxSquadSessions: 0 })).toBe(true);
    expect(isSquadSettings({ ...VALID, maxParallel: 1, minFreeRamGb: 0 })).toBe(true);
  });

  it('refuses a value outside a bound, a fraction for a count, or a missing flag', () => {
    expect(isSquadSettings({ ...VALID, maxParallel: 0 })).toBe(false);
    expect(isSquadSettings({ ...VALID, maxParallel: 2.5 })).toBe(false);
    expect(isSquadSettings({ ...VALID, maxSquadSessions: 7 })).toBe(false);
    expect(isSquadSettings({ ...VALID, minFreeRamGb: -1 })).toBe(false);
    expect(isSquadSettings({ ...VALID, autoJudge: undefined })).toBe(false);
    expect(isSquadSettings(null)).toBe(false);
  });

  it('refuses an unknown permission mode or a tool pattern that is not one', () => {
    expect(isSquadSettings({ ...VALID, claudePermission: 'plan' })).toBe(false);
    expect(isSquadSettings({ ...VALID, claudeAllowedTools: ['Bash('] })).toBe(false);
    expect(
      isSquadSettings({ ...VALID, claudeAllowedTools: ['--dangerously-skip-permissions'] }),
    ).toBe(false);
  });

  it('accepts an empty allowlist and refuses more than 32 patterns', () => {
    expect(isSquadSettings({ ...VALID, claudeAllowedTools: [] })).toBe(true);
    const many = Array.from({ length: 33 }, (_, index) => `Bash(cmd${index}*)`);
    expect(isSquadSettings({ ...VALID, claudeAllowedTools: many })).toBe(false);
  });
});
