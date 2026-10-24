/**
 * Squad settings: the per-folder limits the scheduler reads, and the rules that keep them in range.
 *
 * Pure: no I/O. A stored file may carry any value, so reading keeps each valid field and falls back
 * to the default for the rest. A command must carry every field in range, or it is refused.
 */

import type { SquadSettings } from '../../../../core/src/messages.js';
import { isClaudeMcpServerName } from '../claudeCode/claudeMcp.js';
import { isRecord } from '../typeGuards.js';

export type SquadEngine = 'omp' | 'claude' | 'agy';
/** Bytes in one gibibyte, the unit RAM and disk thresholds are kept in. */
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
  compactSquad: true,
  autoJudge: true,
  maxParallel: 12,
  maxSquadSessions: 12,
  maxPerRepo: 4,
  minFreeRamGb: 2,
  minFreeDiskGb: 10,
  autoApproveNext: false,
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
  claudeAllowedTools: [...CLAUDE_ALLOWED_TOOLS_DEFAULT],
  claudeWorkerMcp: [],
};

/** Inclusive bounds the contract allows for each numeric setting. */
export const SQUAD_SETTINGS_BOUNDS = {
  maxParallel: { min: 1, max: 24 },
  maxSquadSessions: { min: 0, max: 24 },
  maxPerRepo: { min: 1, max: 8 },
  minFreeRamGb: { min: 0, max: 256 },
  minFreeDiskGb: { min: 0, max: 500 },
  maxClaudeRuns: { min: 1, max: 4 },
  maxAgyRuns: { min: 1, max: 4 },
  claudeMaxTurns: { min: 1, max: 200 },
  claudeMaxBudgetUsd: { min: 0.1, max: 50 },
} as const;

/** How many tool patterns a folder may allow, and how long each may be. */
export const CLAUDE_ALLOWED_TOOL_LIMITS = { maxCount: 32, maxLength: 120 } as const;

/** How many MCP servers a worker run may load: the most the squad keeps. */
export const CLAUDE_WORKER_MCP_LIMITS = { maxCount: 32 } as const;

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function isNumberIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isClaudeModel(value: unknown): value is string {
  return typeof value === 'string' && CLAUDE_MODEL_PATTERN.test(value);
}

function isSquadEngine(value: unknown): value is SquadEngine {
  return value === 'omp' || value === 'claude' || value === 'agy';
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

/** Whether a worker's MCP server list is in range: a count limit, names only, none repeated. */
function isClaudeWorkerMcp(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= CLAUDE_WORKER_MCP_LIMITS.maxCount &&
    value.every(isClaudeMcpServerName) &&
    new Set(value).size === value.length
  );
}

/** Keeps each valid stored server name once, in order; anything but a list keeps none. */
function parseWorkerMcp(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items: unknown[] = value;
  const names = [...new Set(items.filter(isClaudeMcpServerName))];
  return names.slice(0, CLAUDE_WORKER_MCP_LIMITS.maxCount);
}

/** Whether a command's settings are complete and in range. */
export function isSquadSettings(value: unknown): value is SquadSettings {
  if (!isRecord(value)) return false;
  const {
    maxParallel,
    maxSquadSessions,
    maxPerRepo,
    minFreeRamGb,
    minFreeDiskGb,
    maxClaudeRuns,
    maxAgyRuns,
    claudeMaxTurns,
    claudeMaxBudgetUsd,
  } = SQUAD_SETTINGS_BOUNDS;
  return (
    isIntegerIn(value.maxParallel, maxParallel.min, maxParallel.max) &&
    isIntegerIn(value.maxSquadSessions, maxSquadSessions.min, maxSquadSessions.max) &&
    (value.maxPerRepo === undefined || isIntegerIn(value.maxPerRepo, maxPerRepo.min, maxPerRepo.max)) &&
    isNumberIn(value.minFreeRamGb, minFreeRamGb.min, minFreeRamGb.max) &&
    (value.minFreeDiskGb === undefined ||
      isNumberIn(value.minFreeDiskGb, minFreeDiskGb.min, minFreeDiskGb.max)) &&
    typeof value.autoJudge === 'boolean' &&
    typeof value.compactSquad === 'boolean' &&
    typeof value.autoApproveNext === 'boolean' &&
    isSquadEngine(value.engineLeader) &&
    isSquadEngine(value.engineJudge) &&
    isSquadEngine(value.engineWorker) &&
    isClaudeModel(value.claudeModelLeader) &&
    isClaudeModel(value.claudeModelJudge) &&
    isIntegerIn(value.maxClaudeRuns, maxClaudeRuns.min, maxClaudeRuns.max) &&
    isIntegerIn(value.maxAgyRuns, maxAgyRuns.min, maxAgyRuns.max) &&
    isIntegerIn(value.claudeMaxTurns, claudeMaxTurns.min, claudeMaxTurns.max) &&
    isNumberIn(value.claudeMaxBudgetUsd, claudeMaxBudgetUsd.min, claudeMaxBudgetUsd.max) &&
    isClaudePermission(value.claudePermission) &&
    isClaudeAllowedTools(value.claudeAllowedTools) &&
    isClaudeWorkerMcp(value.claudeWorkerMcp)
  );
}

/** Reads a stored settings object, keeping each valid field and defaulting the rest. */
export function parseSquadSettings(value: unknown): SquadSettings {
  const base = SQUAD_SETTINGS_DEFAULT;
  if (!isRecord(value)) {
    return {
      ...base,
      claudeAllowedTools: [...base.claudeAllowedTools],
      claudeWorkerMcp: [...base.claudeWorkerMcp],
    };
  }
  const {
    maxParallel,
    maxSquadSessions,
    maxPerRepo,
    minFreeRamGb,
    minFreeDiskGb,
    maxClaudeRuns,
    maxAgyRuns,
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
    maxPerRepo: isIntegerIn(value.maxPerRepo, maxPerRepo.min, maxPerRepo.max)
      ? value.maxPerRepo
      : base.maxPerRepo,
    minFreeRamGb: isNumberIn(value.minFreeRamGb, minFreeRamGb.min, minFreeRamGb.max)
      ? value.minFreeRamGb
      : base.minFreeRamGb,
    minFreeDiskGb: isNumberIn(value.minFreeDiskGb, minFreeDiskGb.min, minFreeDiskGb.max)
      ? value.minFreeDiskGb
      : base.minFreeDiskGb,
    autoJudge: typeof value.autoJudge === 'boolean' ? value.autoJudge : base.autoJudge,
    compactSquad:
      typeof value.compactSquad === 'boolean' ? value.compactSquad : base.compactSquad,
    autoApproveNext:
      typeof value.autoApproveNext === 'boolean' ? value.autoApproveNext : base.autoApproveNext,
    engineLeader: isSquadEngine(value.engineLeader)
      ? value.engineLeader
      : value.brain === 'omp' || value.brain === 'claude'
        ? value.brain
        : base.engineLeader,
    engineJudge: isSquadEngine(value.engineJudge)
      ? value.engineJudge
      : value.brain === 'omp' || value.brain === 'claude'
        ? value.brain
        : base.engineJudge,
    claudeModelLeader: isClaudeModel(value.claudeModelLeader)
      ? value.claudeModelLeader
      : base.claudeModelLeader,
    claudeModelJudge: isClaudeModel(value.claudeModelJudge)
      ? value.claudeModelJudge
      : base.claudeModelJudge,
    engineWorker: isSquadEngine(value.engineWorker)
      ? value.engineWorker
      : value.preferClaude === true
        ? 'claude'
        : base.engineWorker,
    maxClaudeRuns: isIntegerIn(value.maxClaudeRuns, maxClaudeRuns.min, maxClaudeRuns.max)
      ? value.maxClaudeRuns
      : base.maxClaudeRuns,
    maxAgyRuns: isIntegerIn(value.maxAgyRuns, maxAgyRuns.min, maxAgyRuns.max)
      ? value.maxAgyRuns
      : base.maxAgyRuns,
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
    claudeWorkerMcp: parseWorkerMcp(value.claudeWorkerMcp),
  };
}
