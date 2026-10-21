/**
 * Production wiring for {@link WorkItemService}: adapts the live herdr link and the folder's
 * coordinator to the service's ports, and keeps the herdr subscription for the service's lifetime.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { freemem, homedir } from 'node:os';
import { join } from 'node:path';

import type { CompanyWorkItemsMessage, LedgerOverlapScan } from '../../../../core/src/messages.js';
import { lastAgentReply } from '../../herdr/agentReply.js';
import type { HerdrLink } from '../../herdr/herdrLink.js';
import { createAgyRuns } from '../agyCode/agyRuns.js';
import { loadClaudeAgentNames } from '../claudeCode/claudeAgents.js';
import { createClaudeAuthProbe } from '../claudeCode/claudeAuth.js';
import { createClaudeMcpSource } from '../claudeCode/claudeMcpSource.js';
import { createClaudeRuns } from '../claudeCode/claudeRuns.js';
import type { CompanyCoordinator } from '../companyCoordinator.js';
import type { LeaderRunner } from '../squad/squadRunner.js';
import { loadAgentCatalog } from './agentCatalog.js';
import { listFolderRepos } from './folderRepos.js';
import {
  createSquadWorktree,
  findOnPath,
  removeSquadWorktree,
  runCommand,
} from './squadWorktree.js';
import { squadWorkstreamKey } from './workItemScheduler.js';
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
  'snapshot' | 'submitPrompt' | 'openNewChat' | 'parkSquadSession'
>;

export interface WorkItemWiringOptions {
  readonly workspacePath: string;
  /** The folder's company namespace directory, where its work item file lives. */
  readonly namespaceDir: string;
  /** Absent when no herdr link runs: herdr assignees are then refused, and omp sessions still work. */
  readonly herdr: WorkItemHerdr | undefined;
  readonly coordinator: WorkItemCoordinator;
  readonly prepareWorktree?: (input: { readonly folder: string; readonly repo: string; readonly worktree: string }) => Promise<void>;
  readonly publish: (message: CompanyWorkItemsMessage) => void;
  /** The judge role's omp runner: one judge turn per call. */
  readonly judge: LeaderRunner;
  /** The ledger the conflict check reads overlaps from, and reports whether a board watches it. */
  readonly ledger: WorkItemLedger;
  readonly isCompactSquadProposal?: (proposalId: string) => boolean;
}

/** A started service and the way to stop it. */
export interface WorkItemWiring {
  readonly service: WorkItemService;
  dispose(): void;
}

/** The ledger the conflict check reads. A host without a ledger has no overlaps to report. */
export interface WorkItemLedger {
  overlapScans(): Promise<readonly LedgerOverlapScan[]>;
  watched(): boolean;
}

/** The ledger for a host that has none: no overlaps, and no board watching it. */
export const NO_LEDGER: WorkItemLedger = {
  overlapScans: () => Promise.resolve([]),
  watched: () => false,
};

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
          kind: agent.kind,
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
    lastReply: async (paneId) => {
      const agent = herdr?.snapshot().agents.find((entry) => entry.paneId === paneId);
      return agent === undefined ? undefined : lastAgentReply(agent);
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
    openChat: (input) =>
      coordinator.openNewChat({
        cwd: input.cwd,
        role: input.role,
        workstreamKey: input.workstreamKey,
      }),
    park: (sessionId) => coordinator.parkSquadSession(sessionId),
    wake: async (sessionId) => {
      const session = coordinator.snapshot().sessions.find((entry) => entry.id === sessionId);
      if (session?.status !== 'parked' || session.cwd === undefined) return;
      const reopened = await coordinator.openNewChat({
        cwd: session.cwd,
        role: session.role,
        workstreamKey: squadWorkstreamKey(session.role, session.cwd),
      });
      if (reopened !== sessionId) throw new Error('Phiên đã đậu chưa mở lại được.');
    },
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
  const claudeAgents = await loadClaudeAgentNames({
    homeDir: homedir(),
    folderRoot: workspacePath,
  });
  return { repos, agents, claudeAgents };
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
    prepareWorktree: options.prepareWorktree,
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
      remove: (repo, worktree) =>
        removeSquadWorktree({ repo, worktree, gitWt: findOnPath('git-wt'), run: runCommand }),
      exists: (worktree) => existsSync(worktree.path),
    },
    judge: (prompt, signal) => options.judge.run(prompt, signal),
    overlaps: () => options.ledger.overlapScans(),
    boardWatching: () => options.ledger.watched(),
    claude: createClaudeRuns({ newRunId: () => randomUUID() }),
    agy: createAgyRuns({ newRunId: () => randomUUID() }),
    claudeAuth: createClaudeAuthProbe(),
    claudeMcp: createClaudeMcpSource({ configPath: join(homedir(), '.claude.json') }),
    isCompactSquadProposal: options.isCompactSquadProposal,
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
