import type { AgyRuns, AgyRunStart, AgyRunView } from '../src/company/agyCode/agyRuns.js';

export class FakeAgyRuns implements AgyRuns {
  readonly starts: { readonly runId: string; readonly input: AgyRunStart }[] = [];
  readonly killed: string[] = [];
  readonly forgotten: string[] = [];
  private readonly runs = new Map<string, AgyRunView>();
  private readonly listeners = new Set<() => void>();

  start(input: AgyRunStart): { readonly runId: string; readonly pid?: number } {
    const runId = `agy-run-${this.starts.length + 1}`;
    const pid = 5000 + this.starts.length + 1;
    this.runs.set(runId, { runId, state: 'running', started: false, pid });
    this.starts.push({ runId, input });
    return { runId, pid };
  }

  view(runId: string): AgyRunView | undefined {
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
    return () => this.listeners.delete(listener);
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

  private update(runId: string, patch: Partial<AgyRunView>): void {
    const view = this.runs.get(runId);
    if (view === undefined) throw new Error(`no agy run ${runId}`);
    this.runs.set(runId, { ...view, ...patch });
    for (const listener of [...this.listeners]) listener();
  }
}
