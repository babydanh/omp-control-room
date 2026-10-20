/**
 * Production wiring for {@link WorkItemService}: adapts the live herdr link and the folder's
 * coordinator to the service's ports, and keeps the herdr subscription for the service's lifetime.
 */

import { randomUUID } from 'node:crypto';
import { freemem, homedir } from 'node:os';

import type { CompanyWorkItemsMessage } from '../../../../core/src/messages.js';
import type { HerdrLink } from '../../herdr/herdrLink.js';
import type { CompanyCoordinator } from '../companyCoordinator.js';
import { loadAgentCatalog } from './agentCatalog.js';
import { listFolderRepos } from './folderRepos.js';
import { createSquadWorktree, findOnPath, runCommand } from './squadWorktree.js';
import {
  type WorkItemCatalog,
  type WorkItemRoster,
  WorkItemService,
  type WorkItemSessions,
} from './workItemService.js';
import { WorkItemFileStore } from './workItemStore.js';

/** The herdr calls work items make. The process-level link satisfies this. */
export type WorkItemHerdr = Pick<HerdrLink, 'snapshot' | 'onAgents' | 'prompt' | 'read'>;

/** Screen lines read when a pane's result is taken; enough for the last non-empty lines. */
const RESULT_SCREEN_LINES = 40;

/** The folder's coordinator calls work items make. */
export type WorkItemCoordinator = Pick<
  CompanyCoordinator,
  'snapshot' | 'submitPrompt' | 'openNewChat'
>;

export interface WorkItemWiringOptions {
  readonly workspacePath: string;
  /** The folder's company namespace directory, where its work item file lives. */
  readonly namespaceDir: string;
  /** Absent when no herdr link runs: herdr assignees are then refused, and omp sessions still work. */
  readonly herdr: WorkItemHerdr | undefined;
  readonly coordinator: WorkItemCoordinator;
  readonly publish: (message: CompanyWorkItemsMessage) => void;
}

/** A started service and the way to stop it. */
export interface WorkItemWiring {
  readonly service: WorkItemService;
  dispose(): void;
}

function rosterFor(herdr: WorkItemHerdr | undefined): WorkItemRoster {
  return {
    panes: () => {
      if (herdr === undefined) return { available: false, panes: [] };
      const roster = herdr.snapshot();
      return {
        available: roster.available,
        panes: roster.agents.map((agent) => ({
          paneId: agent.paneId,
          status: agent.status,
          ...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
        })),
      };
    },
    prompt: async (paneId, text) => {
      if (herdr === undefined) throw new Error('herdr is not linked');
      await herdr.prompt(paneId, text);
    },
    screenText: async (paneId) => {
      if (herdr === undefined) throw new Error('herdr is not linked');
      return (await herdr.read(paneId, RESULT_SCREEN_LINES)).text;
    },
  };
}

function sessionsFor(coordinator: WorkItemCoordinator): WorkItemSessions {
  return {
    list: () =>
      coordinator.snapshot().sessions.map((session) => ({
        id: session.id,
        status: session.status,
        role: session.role,
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
      })),
    submit: async (sessionId, text, mode, requestId) => {
      await coordinator.submitPrompt({
        requestId,
        text,
        delivery: 'prompt',
        targetSessionId: sessionId,
        mode,
      });
    },
    openChat: (input) => coordinator.openNewChat({ cwd: input.cwd, role: input.role }),
  };
}

/** The folder's repos and the omp agents it can use, read from disk. */
async function catalogFor(workspacePath: string): Promise<WorkItemCatalog> {
  const repos = await listFolderRepos(workspacePath);
  const agents = await loadAgentCatalog({
    homeDir: homedir(),
    folderRoot: workspacePath,
    repos,
  });
  return { repos, agents };
}

/**
 * Loads one folder's work items and starts them: the service is ready to take commands when this
 * resolves. Each herdr roster change runs a status pass.
 */
export async function startWorkItems(options: WorkItemWiringOptions): Promise<WorkItemWiring> {
  const service = new WorkItemService(options.workspacePath, {
    roster: rosterFor(options.herdr),
    sessions: sessionsFor(options.coordinator),
    persistence: new WorkItemFileStore(options.namespaceDir),
    publish: options.publish,
    now: () => Date.now(),
    newId: () => randomUUID(),
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    catalog: () => catalogFor(options.workspacePath),
    freeMemoryBytes: () => freemem(),
    worktrees: {
      create: (repo, shortId) =>
        createSquadWorktree({
          repo,
          folderRoot: options.workspacePath,
          shortId,
          gitWt: findOnPath('git-wt'),
          run: runCommand,
        }),
    },
  });
  await service.load();
  const unsubscribe = options.herdr?.onAgents(() => service.scheduleReconcile());
  return {
    service,
    dispose(): void {
      unsubscribe?.();
      service.dispose();
    },
  };
}
