/**
 * Squad settings: the per-folder limits the scheduler reads, and the rules that keep them in range.
 *
 * Pure: no I/O. A stored file may carry any value, so reading keeps each valid field and falls back
 * to the default for the rest. A command must carry every field in range, or it is refused.
 */

import type { SquadSettings } from '../../../../core/src/messages.js';
import { isRecord } from '../typeGuards.js';

/** Bytes in one gibibyte, the unit the RAM threshold is kept in. */
export const GIB = 1024 ** 3;

/**
 * A Claude model alias or id as `claude --model` takes it. Stricter than the contract's length
 * bounds: a leading dash would read as a flag, so the first character must be alphanumeric.
 */
const CLAUDE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,63}$/;

/**
 * One tool pattern `--allowedTools` takes: a tool name, optionally with one parenthesised argument
 * such as `Bash(git status*)`. Newlines and nested parentheses are refused, so a line is one pattern.
 */
const CLAUDE_TOOL_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\([^()\n]*\))?$/;

/** The tool patterns an editing run may use without asking, as a folder starts with them. */
const CLAUDE_ALLOWED_TOOLS_DEFAULT: readonly string[] = [
  'Bash(git status*)',
  'Bash(git diff*)',
  'Bash(git log*)',
  'Bash(git add*)',
  'Bash(git commit*)',
  'Bash(npm test*)',
  'Bash(npm run *)',
  'Bash(npx tsc*)',
  'Bash(npx vitest*)',
  'Bash(npx eslint*)',
  'Bash(bun test*)',
  'Bash(pnpm *)',
  'Bash(flutter test*)',
  'Bash(flutter analyze*)',
  'Bash(dart *)',
  'Bash(python *)',
];

/** The settings a folder starts with, before the user changes any. */
export const SQUAD_SETTINGS_DEFAULT: SquadSettings = {
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
  claudeAllowedTools: [...CLAUDE_ALLOWED_TOOLS_DEFAULT],
};

/** Inclusive bounds the contract allows for each numeric setting. */
export const SQUAD_SETTINGS_BOUNDS = {
  maxParallel: { min: 1, max: 8 },
  maxSquadSessions: { min: 0, max: 6 },
  minFreeRamGb: { min: 0, max: 256 },
  maxClaudeRuns: { min: 1, max: 4 },
  claudeMaxTurns: { min: 1, max: 200 },
  claudeMaxBudgetUsd: { min: 0.1, max: 50 },
} as const;

/** How many tool patterns a folder may allow, and how long each may be. */
export const CLAUDE_ALLOWED_TOOL_LIMITS = { maxCount: 32, maxLength: 120 } as const;

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function isNumberIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isClaudeModel(value: unknown): value is string {
  return typeof value === 'string' && CLAUDE_MODEL_PATTERN.test(value);
}

function isBrain(value: unknown): value is SquadSettings['brain'] {
  return value === 'omp' || value === 'claude';
}

function isClaudePermission(value: unknown): value is SquadSettings['claudePermission'] {
  return value === 'auto' || value === 'acceptEdits';
}

function isClaudeAllowedTool(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= CLAUDE_ALLOWED_TOOL_LIMITS.maxLength &&
    CLAUDE_TOOL_PATTERN.test(value)
  );
}

function isClaudeAllowedTools(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= CLAUDE_ALLOWED_TOOL_LIMITS.maxCount &&
    value.every(isClaudeAllowedTool)
  );
}

/** Keeps each valid stored tool pattern in order; a stored value that is not a list falls back. */
function parseAllowedTools(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const items: unknown[] = value;
  return items.filter(isClaudeAllowedTool).slice(0, CLAUDE_ALLOWED_TOOL_LIMITS.maxCount);
}

/** Whether a command's settings are complete and in range. */
export function isSquadSettings(value: unknown): value is SquadSettings {
  if (!isRecord(value)) return false;
  const {
    maxParallel,
    maxSquadSessions,
    minFreeRamGb,
    maxClaudeRuns,
    claudeMaxTurns,
    claudeMaxBudgetUsd,
  } = SQUAD_SETTINGS_BOUNDS;
  return (
    isIntegerIn(value.maxParallel, maxParallel.min, maxParallel.max) &&
    isIntegerIn(value.maxSquadSessions, maxSquadSessions.min, maxSquadSessions.max) &&
    isNumberIn(value.minFreeRamGb, minFreeRamGb.min, minFreeRamGb.max) &&
    typeof value.autoJudge === 'boolean' &&
    typeof value.autoApproveNext === 'boolean' &&
    isBrain(value.brain) &&
    isClaudeModel(value.claudeModelLeader) &&
    isClaudeModel(value.claudeModelJudge) &&
    typeof value.preferClaude === 'boolean' &&
    isIntegerIn(value.maxClaudeRuns, maxClaudeRuns.min, maxClaudeRuns.max) &&
    isIntegerIn(value.claudeMaxTurns, claudeMaxTurns.min, claudeMaxTurns.max) &&
    isNumberIn(value.claudeMaxBudgetUsd, claudeMaxBudgetUsd.min, claudeMaxBudgetUsd.max) &&
    isClaudePermission(value.claudePermission) &&
    isClaudeAllowedTools(value.claudeAllowedTools)
  );
}

/** Reads a stored settings object, keeping each valid field and defaulting the rest. */
export function parseSquadSettings(value: unknown): SquadSettings {
  const base = SQUAD_SETTINGS_DEFAULT;
  if (!isRecord(value)) return { ...base, claudeAllowedTools: [...base.claudeAllowedTools] };
  const {
    maxParallel,
    maxSquadSessions,
    minFreeRamGb,
    maxClaudeRuns,
    claudeMaxTurns,
    claudeMaxBudgetUsd,
  } = SQUAD_SETTINGS_BOUNDS;
  return {
    maxParallel: isIntegerIn(value.maxParallel, maxParallel.min, maxParallel.max)
      ? value.maxParallel
      : base.maxParallel,
    maxSquadSessions: isIntegerIn(
      value.maxSquadSessions,
      maxSquadSessions.min,
      maxSquadSessions.max,
    )
      ? value.maxSquadSessions
      : base.maxSquadSessions,
    minFreeRamGb: isNumberIn(value.minFreeRamGb, minFreeRamGb.min, minFreeRamGb.max)
      ? value.minFreeRamGb
      : base.minFreeRamGb,
    autoJudge: typeof value.autoJudge === 'boolean' ? value.autoJudge : base.autoJudge,
    autoApproveNext:
      typeof value.autoApproveNext === 'boolean' ? value.autoApproveNext : base.autoApproveNext,
    brain: isBrain(value.brain) ? value.brain : base.brain,
    claudeModelLeader: isClaudeModel(value.claudeModelLeader)
      ? value.claudeModelLeader
      : base.claudeModelLeader,
    claudeModelJudge: isClaudeModel(value.claudeModelJudge)
      ? value.claudeModelJudge
      : base.claudeModelJudge,
    preferClaude: typeof value.preferClaude === 'boolean' ? value.preferClaude : base.preferClaude,
    maxClaudeRuns: isIntegerIn(value.maxClaudeRuns, maxClaudeRuns.min, maxClaudeRuns.max)
      ? value.maxClaudeRuns
      : base.maxClaudeRuns,
    claudeMaxTurns: isIntegerIn(value.claudeMaxTurns, claudeMaxTurns.min, claudeMaxTurns.max)
      ? value.claudeMaxTurns
      : base.claudeMaxTurns,
    claudeMaxBudgetUsd: isNumberIn(
      value.claudeMaxBudgetUsd,
      claudeMaxBudgetUsd.min,
      claudeMaxBudgetUsd.max,
    )
      ? value.claudeMaxBudgetUsd
      : base.claudeMaxBudgetUsd,
    claudePermission: isClaudePermission(value.claudePermission)
      ? value.claudePermission
      : base.claudePermission,
    claudeAllowedTools: parseAllowedTools(value.claudeAllowedTools, base.claudeAllowedTools),
  };
}
