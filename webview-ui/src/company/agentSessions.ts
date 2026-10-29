import { AGENT_ENGINES, type AgentEngine,agentEngineForCommand, agentEngineForKind } from '../../../core/src/agentEngines.js';
import type { FleetMachineSnapshot, LedgerSession } from '../../../core/src/messages.js';

export type UnifiedAgentEngine = AgentEngine | 'unknown';
export type UnifiedAgentStatus = 'running' | 'idle' | 'ended';

export interface UnifiedAgentSession {
  readonly source: 'local' | 'cloud';
  readonly sessionId: string;
  readonly name: string;
  readonly engine: UnifiedAgentEngine;
  readonly engineLabel: string;
  readonly icon: string;
  readonly machine: string;
  readonly cwd: string;
  readonly branch: string | null;
  readonly status: UnifiedAgentStatus;
  readonly agentKind?: string;
}

export interface UnifiedAgentSessionFilter {
  readonly engine: UnifiedAgentEngine | 'all';
  readonly machine: string | 'all';
}

export function buildUnifiedAgentSessions(
  local: readonly LedgerSession[],
  machines: readonly FleetMachineSnapshot[],
): UnifiedAgentSession[] {
  const rows: UnifiedAgentSession[] = local.map((session) => {
    const engine = agentEngineForKind(session.agentKind) ?? 'unknown';
    return {
      source: 'local',
      sessionId: session.sessionId,
      name: session.agentName || session.sessionId,
      engine,
      engineLabel: engineLabel(engine, session.agentKind),
      icon: iconFor(engine),
      machine: 'local',
      cwd: session.cwd,
      branch: session.branch,
      status: session.open ? session.live ? 'running' : 'idle' : 'ended',
      agentKind: session.agentKind,
    };
  });

  for (const machine of machines) {
    for (const session of machine.tmuxSessions ?? []) {
      const engine = session.engine ?? agentEngineForCommand(session.command) ?? 'unknown';
      rows.push({
        source: 'cloud',
        sessionId: session.name,
        name: session.name,
        engine,
        engineLabel: engineLabel(engine),
        icon: iconFor(engine),
        machine: machine.agentId,
        cwd: session.cwd ?? '',
        branch: session.branch ?? null,
        status: session.idleSeconds < 60 ? 'running' : 'idle',
      });
    }
  }
  return rows;
}

export function filterUnifiedAgentSessions(
  sessions: readonly UnifiedAgentSession[],
  filter: UnifiedAgentSessionFilter,
): UnifiedAgentSession[] {
  return sessions.filter((session) =>
    (filter.engine === 'all' || session.engine === filter.engine) &&
    (filter.machine === 'all' || session.machine === filter.machine),
  );
}

function engineLabel(engine: UnifiedAgentEngine, kind?: string): string {
  if (engine === 'unknown') return kind ? `Khác · ${kind}` : 'Không rõ';
  const label = AGENT_ENGINES.find((candidate) => candidate.id === engine)?.label ?? engine;
  return kind === 'sub' ? `${label} · agent phụ` : label;
}

function iconFor(engine: UnifiedAgentEngine): string {
  return engine === 'unknown' ? '·' : AGENT_ENGINES.find((candidate) => candidate.id === engine)?.icon ?? '·';
}
