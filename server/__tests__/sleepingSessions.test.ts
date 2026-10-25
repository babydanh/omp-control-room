import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closedSleepId,
  judgeSleepRecords,
  type PaneFact,
  parseSleepRegistry,
  sessionTitleFromHead,
  type SleepRecord,
  SleepRegistry,
} from '../src/herdr/sleepingSessions.js';

const UUID = '1f2e3d4c-5b6a-4978-8a9b-000087572576';
const SID8 = '87572576';
const OTHER_SID8 = '1b06e7a4';
const SESSION_FILE = `C:/omp/sessions/2026-01-01T00-00-00_${UUID}.jsonl`;
const CWD = 'V:\\Duancanhan\\Project_QuanLyGiaiDau';
const SLEPT_AT = '2026-01-01T00:00:00.000Z';

function sleepRecord(overrides: Partial<SleepRecord> = {}): SleepRecord {
  return {
    pane: 'wD:p4',
    terminal: 'term_slept',
    file: SESSION_FILE,
    cwd: CWD,
    phase: 'sleeping',
    requestedAt: SLEPT_AT,
    agent: 'omp',
    fresh: false,
    closed: false,
    ...overrides,
  };
}

function paneFact(overrides: Partial<PaneFact> = {}): PaneFact {
  return {
    paneId: 'wD:p4',
    workspaceId: 'wD',
    terminalId: 'term_slept',
    cwd: CWD,
    label: `zz omp: ATH: Refactor modal #${SID8}`,
    ...overrides,
  };
}

/** The status of each record's verdict, or the reason it was dropped. */
function verdicts(records: SleepRecord[], panes: PaneFact[]): string[] {
  return judgeSleepRecords(records, panes).map((verdict) =>
    verdict.status === 'dropped' ? verdict.reason : verdict.status,
  );
}

/** The JSON shape omp-ngu.ts writes for a record. */
function registryEntry(record: SleepRecord): Record<string, string> {
  return {
    pane: record.pane,
    terminal: record.terminal,
    file: record.file,
    cwd: record.cwd,
    phase: record.phase,
    ts: record.requestedAt,
  };
}

describe('judgeSleepRecords', () => {
  it('stands a sleeping record whose pane still names its session', () => {
    const [verdict] = judgeSleepRecords([sleepRecord()], [paneFact()]);

    expect(verdict).toEqual({
      status: 'sleeping',
      paneId: 'wD:p4',
      sessionFile: SESSION_FILE,
      sleptAt: SLEPT_AT,
      cwd: CWD,
      workspaceId: 'wD',
      labelTitle: 'ATH: Refactor modal',
    });
  });

  it('drops a record whose session is still exiting', () => {
    expect(verdicts([sleepRecord({ phase: 'exit-requested' })], [paneFact()])).toEqual([
      'exit-requested',
    ]);
  });

  it('drops a record whose pane has closed', () => {
    expect(verdicts([sleepRecord()], [])).toEqual(['pane-closed']);
  });

  it('drops a record whose pane now runs an agent', () => {
    expect(verdicts([sleepRecord()], [paneFact({ agent: 'omp' })])).toEqual(['awake']);
  });

  it('drops a record whose pane carries a different session label', () => {
    const label = `zz omp: BOUNCE: Find bounce model #${OTHER_SID8}`;

    expect(verdicts([sleepRecord()], [paneFact({ label })])).toEqual(['pane-changed']);
  });

  it('drops a record whose pane was renamed and whose terminal changed', () => {
    expect(
      verdicts([sleepRecord()], [paneFact({ label: 'my shell', terminalId: 'term_other' })]),
    ).toEqual(['pane-changed']);
  });

  it('stands a renamed pane that still holds the slept terminal, without a label title', () => {
    const [verdict] = judgeSleepRecords([sleepRecord()], [paneFact({ label: 'my shell' })]);

    expect(verdict).toMatchObject({ status: 'sleeping', paneId: 'wD:p4' });
    expect(verdict).not.toHaveProperty('labelTitle');
  });

  it('drops a session that another pane has open', () => {
    const other = paneFact({
      paneId: 'wF:p2',
      label: undefined,
      agent: 'omp',
      sessionFile: SESSION_FILE,
    });

    expect(verdicts([sleepRecord()], [paneFact(), other])).toEqual(['open-elsewhere']);
  });

  it('keeps only the last record for a pane as live', () => {
    const older = sleepRecord({
      file: 'C:/omp/sessions/old_00000000-0000-4000-8000-000000000001.jsonl',
    });

    expect(verdicts([older, sleepRecord()], [paneFact()])).toEqual(['superseded', 'sleeping']);
  });

  it('keeps only the last record for a session file as live', () => {
    expect(verdicts([sleepRecord({ pane: 'wE:p1' }), sleepRecord()], [paneFact()])).toEqual([
      'superseded',
      'sleeping',
    ]);
  });
});

describe('judgeSleepRecords for a session whose pane the sleep closed', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.parse(SLEPT_AT) + DAY;
  const closed = (overrides: Partial<SleepRecord> = {}): SleepRecord =>
    sleepRecord({ closed: true, workspace: 'wD', title: 'ATH: Refactor modal', ...overrides });

  it('stands with no pane, under an id of its own, carrying how to reopen it', () => {
    const [verdict] = judgeSleepRecords([closed()], [], NOW);

    expect(verdict).toEqual({
      status: 'sleeping',
      paneId: closedSleepId(UUID),
      sessionFile: SESSION_FILE,
      sleptAt: SLEPT_AT,
      cwd: CWD,
      workspaceId: 'wD',
      labelTitle: 'ATH: Refactor modal',
      closed: { agent: 'omp', file: SESSION_FILE, fresh: false, cwd: CWD, workspaceId: 'wD' },
    });
  });

  it('drops once any pane has the session open again', () => {
    const woken = paneFact({ paneId: 'wA:p9', label: undefined, agent: 'omp', sessionFile: SESSION_FILE });

    expect(judgeSleepRecords([closed()], [woken], NOW).map((v) => v.status === 'dropped' && v.reason)).toEqual(['awake']);
  });

  it('drops after seven days asleep', () => {
    const later = Date.parse(SLEPT_AT) + 7 * DAY + 1;

    expect(judgeSleepRecords([closed()], [], later).map((v) => v.status === 'dropped' && v.reason)).toEqual(['expired']);
  });

  it('claims no pane id: a later sleep in a pane herdr gave the same id still stands', () => {
    const otherFile = 'C:/omp/sessions/new_00000000-0000-4000-8000-0000000000aa.jsonl';
    const keptPane = sleepRecord({ file: otherFile, terminal: 'term_new' });
    const pane = paneFact({ terminalId: 'term_new', label: undefined });

    expect(judgeSleepRecords([closed(), keptPane], [pane], NOW).map((v) => v.status)).toEqual([
      'sleeping',
      'sleeping',
    ]);
  });

  it('names its board id from the whole session key, in the pane id shape, distinct for ids that end alike', () => {
    const a = closedSleepId('d0c9a1b2-1111-4222-8333-abcdef012345');
    const b = closedSleepId('ffffffff-1111-4222-8333-abcdef012345');

    expect(a).toMatch(/^zz:[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    expect(closedSleepId('C:/x/y.z')).toMatch(/^zz:[0-9a-f]{16}$/);
  });
});

describe('parseSleepRegistry', () => {
  it('reads invalid JSON as no records and reports it', () => {
    const parsed = parseSleepRegistry('{nope');

    expect(parsed.records).toEqual([]);
    expect(parsed.problem).toMatch(/not valid JSON/);
  });

  it('reads a registry that is not an array as no records and reports it', () => {
    const parsed = parseSleepRegistry('{}');

    expect(parsed.records).toEqual([]);
    expect(parsed.problem).toMatch(/not a JSON array/);
  });

  it('skips unusable entries, keeps the usable ones, and reports the count', () => {
    const valid = {
      pane: 'wD:p4',
      terminal: 'term_slept',
      file: SESSION_FILE,
      cwd: CWD,
      phase: 'sleeping',
      ts: '2026-01-01T00:00:00Z',
    };
    const text = JSON.stringify([
      valid,
      { ...valid, pane: 'not a pane' },
      { ...valid, phase: 'weird' },
      { ...valid, ts: 'nope' },
    ]);

    const parsed = parseSleepRegistry(text);

    expect(parsed.records).toEqual([
      {
        pane: 'wD:p4',
        terminal: 'term_slept',
        file: SESSION_FILE,
        cwd: CWD,
        phase: 'sleeping',
        requestedAt: SLEPT_AT,
        agent: 'omp',
        fresh: false,
        closed: false,
      },
    ]);
    expect(parsed.problem).toBe('Sleep registry: skipped 3 unusable entries.');
  });

  it('reads what a deep sleep adds: agent, empty session, closed pane, task and workspace', () => {
    const entry = {
      agent: 'claude', pane: 'wA:p7', terminal: 't', file: 'abc', cwd: CWD, phase: 'sleeping',
      ts: '2026-01-01T00:00:00Z', fresh: true, closed: true, title: 'Sửa modal', workspace: 'wA',
    };

    expect(parseSleepRegistry(JSON.stringify([entry])).records[0]).toMatchObject({
      agent: 'claude', fresh: true, closed: true, title: 'Sửa modal', workspace: 'wA',
    });
  });
});

describe('sessionTitleFromHead', () => {
  const userPrompt = '{"type":"message","message":{"role":"user","content":"Sửa lỗi modal"}}';

  it('uses the title line over the first user prompt', () => {
    const head = [userPrompt, '{"type":"title","title":"Refactor modal"}'].join('\n');

    expect(sessionTitleFromHead(head)).toBe('Refactor modal');
  });

  it('falls back to the first user prompt when there is no title line', () => {
    expect(sessionTitleFromHead(userPrompt)).toBe('Sửa lỗi modal');
  });

  it('skips a line cut off at the end of the head', () => {
    const head = '{"type":"title","title":"Refactor modal"}\n{"type":"mes';

    expect(sessionTitleFromHead(head)).toBe('Refactor modal');
  });

  it('drops characters outside the title alphabet and collapses spaces', () => {
    const head = '{"type":"title","title":"  Refactor   <modal>!  "}';

    expect(sessionTitleFromHead(head)).toBe('Refactor modal');
  });

  it('treats a title shorter than three characters as absent', () => {
    const head = [userPrompt, '{"type":"title","title":"ab"}'].join('\n');

    expect(sessionTitleFromHead(head)).toBe('Sửa lỗi modal');
  });
});

describe('SleepRegistry', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sleeping-sessions-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('lists nothing when the registry file is missing, without a warning', async () => {
    const warn = vi.fn();
    const registry = new SleepRegistry({ file: path.join(dir, 'omp-ngu.json'), warn });

    expect(await registry.sleepingSessions([paneFact()])).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once for an unreadable registry and lists nothing', async () => {
    const file = path.join(dir, 'omp-ngu.json');
    await fs.writeFile(file, '{broken');
    const warn = vi.fn();
    const registry = new SleepRegistry({ file, warn });

    expect(await registry.sleepingSessions([paneFact()])).toEqual([]);
    expect(await registry.sleepingSessions([paneFact()])).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('titles a session from its file, and prefers the pane label when there is one', async () => {
    const sessionFile = path.join(dir, `2026-01-01_${UUID}.jsonl`);
    await fs.writeFile(sessionFile, '{"type":"title","title":"Refactor modal"}\n');
    const file = path.join(dir, 'omp-ngu.json');
    await fs.writeFile(file, JSON.stringify([registryEntry(sleepRecord({ file: sessionFile }))]));
    const registry = new SleepRegistry({ file, warn: vi.fn() });

    const [unlabelled] = await registry.sleepingSessions([paneFact({ label: undefined })]);
    expect(unlabelled?.title).toBe('Refactor modal');

    const [labelled] = await registry.sleepingSessions([paneFact()]);
    expect(labelled?.title).toBe('ATH: Refactor modal');
  });

  it('falls back to the file name when the session file cannot be read', async () => {
    const sessionFile = path.join(dir, `2026-01-01_${UUID}.jsonl`);
    const file = path.join(dir, 'omp-ngu.json');
    await fs.writeFile(file, JSON.stringify([registryEntry(sleepRecord({ file: sessionFile }))]));
    const registry = new SleepRegistry({ file, warn: vi.fn() });

    const [session] = await registry.sleepingSessions([paneFact({ label: undefined })]);

    expect(session?.title).toBe(`2026-01-01_${UUID}`);
  });

  it('lists the most recently slept session first', async () => {
    const earlier = sleepRecord({
      pane: 'wD:p4',
      terminal: 'term_a',
      file: 'C:/omp/sessions/a.jsonl',
      requestedAt: '2026-01-01T00:00:00.000Z',
    });
    const later = sleepRecord({
      pane: 'wF:p2',
      terminal: 'term_b',
      file: 'C:/omp/sessions/b.jsonl',
      requestedAt: '2026-01-02T00:00:00.000Z',
    });
    const file = path.join(dir, 'omp-ngu.json');
    await fs.writeFile(file, JSON.stringify([registryEntry(earlier), registryEntry(later)]));
    const registry = new SleepRegistry({ file, warn: vi.fn() });

    const sessions = await registry.sleepingSessions([
      paneFact({ paneId: 'wD:p4', terminalId: 'term_a', label: undefined }),
      paneFact({ paneId: 'wF:p2', terminalId: 'term_b', label: undefined }),
    ]);

    expect(sessions.map((session) => session.paneId)).toEqual(['wF:p2', 'wD:p4']);
  });
});
