/**
 * squadPlanCheck: the proposal drawer's checks on a draft, as pure rules. The warnings are the
 * shared completeness check from core/src/squadCompleteness.ts, run on the rows as the user has
 * left them, so they match what the server stores on the proposal. Warnings are advice: they never
 * block an approval. The module also names the repo, agent and area values the row shows.
 */

import type { OmpAgentInfo } from '../../../core/src/messages.js';
import {
  type CompletenessRow,
  planCompleteness,
  SQUAD_DEFAULT_AGENT,
} from '../../../core/src/squadCompleteness.js';
import type { SquadDraftRow } from './squadView.js';
import { repoShortName } from './workItemView.js';

/** The chip a repo shows when the row runs at the folder root. */
export const ROOT_REPO_LABEL = 'gốc thư mục';

/** The mark a read-only agent carries wherever its name is shown. */
export const READ_ONLY_MARK = 'chỉ đọc';

/** The name a row's agent shows as: its catalog name, or the default worker's when it names none. */
export function agentNameOf(agent: string): string {
  return agent === '' ? SQUAD_DEFAULT_AGENT : agent;
}

/** The names of the agents that change no files. */
export function readOnlyAgentNames(agents: readonly OmpAgentInfo[]): ReadonlySet<string> {
  return new Set(agents.filter((agent) => agent.readOnly).map((agent) => agent.name));
}

/** The label a catalog agent takes in a picker: its name, marked when it is read-only. */
export function agentOptionLabel(agent: OmpAgentInfo): string {
  return agent.readOnly ? `${agent.name} · ${READ_ONLY_MARK}` : agent.name;
}

/** A row's agent as the row shows it. */
export interface AgentChip {
  /** The catalog name, or the default worker's name. */
  name: string;
  readOnly: boolean;
  /** True when the row names an agent the folder's catalog no longer lists. */
  missing: boolean;
}

/** The chip for a row's agent, read against the folder's agent catalog. */
export function agentChipOf(agent: string, agents: readonly OmpAgentInfo[]): AgentChip {
  const name = agentNameOf(agent);
  const listed = agents.find((entry) => entry.name === name);
  const readOnly = listed?.readOnly === true;
  return {
    name,
    readOnly,
    missing: agent !== '' && listed === undefined,
  };
}

/** A row's repo as the row shows it: its short name, or the folder root's label. */
export function repoChipLabel(repo: string | null): string {
  return repo === null ? ROOT_REPO_LABEL : repoShortName(repo);
}

/**
 * A row's code areas as typed: split on commas, each trimmed and lowercased, with blanks and
 * repeats dropped. Every area is kept, so the approval check can count them.
 */
export function areasFromText(text: string): string[] {
  const areas: string[] = [];
  for (const part of text.split(',')) {
    const area = part.trim().toLowerCase();
    if (area !== '' && !areas.includes(area)) areas.push(area);
  }
  return areas;
}

/** A draft row as the shared completeness check reads it. */
export function completenessRowOf(row: SquadDraftRow): CompletenessRow {
  return {
    text: row.text,
    acceptance: row.acceptance,
    agent: row.agent === '' ? undefined : row.agent,
    areas: areasFromText(row.areas),
    dependsOn: row.dependsOn,
    assigneeKind: row.assignee?.kind,
  };
}

/**
 * The warnings a draft earns, in row order, from the shared completeness check. The read-only set
 * comes from the folder's agent catalog. The same rows give the same warnings the server stored.
 */
export function liveWarnings(
  rows: readonly SquadDraftRow[],
  agents: readonly OmpAgentInfo[],
): string[] {
  return planCompleteness(rows.map(completenessRowOf), readOnlyAgentNames(agents));
}
