import type {
  FleetMachineSnapshot,
  FleetOverlapWarning,
  FleetSnapshotMessage,
  LedgerView,
} from '../../../core/src/messages.js';
import { FLEET_STALE_AFTER_MS } from './constants.js';
import type { FleetHubMachine, FleetHubResponse } from './hubClient.js';

export type FleetMachineState = FleetMachineSnapshot['state'];

export interface FleetLocalRepo {
  readonly repo: string;
  readonly dirtyFiles: readonly string[];
}

export function classifyFleetMachineState(receivedAt: number, nowMs: number): FleetMachineState {
  return nowMs - receivedAt > FLEET_STALE_AFTER_MS ? 'stale' : 'online';
}

export function computeFleetOverlaps(
  machines: readonly FleetHubMachine[],
  localRepos: readonly FleetLocalRepo[],
): FleetOverlapWarning[] {
  const entries = new Map<string, { repo: string; path: string; machines: Set<string>; local: boolean }>();

  for (const machine of machines) {
    for (const repo of machine.repos) {
      const repoName = repositoryName(repo.path);
      if (repoName === '') continue;
      for (const file of repo.dirty_files) {
        const normalizedFile = normalizeRelativePath(file);
        if (normalizedFile === '') continue;
        const key = overlapKey(repoName, normalizedFile);
        let entry = entries.get(key);
        if (entry === undefined) {
          entry = { repo: repoName, path: normalizedFile, machines: new Set(), local: false };
          entries.set(key, entry);
        }
        entry.machines.add(machine.agent_id);
      }
    }
  }

  for (const repo of localRepos) {
    const repoName = repositoryName(repo.repo);
    if (repoName === '') continue;
    for (const file of repo.dirtyFiles) {
      const entry = entries.get(overlapKey(repoName, normalizeRelativePath(file)));
      if (entry !== undefined) entry.local = true;
    }
  }

  return [...entries.values()]
    .filter((entry) => entry.machines.size >= 2 || (entry.machines.size > 0 && entry.local))
    .map((entry) => ({
      repo: entry.repo,
      path: entry.path,
      machines: [...entry.machines].sort(),
      local: entry.local,
    }))
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path));
}

export function buildFleetSnapshot(
  requestId: string,
  response: FleetHubResponse,
  localView: LedgerView | null,
): FleetSnapshotMessage {
  const localRepos =
    localView?.repos.flatMap((repo) =>
      repo.worktrees.map((worktree) => ({
        repo: repo.repo,
        dirtyFiles: worktree.dirtyFiles.map((file) => file.path),
      })),
    ) ?? [];

  return {
    type: 'fleetSnapshot',
    requestId,
    machines: response.machines.map(
      (machine): FleetMachineSnapshot => ({
        agentId: machine.agent_id,
        receivedAt: machine.received_at,
        state: classifyFleetMachineState(machine.received_at, response.now),
        sessionCount: machine.sessions.length,
        engines: [...new Set(machine.sessions.map((session) => session.engine))].sort(),
        repos: machine.repos.map((repo) => ({
          name: repositoryName(repo.path),
          branch: repo.branch,
          ahead: repo.ahead,
          behind: repo.behind,
          dirtyCount: repo.dirty_files.length,
        })),
      }),
    ),
    overlaps: computeFleetOverlaps(response.machines, localRepos),
  };
}

function repositoryName(path: string): string {
  const parts = path.trim().replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean);
  const parent = parts.at(-2);
  if (parent?.toLowerCase() === '.worktrees' && parts.length >= 3) return parts.at(-3) ?? '';
  if (parent?.toLowerCase().endsWith('.worktrees')) return parent.slice(0, -'.worktrees'.length);
  const name = parts.at(-1) ?? '';
  return name.toLowerCase().endsWith('.worktrees') ? name.slice(0, -'.worktrees'.length) : name;
}

function normalizeRelativePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^(?:\.\/)+/, '');
}

function overlapKey(repo: string, file: string): string {
  return `${repo.toLowerCase()}\u0000${file.toLowerCase()}`;
}
