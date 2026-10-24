import { describe, expect, it } from 'vitest';

import {
  isSquadSettings,
  parseSquadSettings,
  SQUAD_SETTINGS_DEFAULT,
} from '../src/company/workItems/squadSettings.js';

const VALID = {
  maxParallel: 12,
  maxSquadSessions: 12,
  maxPerRepo: 4,
  minFreeRamGb: 2,
  minFreeDiskGb: 10,
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
  claudePermission: 'auto',
  claudeAllowedTools: ['Bash(git status*)', 'Bash(npm run *)'],
  claudeWorkerMcp: ['github'],
};

describe('parseSquadSettings', () => {
  it('returns the defaults for a missing or non-object value', () => {
    expect(parseSquadSettings(undefined)).toEqual(SQUAD_SETTINGS_DEFAULT);
    expect(parseSquadSettings('bad')).toEqual(SQUAD_SETTINGS_DEFAULT);
  });
  it('defaults new settings on when an older settings file does not have them', () => {
    expect(parseSquadSettings({ autoJudge: false }).compactSquad).toBe(true);
    expect(parseSquadSettings({ maxParallel: 4, maxSquadSessions: 3 }).maxPerRepo).toBe(4);
  });

  it('keeps each valid field and defaults each invalid one', () => {
    expect(
      parseSquadSettings({
        maxParallel: 25,
        maxSquadSessions: 2,
        minFreeRamGb: 1.5,
        autoJudge: 'yes',
        autoApproveNext: true,
        engineLeader: 'claude',
        claudeModelLeader: 'haiku',
        maxClaudeRuns: 9,
        claudeMaxBudgetUsd: 0.05,
      }),
    ).toEqual({
      maxParallel: SQUAD_SETTINGS_DEFAULT.maxParallel,
      maxPerRepo: SQUAD_SETTINGS_DEFAULT.maxPerRepo,
      maxSquadSessions: 2,
      minFreeDiskGb: SQUAD_SETTINGS_DEFAULT.minFreeDiskGb,
      minFreeRamGb: 1.5,
      autoJudge: SQUAD_SETTINGS_DEFAULT.autoJudge,
      compactSquad: SQUAD_SETTINGS_DEFAULT.compactSquad,
      autoApproveNext: true,
      engineLeader: 'claude',
      engineJudge: SQUAD_SETTINGS_DEFAULT.engineJudge,
      engineWorker: SQUAD_SETTINGS_DEFAULT.engineWorker,
      claudeModelLeader: 'haiku',
      claudeModelJudge: SQUAD_SETTINGS_DEFAULT.claudeModelJudge,
      maxClaudeRuns: SQUAD_SETTINGS_DEFAULT.maxClaudeRuns,
      maxAgyRuns: SQUAD_SETTINGS_DEFAULT.maxAgyRuns,
      claudeMaxTurns: SQUAD_SETTINGS_DEFAULT.claudeMaxTurns,
      claudeMaxBudgetUsd: SQUAD_SETTINGS_DEFAULT.claudeMaxBudgetUsd,
      claudePermission: SQUAD_SETTINGS_DEFAULT.claudePermission,
      claudeAllowedTools: SQUAD_SETTINGS_DEFAULT.claudeAllowedTools,
      claudeWorkerMcp: SQUAD_SETTINGS_DEFAULT.claudeWorkerMcp,
    });
  });
  it('defaults the optional disk threshold and keeps valid fractional values', () => {
    expect(parseSquadSettings({}).minFreeDiskGb).toBe(10);
    expect(parseSquadSettings({ minFreeDiskGb: 20.5 }).minFreeDiskGb).toBe(20.5);
    expect(parseSquadSettings({ minFreeDiskGb: 501 }).minFreeDiskGb).toBe(10);
  });
  it('migrates legacy engines while preferring valid current fields', () => {
    expect(parseSquadSettings({ brain: 'claude', preferClaude: true })).toMatchObject({
      engineLeader: 'claude',
      engineJudge: 'claude',
      engineWorker: 'claude',
    });
    expect(
      parseSquadSettings({
        brain: 'claude',
        preferClaude: true,
        engineLeader: 'agy',
        engineJudge: 'omp',
        engineWorker: 'agy',
      }),
    ).toMatchObject({ engineLeader: 'agy', engineJudge: 'omp', engineWorker: 'agy' });
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

  it('keeps valid, unique MCP server names and drops the rest', () => {
    expect(
      parseSquadSettings({ claudeWorkerMcp: ['github', 'github', '', 42, 'x'.repeat(65), 'docs'] })
        .claudeWorkerMcp,
    ).toEqual(['github', 'docs']);
  });

  it('defaults the worker MCP list to none, and to none when the stored value is not a list', () => {
    expect(parseSquadSettings(undefined).claudeWorkerMcp).toEqual([]);
    expect(parseSquadSettings({ claudeWorkerMcp: 'github' }).claudeWorkerMcp).toEqual([]);
  });

  it('caps the worker MCP list at 32 names and gives each caller its own copy', () => {
    const many = Array.from({ length: 40 }, (_, index) => `server-${index}`);
    const kept = parseSquadSettings({ claudeWorkerMcp: many }).claudeWorkerMcp;
    expect(kept).toHaveLength(32);
    expect(kept[0]).toBe('server-0');
    parseSquadSettings(undefined).claudeWorkerMcp.push('github');
    expect(SQUAD_SETTINGS_DEFAULT.claudeWorkerMcp).toEqual([]);
  });
});

describe('isSquadSettings', () => {
  it('accepts a complete, in-range value', () => {
    expect(isSquadSettings(VALID)).toBe(true);
  });

  it('accepts bounds and an older settings object without maxPerRepo', () => {
    expect(isSquadSettings({ ...VALID, maxParallel: 24, maxSquadSessions: 24, maxPerRepo: 8 })).toBe(true);
    expect(isSquadSettings({ ...VALID, maxParallel: 1, maxSquadSessions: 0 })).toBe(true);
    expect(isSquadSettings({ ...VALID, minFreeDiskGb: undefined })).toBe(true);
  });

  it('refuses values outside bounds or a fraction for an integer setting', () => {
    expect(isSquadSettings({ ...VALID, maxParallel: 0 })).toBe(false);
    expect(isSquadSettings({ ...VALID, maxParallel: 2.5 })).toBe(false);
    expect(isSquadSettings({ ...VALID, maxSquadSessions: 25 })).toBe(false);
    expect(isSquadSettings({ ...VALID, maxPerRepo: 9 })).toBe(false);
    expect(isSquadSettings({ ...VALID, minFreeRamGb: -1 })).toBe(false);
    expect(isSquadSettings({ ...VALID, minFreeDiskGb: -1 })).toBe(false);
    expect(isSquadSettings({ ...VALID, minFreeDiskGb: 501 })).toBe(false);
    expect(isSquadSettings({ ...VALID, autoJudge: undefined })).toBe(false);
    expect(isSquadSettings({ ...VALID, compactSquad: undefined })).toBe(false);
    expect(isSquadSettings(null)).toBe(false);
    expect(isSquadSettings({ ...VALID, maxAgyRuns: 0 })).toBe(false);
    expect(isSquadSettings({ ...VALID, maxAgyRuns: 5 })).toBe(false);
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

  it('accepts an empty MCP list and refuses names that are not strings, too long, or repeated', () => {
    expect(isSquadSettings({ ...VALID, claudeWorkerMcp: [] })).toBe(true);
    expect(isSquadSettings({ ...VALID, claudeWorkerMcp: ['github', 'github'] })).toBe(false);
    expect(isSquadSettings({ ...VALID, claudeWorkerMcp: [''] })).toBe(false);
    expect(isSquadSettings({ ...VALID, claudeWorkerMcp: ['x'.repeat(65)] })).toBe(false);
    expect(isSquadSettings({ ...VALID, claudeWorkerMcp: [42] })).toBe(false);
    expect(isSquadSettings({ ...VALID, claudeWorkerMcp: undefined })).toBe(false);
  });
});
