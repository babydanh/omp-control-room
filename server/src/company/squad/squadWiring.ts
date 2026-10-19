/**
 * Production wiring for {@link SquadService}: builds the team the leader reads from the live herdr
 * link, the folder's coordinator, and the work items, and starts the service for one folder.
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import type {
  AgentRole,
  CompanySquadMessage,
  WorkItemAssignee,
  WorkItemStatus,
} from '../../../../core/src/messages.js';
import { assigneeKey, observeSessionStatus } from '../workItems/workItemModel.js';
import type { SquadMember } from './squadModel.js';
import type { LeaderRunner } from './squadRunner.js';
import { SquadService, type SquadWorkItems } from './squadService.js';
import { SquadFileStore } from './squadStore.js';

/** The herdr pane fields the team needs. A herdr agent satisfies this. */
export interface SquadAgentView {
  readonly paneId: string;
  readonly name?: string;
  readonly status: string;
  readonly cwd?: string;
  readonly title?: string;
  readonly repo?: string;
  readonly branch?: string;
  /** The folder the pane was opened in, as herdr tags it. */
  readonly workspacePath?: string;
}

/** The omp session fields the team needs. A company session satisfies this. */
export interface SquadSessionView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: string;
}

/** The herdr calls the squad makes. The process-level herdr link satisfies this. */
export interface SquadHerdr {
  snapshot(): { readonly available: boolean; readonly agents: readonly SquadAgentView[] };
}

/** The folder's coordinator calls the squad makes. */
export interface SquadCoordinator {
  snapshot(): { readonly sessions: readonly SquadSessionView[] };
}

export interface SquadWiringOptions {
  readonly workspacePath: string;
  /** The folder's company namespace directory, where its squad file lives. */
  readonly namespaceDir: string;
  /** Absent when no herdr link runs: the team then has omp sessions only. */
  readonly herdr: SquadHerdr | undefined;
  readonly coordinator: SquadCoordinator;
  readonly workItems: SquadWorkItems;
  readonly leader: LeaderRunner;
  readonly publish: (message: CompanySquadMessage) => void;
}

/** A started service and the way to stop it. */
export interface SquadWiring {
  readonly service: SquadService;
  dispose(): void;
}

/** Live work items count as queued for an agent until they finish or fail. */
const LIVE_STATUSES: readonly WorkItemStatus[] = ['queued', 'running', 'needs_input'];

/**
 * Loads one folder's squad runs and starts them: the service is ready to take commands when this
 * resolves.
 */
export async function startSquad(options: SquadWiringOptions): Promise<SquadWiring> {
  const service = new SquadService(
    { workspacePath: options.workspacePath, folderName: path.basename(options.workspacePath) },
    {
      workItems: options.workItems,
      members: () =>
        squadMembers({
          workspacePath: options.workspacePath,
          herdr: options.herdr,
          sessions: options.coordinator.snapshot().sessions,
          roles: options.workItems.snapshot().roles,
          items: options.workItems.snapshot().items,
        }),
      leader: options.leader,
      persistence: new SquadFileStore(options.namespaceDir),
      publish: options.publish,
      now: () => Date.now(),
      newId: () => randomUUID(),
    },
  );
  await service.load();
  return {
    service,
    dispose(): void {
      service.dispose();
    },
  };
}

export interface MemberSources {
  readonly workspacePath: string;
  readonly herdr: SquadHerdr | undefined;
  readonly sessions: readonly SquadSessionView[];
  readonly roles: readonly AgentRole[];
  readonly items: readonly {
    readonly assignee: WorkItemAssignee;
    readonly status: WorkItemStatus;
  }[];
}

/**
 * The folder's team as the leader sees it: herdr panes tagged with this folder, and omp sessions
 * the coordinator still reports. Each carries its role note and how many items it holds.
 */
export function squadMembers(sources: MemberSources): SquadMember[] {
  const roles = new Map(
    sources.roles.map((role): [string, string] => [assigneeKey(role.agent), role.description]),
  );
  const queued = new Map<string, number>();
  for (const item of sources.items) {
    if (!LIVE_STATUSES.includes(item.status)) continue;
    const key = assigneeKey(item.assignee);
    queued.set(key, (queued.get(key) ?? 0) + 1);
  }
  const members: SquadMember[] = [];
  const roster = sources.herdr?.snapshot();
  if (roster?.available === true) {
    for (const agent of roster.agents) {
      if (
        agent.workspacePath === undefined ||
        !samePath(agent.workspacePath, sources.workspacePath)
      )
        continue;
      const assignee = { kind: 'herdr' as const, paneId: agent.paneId };
      const ref = assigneeKey(assignee);
      members.push({
        ref,
        kind: 'herdr',
        assignee,
        label: agent.name ?? agent.paneId,
        status: agent.status,
        ...(agent.repo === undefined ? {} : { repo: agent.repo }),
        ...(agent.branch === undefined ? {} : { branch: agent.branch }),
        ...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
        ...(agent.title === undefined ? {} : { title: agent.title }),
        role: roles.get(ref) ?? '',
        queued: queued.get(ref) ?? 0,
      });
    }
  }
  for (const session of sources.sessions) {
    if (observeSessionStatus(session.status) === 'gone') continue;
    const assignee = { kind: 'session' as const, sessionId: session.id };
    const ref = assigneeKey(assignee);
    members.push({
      ref,
      kind: 'session',
      assignee,
      label: session.name === '' ? session.code : session.name,
      status: session.status,
      role: roles.get(ref) ?? '',
      queued: queued.get(ref) ?? 0,
    });
  }
  return members;
}

/** Compares two folder paths the way the board's assignee picker does: slashes and case do not matter. */
export function samePath(left: string, right: string): boolean {
  const canonicalLeft = left.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const canonicalRight = right.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return canonicalLeft === canonicalRight;
}
