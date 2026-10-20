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

/** The bounds of the Claude Code settings. The server enforces the same bounds. */
export const CLAUDE_SETTING_LIMITS = {
  /** A model name's length, in characters. */
  modelChars: { min: 1, max: 64 },
  maxClaudeRuns: { min: 1, max: 4 },
  claudeMaxTurns: { min: 1, max: 200 },
  /** The budget of one run, in US dollars. It need not be a whole number. */
  claudeMaxBudgetUsd: { min: 0.1, max: 50 },
} as const;

/** The settings as the form holds them. The numbers stay text, so a half-typed value survives. */
export interface SquadSettingsDraft {
  maxParallel: string;
  maxSquadSessions: string;
  minFreeRamGb: string;
  autoJudge: boolean;
  autoApproveNext: boolean;
  brain: SquadSettings['brain'];
  claudeModelLeader: string;
  claudeModelJudge: string;
  preferClaude: boolean;
  maxClaudeRuns: string;
  claudeMaxTurns: string;
  claudeMaxBudgetUsd: string;
}

/** The outcome of reading a draft: the settings to save, or the reason they cannot be saved. */
export type SquadSettingsReading =
  | { ok: true; settings: SquadSettings }
  | { ok: false; reason: string };

/** The brain a form choice names. Anything but `claude` is omp, the default brain. */
export function brainOf(choice: string): SquadSettings['brain'] {
  return choice === 'claude' ? 'claude' : 'omp';
}

export function squadSettingsDraftOf(settings: SquadSettings): SquadSettingsDraft {
  return {
    maxParallel: String(settings.maxParallel),
    maxSquadSessions: String(settings.maxSquadSessions),
    minFreeRamGb: String(settings.minFreeRamGb),
    autoJudge: settings.autoJudge,
    autoApproveNext: settings.autoApproveNext,
    brain: settings.brain,
    claudeModelLeader: settings.claudeModelLeader,
    claudeModelJudge: settings.claudeModelJudge,
    preferClaude: settings.preferClaude,
    maxClaudeRuns: String(settings.maxClaudeRuns),
    claudeMaxTurns: String(settings.claudeMaxTurns),
    claudeMaxBudgetUsd: String(settings.claudeMaxBudgetUsd),
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

/** A number from `min` to `max` inclusive, or null. */
function numberIn(text: string, min: number, max: number): number | null {
  const value = numberOf(text);
  if (value === null || value < min || value > max) return null;
  return value;
}

/** A model name, trimmed, when it is `min` to `max` characters long; otherwise null. */
function modelIn(text: string, min: number, max: number): string | null {
  const trimmed = text.trim();
  const length = Array.from(trimmed).length;
  return length < min || length > max ? null : trimmed;
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
  const models = CLAUDE_SETTING_LIMITS.modelChars;
  const claudeModelLeader = modelIn(draft.claudeModelLeader, models.min, models.max);
  if (claudeModelLeader === null) {
    return {
      ok: false,
      reason: `Model của trưởng nhóm có từ ${models.min} đến ${models.max} ký tự.`,
    };
  }
  const claudeModelJudge = modelIn(draft.claudeModelJudge, models.min, models.max);
  if (claudeModelJudge === null) {
    return {
      ok: false,
      reason: `Model của trọng tài có từ ${models.min} đến ${models.max} ký tự.`,
    };
  }
  const runs = CLAUDE_SETTING_LIMITS.maxClaudeRuns;
  const maxClaudeRuns = wholeIn(draft.maxClaudeRuns, runs.min, runs.max);
  if (maxClaudeRuns === null) {
    return {
      ok: false,
      reason: `Số lần Claude Code chạy cùng lúc là số nguyên từ ${runs.min} đến ${runs.max}.`,
    };
  }
  const turns = CLAUDE_SETTING_LIMITS.claudeMaxTurns;
  const claudeMaxTurns = wholeIn(draft.claudeMaxTurns, turns.min, turns.max);
  if (claudeMaxTurns === null) {
    return {
      ok: false,
      reason: `Số lượt tối đa mỗi lần chạy là số nguyên từ ${turns.min} đến ${turns.max}.`,
    };
  }
  const budget = CLAUDE_SETTING_LIMITS.claudeMaxBudgetUsd;
  const claudeMaxBudgetUsd = numberIn(draft.claudeMaxBudgetUsd, budget.min, budget.max);
  if (claudeMaxBudgetUsd === null) {
    return { ok: false, reason: 'Ngân sách mỗi lần chạy là số USD từ 0,1 đến 50.' };
  }
  return {
    ok: true,
    settings: {
      maxParallel,
      maxSquadSessions,
      minFreeRamGb,
      autoJudge: draft.autoJudge,
      autoApproveNext: draft.autoApproveNext,
      brain: draft.brain,
      claudeModelLeader,
      claudeModelJudge,
      preferClaude: draft.preferClaude,
      maxClaudeRuns,
      claudeMaxTurns,
      claudeMaxBudgetUsd,
    },
  };
}
