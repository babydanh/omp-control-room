/**
 * squadSettingsView: the squad settings the drawer edits, as pure rules. The server owns the
 * values; this module turns the snapshot into text a person can type into, and turns what they
 * typed back into settings, or says in words why it cannot.
 */

import type { SquadSettings } from '../../../core/src/messages.js';

/** The whole-number bounds of the two counts. The server enforces the same bounds. */
export const SQUAD_COUNT_LIMITS = {
  maxParallel: { min: 1, max: 8 },
  maxSquadSessions: { min: 0, max: 6 },
} as const;

/** The settings as the form holds them. The numbers stay text, so a half-typed value survives. */
export interface SquadSettingsDraft {
  maxParallel: string;
  maxSquadSessions: string;
  minFreeRamGb: string;
  autoJudge: boolean;
  autoApproveNext: boolean;
}

/** The outcome of reading a draft: the settings to save, or the reason they cannot be saved. */
export type SquadSettingsReading =
  | { ok: true; settings: SquadSettings }
  | { ok: false; reason: string };

export function squadSettingsDraftOf(settings: SquadSettings): SquadSettingsDraft {
  return {
    maxParallel: String(settings.maxParallel),
    maxSquadSessions: String(settings.maxSquadSessions),
    minFreeRamGb: String(settings.minFreeRamGb),
    autoJudge: settings.autoJudge,
    autoApproveNext: settings.autoApproveNext,
  };
}

/** The number a field holds, or null when it is blank or not a finite number. */
function numberOf(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** A whole number from `min` to `max` inclusive, or null. */
function wholeIn(text: string, min: number, max: number): number | null {
  const value = numberOf(text);
  if (value === null || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

export function squadSettingsFromDraft(draft: SquadSettingsDraft): SquadSettingsReading {
  const parallel = SQUAD_COUNT_LIMITS.maxParallel;
  const sessions = SQUAD_COUNT_LIMITS.maxSquadSessions;
  const maxParallel = wholeIn(draft.maxParallel, parallel.min, parallel.max);
  if (maxParallel === null) {
    return {
      ok: false,
      reason: `Việc chạy song song là số nguyên từ ${parallel.min} đến ${parallel.max}.`,
    };
  }
  const maxSquadSessions = wholeIn(draft.maxSquadSessions, sessions.min, sessions.max);
  if (maxSquadSessions === null) {
    return {
      ok: false,
      reason: `Phiên đội tối đa là số nguyên từ ${sessions.min} đến ${sessions.max}.`,
    };
  }
  const minFreeRamGb = numberOf(draft.minFreeRamGb);
  if (minFreeRamGb === null || minFreeRamGb < 0) {
    return { ok: false, reason: 'RAM trống tối thiểu là số GB, từ 0 trở lên.' };
  }
  return {
    ok: true,
    settings: {
      maxParallel,
      maxSquadSessions,
      minFreeRamGb,
      autoJudge: draft.autoJudge,
      autoApproveNext: draft.autoApproveNext,
    },
  };
}
