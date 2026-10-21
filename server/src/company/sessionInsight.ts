/**
 * Host-side checks for the session insight the OMP bridge pushes: todo phases,
 * plan mode and subagent rows. The bridge is trusted only as far as its frame
 * shape, so every field is checked here and bounded to the
 * `CompanySessionInsight` schema in core/asyncapi.yaml before it reaches state.
 */

import type {
  CompanySessionInsight,
  CompanySessionSubagent,
  CompanySessionTodo,
  CompanySessionTodoPhase,
  CompanySessionTodoTask,
} from '../../../core/src/messages.js';

const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'abandoned', 'blocked'] as const;
const SUBAGENT_STATUSES = ['pending', 'running', 'completed', 'failed', 'aborted'] as const;

// Bounds mirror the `CompanySessionInsight` schema in core/asyncapi.yaml.
const MAX_PHASES = 50;
const MAX_TASKS = 200;
const MAX_SUBAGENTS = 40;
const MAX_PHASE_NAME = 200;
const MAX_TASK_TEXT = 400;
const MAX_SUBAGENT_ID = 200;
const MAX_AGENT = 80;
const MAX_TOOL = 80;
const MAX_PLAN_MODE = 64;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** A string field clipped to `max` characters, or undefined when absent or not a string. */
function readText(source: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = source[key];
  if (typeof value !== 'string') return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

/** A finite, non-negative number within `max`, or undefined. */
function readCount(
  source: Record<string, unknown>,
  key: string,
  max = Number.POSITIVE_INFINITY,
): number | undefined {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    return undefined;
  }
  return value;
}

function readTasks(value: unknown): CompanySessionTodoTask[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tasks: CompanySessionTodoTask[] = [];
  for (const raw of value.slice(0, MAX_TASKS)) {
    if (!isObject(raw)) continue;
    const content = readText(raw, 'content', MAX_TASK_TEXT);
    const status = raw['status'];
    if (content === undefined || !isOneOf(TODO_STATUSES, status)) continue;
    const blocker = readText(raw, 'blocker', MAX_TASK_TEXT);
    tasks.push({ content, status, ...(blocker === undefined ? {} : { blocker }) });
  }
  return tasks;
}

/** A todo list in the omp shape (`{ phases: [{ name, tasks }] }`), checked and bounded. */
export function readTodo(source: Record<string, unknown>): CompanySessionTodo | undefined {
  const value = source['phases'];
  if (!Array.isArray(value)) return undefined;
  const phases: CompanySessionTodoPhase[] = [];
  for (const raw of value.slice(0, MAX_PHASES)) {
    if (!isObject(raw)) continue;
    const name = readText(raw, 'name', MAX_PHASE_NAME);
    const tasks = readTasks(raw['tasks']);
    if (name === undefined || tasks === undefined) continue;
    phases.push({ name, tasks });
  }
  return { phases };
}

function readSubagents(value: unknown): CompanySessionSubagent[] {
  if (!Array.isArray(value)) return [];
  const rows: CompanySessionSubagent[] = [];
  for (const raw of value.slice(0, MAX_SUBAGENTS)) {
    if (!isObject(raw)) continue;
    const id = readText(raw, 'id', MAX_SUBAGENT_ID);
    const agent = readText(raw, 'agent', MAX_AGENT);
    const status = raw['status'];
    const tokens = readCount(raw, 'tokens');
    const durationMs = readCount(raw, 'durationMs');
    if (
      id === undefined ||
      agent === undefined ||
      !isOneOf(SUBAGENT_STATUSES, status) ||
      tokens === undefined ||
      durationMs === undefined
    ) {
      continue;
    }
    const task = readText(raw, 'task', MAX_TASK_TEXT);
    const currentTool = readText(raw, 'currentTool', MAX_TOOL);
    const contextTokens = readCount(raw, 'contextTokens');
    const contextWindow = readCount(raw, 'contextWindow');
    const costUsd = readCount(raw, 'costUsd');
    const completionPercent = readCount(raw, 'completionPercent', 100);
    rows.push({
      id,
      agent,
      status,
      tokens,
      durationMs,
      ...(task === undefined ? {} : { task }),
      ...(currentTool === undefined ? {} : { currentTool }),
      ...(contextTokens === undefined ? {} : { contextTokens }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(completionPercent === undefined ? {} : { completionPercent }),
    });
  }
  return rows;
}

/**
 * Validates one `insight` event from the bridge into the company-state shape.
 * Returns undefined only when the frame has no plan mode; malformed todo phases
 * and subagent rows are dropped, never fatal.
 */
export function parseSessionInsight(
  event: Record<string, unknown>,
  observedAt: string,
): CompanySessionInsight | undefined {
  const planMode = readText(event, 'planMode', MAX_PLAN_MODE);
  if (planMode === undefined) return undefined;
  const todoSource = event['todo'];
  const todo = isObject(todoSource) ? readTodo(todoSource) : undefined;
  return {
    observedAt,
    ...(todo === undefined ? {} : { todo }),
    planMode,
    subagents: readSubagents(event['subagents']),
  };
}
