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
    });
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
});
