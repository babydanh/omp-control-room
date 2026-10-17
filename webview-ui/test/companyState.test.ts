import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { CompanyStateChangedMessage, ServerMessage } from '../../core/src/messages.js';
import { decodeArtifact, describeFileContent } from '../src/company/artifactView.js';
import { applyCompanyMessage, emptyCompanyState, usageKey } from '../src/company/companyState.js';
import {
  attempt,
  catalogEntry,
  evidence,
  settings,
  stateFrom,
  task,
  usageRecord,
} from './companyFixtures.js';

function changeMessage(
  revision: number,
  changes: CompanyStateChangedMessage['changes'],
): ServerMessage {
  return { type: 'companyStateChanged', revision, changes };
}

describe('revision discipline', () => {
  it('applies the very next revision', () => {
    const base = stateFrom({ revision: 7 });
    const placed = task({ code: 'PA-T0009', status: 'running' });

    const result = applyCompanyMessage(
      base,
      changeMessage(8, [{ entity: 'task', op: 'put', id: placed.id, value: placed }]),
    );

    expect(result.state.tasks[placed.id].status).toBe('running');
    expect(result.state.revision).toBe(8);
    expect(result.effects).toEqual([]);
  });

  it('asks for a snapshot when a revision was missed, and stops applying until it arrives', () => {
    const base = stateFrom({ revision: 7 });

    const gap = applyCompanyMessage(base, changeMessage(9, []));
    expect(gap.state.needsSnapshot).toBe(true);
    expect(gap.effects).toEqual([{ type: 'requestSnapshot' }]);

    // A later revision while the gap is open cannot repair it: it is applied to
    // a baseline that is already missing something.
    const later = task({ code: 'PA-T0010' });
    const whileOpen = applyCompanyMessage(
      gap.state,
      changeMessage(10, [{ entity: 'task', op: 'put', id: later.id, value: later }]),
    );
    expect(whileOpen.state.tasks[later.id]).toBeUndefined();
    expect(whileOpen.state.revision).toBe(7);
  });

  it('drops a change it already applied instead of replaying it', () => {
    const base = stateFrom({ revision: 7 });
    const replay = applyCompanyMessage(base, changeMessage(7, []));

    expect(replay.state).toBe(base);
    expect(replay.effects).toEqual([]);
  });

  it('cannot apply a change with no baseline at all', () => {
    const result = applyCompanyMessage(emptyCompanyState(), changeMessage(3, []));

    expect(result.state.needsSnapshot).toBe(true);
    expect(result.effects).toEqual([{ type: 'requestSnapshot' }]);
    expect(result.state.revision).toBeNull();
  });

  it('a snapshot closes the gap and replaces the collections it enumerates', () => {
    const stale = task({ code: 'PA-T0001', status: 'planned' });
    const base = stateFrom({ revision: 4, tasks: [stale] });
    const gapped = applyCompanyMessage(base, changeMessage(9, [])).state;

    const fresh = task({ code: 'PA-T0002', status: 'done' });
    const resynced = applyCompanyMessage(gapped, {
      type: 'companySnapshot',
      requestId: randomUUID(),
      snapshot: {
        revision: 12,
        settings: settings(),
        prompts: [],
        contracts: [],
        tasks: [fresh],
        sessions: [],
        questions: [],
        quotas: [],
      },
    });

    expect(resynced.state.needsSnapshot).toBe(false);
    expect(resynced.state.revision).toBe(12);
    expect(Object.keys(resynced.state.tasks)).toEqual([fresh.id]);
  });
});

describe('incremental collections', () => {
  it('keeps evidence and reports across a snapshot, because they only arrive on change', () => {
    const record = evidence();
    const base = stateFrom({ revision: 3 });
    const withEvidence = applyCompanyMessage(base, {
      type: 'companyStateChanged',
      revision: 4,
      changes: [{ entity: 'evidence', op: 'put', id: record.id, value: record }],
    }).state;

    const afterSnapshot = applyCompanyMessage(withEvidence, {
      type: 'companySnapshot',
      requestId: randomUUID(),
      snapshot: {
        revision: 20,
        settings: settings(),
        prompts: [],
        contracts: [],
        tasks: [],
        sessions: [],
        questions: [],
        quotas: [],
      },
    }).state;

    expect(afterSnapshot.evidence[record.id]).toEqual(record);
  });

  it('removes a task the server deleted', () => {
    const placed = task({ code: 'PA-T0001' });
    const base = stateFrom({ revision: 1, tasks: [placed] });

    const removed = applyCompanyMessage(
      base,
      changeMessage(2, [{ entity: 'task', op: 'remove', id: placed.id }]),
    );

    expect(removed.state.tasks[placed.id]).toBeUndefined();
    expect(removed.state.revision).toBe(2);
  });

  it('counts a re-sent usage entry once', () => {
    const record = usageRecord({ nativeSessionId: 'native-1', nativeEntryId: 'entry-7' });
    const other = usageRecord({ nativeSessionId: 'native-1', nativeEntryId: 'entry-8' });
    const base = stateFrom({ revision: 1 });

    const put = changeMessage(2, [
      { entity: 'usage', op: 'put', id: usageKey(record), value: record },
      { entity: 'usage', op: 'put', id: usageKey(other), value: other },
    ]);
    const afterFirst = applyCompanyMessage(base, put).state;

    // The same native entry arrives again (a rescan of the same session file).
    const afterReplay = applyCompanyMessage(
      afterFirst,
      changeMessage(3, [{ entity: 'usage', op: 'put', id: usageKey(record), value: record }]),
    ).state;

    expect(Object.keys(afterReplay.usage)).toEqual([usageKey(record), usageKey(other)]);
  });
});

describe('live output', () => {
  it('keeps the newest public text and exposes a bounded excerpt', () => {
    const base = stateFrom({ revision: 1 });
    const stream = (seq: number, text: string): ServerMessage => ({
      type: 'companyTextDelta',
      sessionId: 'session-1',
      runEpoch: 2,
      seq,
      text,
    });

    const first = applyCompanyMessage(base, stream(1, 'Building the board now'));
    const second = applyCompanyMessage(first.state, stream(2, ' and the drawer'));
    const stale = applyCompanyMessage(second.state, stream(1, 'ignored'));

    expect(second.state.streams['session-1'].excerpt).toBe('Building the board now and the drawer');
    expect(stale.state.streams['session-1'].seq).toBe(2);
  });

  it('starts a fresh tail when a session restarts on a new epoch', () => {
    const base = stateFrom({ revision: 1 });
    const first = applyCompanyMessage(base, {
      type: 'companyTextDelta',
      sessionId: 'session-1',
      runEpoch: 1,
      seq: 5,
      text: 'old run',
    }).state;

    const restarted = applyCompanyMessage(first, {
      type: 'companyTextDelta',
      sessionId: 'session-1',
      runEpoch: 2,
      seq: 1,
      text: 'new run',
    }).state;

    expect(restarted.streams['session-1'].excerpt).toBe('new run');
  });

  it('paints terminal frames once, in sequence, and ignores a stale epoch', () => {
    const base = stateFrom({ revision: 1 });
    const attached = applyCompanyMessage(base, {
      type: 'terminalAttached',
      requestId: randomUUID(),
      sessionId: 'session-1',
      runEpoch: 4,
      leaseId: 'lease-1',
      cols: 120,
      rows: 32,
    }).state;

    const first = applyCompanyMessage(attached, {
      type: 'terminalData',
      sessionId: 'session-1',
      runEpoch: 4,
      seq: 1,
      data: 'aGk=',
    }).state;
    const stale = applyCompanyMessage(first, {
      type: 'terminalData',
      sessionId: 'session-1',
      runEpoch: 4,
      seq: 1,
      data: 'bm8=',
    }).state;
    const wrongEpoch = applyCompanyMessage(stale, {
      type: 'terminalData',
      sessionId: 'session-1',
      runEpoch: 3,
      seq: 9,
      data: 'bm8=',
    }).state;

    expect(wrongEpoch.terminals['session-1'].frames).toEqual([
      { seq: 1, kind: 'data', data: 'aGk=' },
    ]);
  });

  it('lets a fresh snapshot replace the screen instead of stacking on it', () => {
    const base = applyCompanyMessage(stateFrom({ revision: 1 }), {
      type: 'terminalData',
      sessionId: 'session-1',
      runEpoch: 1,
      seq: 1,
      data: 'aGk=',
    }).state;

    const snapshot = applyCompanyMessage(base, {
      type: 'terminalSnapshot',
      sessionId: 'session-1',
      runEpoch: 1,
      seq: 2,
      data: 'ZnVsbA==',
    }).state;

    expect(snapshot.terminals['session-1'].frames).toEqual([
      { seq: 2, kind: 'snapshot', data: 'ZnVsbA==' },
    ]);
  });
});

describe('paged content', () => {
  it('keeps one copy of an artifact page that is requested twice', () => {
    const base = stateFrom({ revision: 1 });
    const page = {
      id: 'artifact-1',
      offset: 0,
      totalBytes: 4,
      dataBase64: 'aGk=',
      contentType: 'text/plain',
      eof: true,
    };

    const once = applyCompanyMessage(base, {
      type: 'companyArtifactPage',
      requestId: randomUUID(),
      page,
    }).state;
    const twice = applyCompanyMessage(once, {
      type: 'companyArtifactPage',
      requestId: randomUUID(),
      page,
    }).state;

    expect(twice.artifacts['artifact-1'].pages).toHaveLength(1);
  });

  it('decodes an artifact whose UTF-8 sequence straddles a page boundary', () => {
    // "e" + the first two bytes of "ü", then the last byte alone.
    const first = applyCompanyMessage(stateFrom({ revision: 1 }), {
      type: 'companyArtifactPage',
      requestId: randomUUID(),
      page: {
        id: 'artifact-1',
        offset: 0,
        totalBytes: 3,
        dataBase64: Buffer.from(new Uint8Array([0x65, 0xc3])).toString('base64'),
        contentType: 'text/plain',
        eof: false,
      },
    }).state;
    const complete = applyCompanyMessage(first, {
      type: 'companyArtifactPage',
      requestId: randomUUID(),
      page: {
        id: 'artifact-1',
        offset: 2,
        totalBytes: 3,
        dataBase64: Buffer.from(new Uint8Array([0xbc])).toString('base64'),
        contentType: 'text/plain',
        eof: true,
      },
    }).state;

    const artifact = complete.artifacts['artifact-1'];
    expect(artifact.pages).toHaveLength(2);
    // The bytes are streamed across the page boundary, so the character that
    // straddles it survives instead of becoming a replacement glyph.
    expect(decodeArtifact(artifact, 1024).text).toBe('eü');
  });

  it('describes a binary page as binary, and a truncated text page as more to come', () => {
    expect(
      describeFileContent({
        path: 'logo.png',
        totalBytes: 900,
        offset: 0,
        encoding: 'base64',
        dataBase64: 'AAEC',
        mediaType: 'image/png',
        truncated: true,
      }),
    ).toEqual({
      kind: 'binary',
      text: '',
      byteLength: 3,
      offset: 0,
      totalBytes: 900,
      mediaType: 'image/png',
      nextOffset: 3,
    });

    expect(
      describeFileContent({
        path: 'README.md',
        totalBytes: 5,
        offset: 0,
        encoding: 'utf8',
        text: 'hello',
        mediaType: 'text/markdown',
        truncated: false,
      }),
    ).toMatchObject({ kind: 'text', text: 'hello', nextOffset: null });
  });
});

describe('model catalog', () => {
  it('is replaced wholesale by the server answer', () => {
    const base = stateFrom({ revision: 1 });
    const updated = applyCompanyMessage(base, {
      type: 'companyModelCatalog',
      requestId: randomUUID(),
      entries: [catalogEntry({ acceptsImages: true })],
    });

    expect(updated.state.modelCatalog).toHaveLength(1);
    expect(updated.state.modelCatalog[0].acceptsImages).toBe(true);
  });
});

describe('attempts and evidence', () => {
  it('records an attempt put without touching the task that references it', () => {
    const record = attempt({ status: 'failed', error: 'exit 1' });
    const base = stateFrom({ revision: 1 });

    const result = applyCompanyMessage(
      base,
      changeMessage(2, [{ entity: 'attempt', op: 'put', id: record.id, value: record }]),
    );

    expect(result.state.attempts[record.id].status).toBe('failed');
  });
});