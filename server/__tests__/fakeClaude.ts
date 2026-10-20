import type { ClaudeCodeStatus } from '../../core/src/messages.js';
import type { ClaudeAuthProbe } from '../src/company/claudeCode/claudeAuth.js';
import type { ClaudeMcpSource } from '../src/company/claudeCode/claudeMcpSource.js';
import type {
  ClaudeRuns,
  ClaudeRunStart,
  ClaudeRunView,
} from '../src/company/claudeCode/claudeRuns.js';

/**
 * Claude Code runs a test drives by hand: the test decides when a run opens its session, shows
 * progress, and ends. No process is spawned, and no timer runs on its own.
 */
export class FakeClaudeRuns implements ClaudeRuns {
  /** Every start the service asked for, in order, with the run id it got. */
  readonly starts: { readonly runId: string; readonly input: ClaudeRunStart }[] = [];
  readonly killed: string[] = [];
  readonly forgotten: string[] = [];
  private readonly runs = new Map<string, ClaudeRunView>();
  private readonly listeners = new Set<() => void>();

  start(input: ClaudeRunStart): { readonly runId: string; readonly pid?: number } {
    const runId = `claude-run-${this.starts.length + 1}`;
    const pid = 4000 + this.starts.length + 1;
    this.runs.set(runId, {
      runId,
      state: 'running',
      sessionId: input.sessionId,
      started: false,
      pid,
    });
    this.starts.push({ runId, input });
    return { runId, pid };
  }

  view(runId: string): ClaudeRunView | undefined {
    return this.runs.get(runId);
  }

  kill(runId: string): void {
    this.killed.push(runId);
    if (this.runs.has(runId)) this.update(runId, { state: 'killed' });
  }

  forget(runId: string): void {
    this.forgotten.push(runId);
    this.runs.delete(runId);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The CLI opened its session: its first stream line arrived. */
  open(runId: string): void {
    this.update(runId, { started: true });
  }

  progress(runId: string, text: string): void {
    this.update(runId, { progress: text });
  }

  finish(runId: string, result: string): void {
    this.update(runId, { state: 'finished', result });
  }

  fail(runId: string, error: string): void {
    this.update(runId, { state: 'failed', error });
  }

  timeOut(runId: string): void {
    this.update(runId, { state: 'timeout' });
  }

  private update(runId: string, patch: Partial<ClaudeRunView>): void {
    const view = this.runs.get(runId);
    if (view === undefined) throw new Error(`no claude run ${runId}`);
    this.runs.set(runId, { ...view, ...patch });
    for (const listener of [...this.listeners]) listener();
  }
}

/** A Claude Code auth probe with a status the test sets. */
export class FakeClaudeAuth implements ClaudeAuthProbe {
  checks = 0;
  private status: ClaudeCodeStatus = { state: 'unknown' };

  set(status: ClaudeCodeStatus): void {
    this.status = status;
  }

  async check(): Promise<ClaudeCodeStatus> {
    this.checks += 1;
    return this.status;
  }

  current(): ClaudeCodeStatus {
    return this.status;
  }
}

/** Claude Code's MCP servers as a test sets them: the names the folder lists, and each run's config. */
export class FakeClaudeMcp implements ClaudeMcpSource {
  /** The server names the user's config defines, as the folder lists them. */
  servers: string[] = [];
  /** Every config a run asked for, with the project it runs in and the names it chose. */
  readonly configs: { readonly projectPath: string; readonly names: readonly string[] }[] = [];

  names(): string[] {
    return [...this.servers];
  }

  configFor(projectPath: string, names: readonly string[]): string {
    this.configs.push({ projectPath, names: [...names] });
    return JSON.stringify({ mcpServers: Object.fromEntries(names.map((name) => [name, {}])) });
  }
}
