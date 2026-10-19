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
      }),
    ).toEqual({
      maxParallel: SQUAD_SETTINGS_DEFAULT.maxParallel,
      maxSquadSessions: 2,
      minFreeRamGb: 1.5,
      autoJudge: SQUAD_SETTINGS_DEFAULT.autoJudge,
      autoApproveNext: true,
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
