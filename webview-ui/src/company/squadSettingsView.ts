/**
 * squadSettingsView: the squad settings the drawer edits, as pure rules. The server owns the
 * values; this module turns the snapshot into text a person can type into, and turns what they
 * typed back into settings, or says in words why it cannot.
 */

import type { SquadSettings } from '../../../core/src/messages.js';

/** The whole-number bounds of the two counts. The server enforces the same bounds. */
export const SQUAD_COUNT_LIMITS = {
  maxParallel: { min: 1, max: 24 },
  maxSquadSessions: { min: 0, max: 24 },
  maxPerRepo: { min: 1, max: 8 },
} as const;

export const DISK_SETTING_LIMITS = {
  minFreeDiskGb: { min: 0, max: 500 },
} as const;

/** The bounds of external CLI run counts. The server enforces the same bounds. */
export const CLI_SETTING_LIMITS = {
  maxClaudeRuns: { min: 1, max: 4 },
  maxAgyRuns: { min: 1, max: 4 },
} as const;

/** The bounds of the Claude Code settings. The server enforces the same bounds. */
export const CLAUDE_SETTING_LIMITS = {
  /** A model name's length, in characters. */
  modelChars: { min: 1, max: 64 },
  claudeMaxTurns: { min: 1, max: 200 },
  /** The budget of one run, in US dollars. It need not be a whole number. */
  claudeMaxBudgetUsd: { min: 0.1, max: 50 },
  /** How many tool patterns an editing run may allow, and how long each may be. */
  claudeAllowedTools: { maxCount: 32, maxChars: 120 },
  /** How many MCP servers a worker run may load, and how long each name may be. */
  claudeWorkerMcp: { maxCount: 32, maxChars: 64 },
} as const;

/** A tool pattern `--allowedTools` takes: a tool name, optionally with one parenthesised argument. */
const CLAUDE_TOOL_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\([^()\n]*\))?$/;

/** The settings as the form holds them. The numbers stay text, so a half-typed value survives. */
export type SquadEngine = 'omp' | 'claude' | 'agy';

export interface SquadSettingsDraft {
  maxParallel: string;
  maxSquadSessions: string;
  maxPerRepo: string;
  minFreeRamGb: string;
  minFreeDiskGb: string;
  autoJudge: boolean;
  autoApproveNext: boolean;
  compactSquad: boolean;
  engineLeader: SquadEngine;
  engineJudge: SquadEngine;
  engineWorker: SquadEngine;
  claudeModelLeader: string;
  claudeModelJudge: string;
  maxClaudeRuns: string;
  maxAgyRuns: string;
  claudeMaxTurns: string;
  claudeMaxBudgetUsd: string;
  claudePermission: SquadSettings['claudePermission'];
  /** One tool pattern per line, as the form shows them. */
  claudeAllowedTools: string;
  /** The MCP servers a worker run loads: the names the form's chips have chosen. */
  claudeWorkerMcp: string[];
}

/** The outcome of reading a draft: the settings to save, or the reason they cannot be saved. */
export type SquadSettingsReading =
  | { ok: true; settings: SquadSettings }
  | { ok: false; reason: string };

/** The engine a form choice names, defaulting safely to omp. */
export function squadEngineOf(choice: string): SquadEngine {
  return choice === 'claude' || choice === 'agy' ? choice : 'omp';
}

/** The permission mode a form choice names. Anything but acceptEdits is auto, the default. */
export function permissionOf(choice: string): SquadSettings['claudePermission'] {
  return choice === 'acceptEdits' ? 'acceptEdits' : 'auto';
}

export function squadSettingsDraftOf(settings: SquadSettings): SquadSettingsDraft {
  return {
    maxParallel: String(settings.maxParallel),
    maxSquadSessions: String(settings.maxSquadSessions),
    maxPerRepo: String(settings.maxPerRepo ?? 4),
    minFreeRamGb: String(settings.minFreeRamGb),
    minFreeDiskGb: String(settings.minFreeDiskGb ?? 10),
    autoJudge: settings.autoJudge,
    compactSquad: settings.compactSquad,
    autoApproveNext: settings.autoApproveNext,
    engineLeader: settings.engineLeader,
    engineJudge: settings.engineJudge,
    engineWorker: settings.engineWorker,
    claudeModelLeader: settings.claudeModelLeader,
    claudeModelJudge: settings.claudeModelJudge,
    maxClaudeRuns: String(settings.maxClaudeRuns),
    maxAgyRuns: String(settings.maxAgyRuns),
    claudeMaxTurns: String(settings.claudeMaxTurns),
    claudeMaxBudgetUsd: String(settings.claudeMaxBudgetUsd),
    claudePermission: settings.claudePermission,
    claudeAllowedTools: settings.claudeAllowedTools.join('\n'),
    claudeWorkerMcp: [...settings.claudeWorkerMcp],
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

/** Whether a line is one tool pattern: a tool name, optionally with one parenthesised argument. */
function isToolPattern(text: string, maxChars: number): boolean {
  return text.length <= maxChars && CLAUDE_TOOL_PATTERN.test(text);
}

export function squadSettingsFromDraft(draft: SquadSettingsDraft): SquadSettingsReading {
  const parallel = SQUAD_COUNT_LIMITS.maxParallel;
  const sessions = SQUAD_COUNT_LIMITS.maxSquadSessions;
  const perRepo = SQUAD_COUNT_LIMITS.maxPerRepo;
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
  const maxPerRepo = wholeIn(draft.maxPerRepo, perRepo.min, perRepo.max);
  if (maxPerRepo === null) {
    return {
      ok: false,
      reason: `Số việc mỗi repo chạy cùng lúc là số nguyên từ ${perRepo.min} đến ${perRepo.max}.`,
    };
  }
  const minFreeRamGb = numberOf(draft.minFreeRamGb);
  if (minFreeRamGb === null || minFreeRamGb < 0) {
    return { ok: false, reason: 'RAM trống tối thiểu là số GB, từ 0 trở lên.' };
  }
  const disk = DISK_SETTING_LIMITS.minFreeDiskGb;
  const minFreeDiskGb = numberIn(draft.minFreeDiskGb, disk.min, disk.max);
  if (minFreeDiskGb === null) {
    return { ok: false, reason: `Ổ đĩa trống tối thiểu là số GB, từ ${disk.min} đến ${disk.max}.` };
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
  const claudeRuns = CLI_SETTING_LIMITS.maxClaudeRuns;
  const maxClaudeRuns = wholeIn(draft.maxClaudeRuns, claudeRuns.min, claudeRuns.max);
  if (maxClaudeRuns === null) {
    return {
      ok: false,
      reason: `Số lần Claude Code chạy cùng lúc là số nguyên từ ${claudeRuns.min} đến ${claudeRuns.max}.`,
    };
  }
  const agyRuns = CLI_SETTING_LIMITS.maxAgyRuns;
  const maxAgyRuns = wholeIn(draft.maxAgyRuns, agyRuns.min, agyRuns.max);
  if (maxAgyRuns === null) {
    return {
      ok: false,
      reason: `Số lượt agy chạy cùng lúc là số nguyên từ ${agyRuns.min} đến ${agyRuns.max}.`,
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
  const toolLimits = CLAUDE_SETTING_LIMITS.claudeAllowedTools;
  const claudeAllowedTools = draft.claudeAllowedTools
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (claudeAllowedTools.length > toolLimits.maxCount) {
    return {
      ok: false,
      reason: `Danh sách quyền công cụ có tối đa ${toolLimits.maxCount} dòng.`,
    };
  }
  const badTool = claudeAllowedTools.find((line) => !isToolPattern(line, toolLimits.maxChars));
  if (badTool !== undefined) {
    return {
      ok: false,
      reason: `Quyền công cụ "${badTool}" không hợp lệ. Mỗi dòng là một quyền, ví dụ Bash(git status*) hoặc Edit.`,
    };
  }
  const mcpLimits = CLAUDE_SETTING_LIMITS.claudeWorkerMcp;
  if (draft.claudeWorkerMcp.length > mcpLimits.maxCount) {
    return {
      ok: false,
      reason: `Máy chủ MCP cho Claude Code có tối đa ${mcpLimits.maxCount} máy chủ.`,
    };
  }
  const badServer = draft.claudeWorkerMcp.find(
    (name) => name.length < 1 || name.length > mcpLimits.maxChars,
  );
  if (badServer !== undefined) {
    return { ok: false, reason: `Tên máy chủ MCP có từ 1 đến ${mcpLimits.maxChars} ký tự.` };
  }
  return {
    ok: true,
    settings: {
      maxParallel,
      maxSquadSessions,
      maxPerRepo,
      minFreeRamGb,
      minFreeDiskGb,
      autoJudge: draft.autoJudge,
      compactSquad: draft.compactSquad,
      autoApproveNext: draft.autoApproveNext,
      engineLeader: draft.engineLeader,
      engineJudge: draft.engineJudge,
      engineWorker: draft.engineWorker,
      claudeModelLeader,
      claudeModelJudge,
      maxClaudeRuns,
      maxAgyRuns,
      claudeMaxTurns,
      claudeMaxBudgetUsd,
      claudePermission: draft.claudePermission,
      claudeAllowedTools,
      claudeWorkerMcp: [...draft.claudeWorkerMcp],
    },
  };
}
