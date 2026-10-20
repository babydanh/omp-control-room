import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { EventRow, SessionRow } from '../src/ledger/ledgerDb.js';
import {
  filterArchivedWorkItems,
  filterSessionRows,
  isArchivedWorkItem,
  LIBRARY_WORK_ITEM_ARCHIVE_AGE_MS,
  parseOpenVikingOutput,
  redactOpenVikingSecrets,
  resolveProofPathFromMap,
} from '../src/library/storageHelpers.js';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const oldItem = {
  id: 'old', text: 'Fix finals', status: 'done', updatedAt: new Date(NOW - LIBRARY_WORK_ITEM_ARCHIVE_AGE_MS - 1).toISOString(),
  createdAt: '2026-10-01T00:00:00.000Z', repo: '/repo/tournament', assignee: { kind: 'session', sessionId: 'sess-a' },
};

describe('library storage helpers', () => {
  it('archives finished items only after seven days and honors restoration', () => {
    expect(isArchivedWorkItem(oldItem, NOW)).toBe(true);
    expect(isArchivedWorkItem({ ...oldItem, status: 'running' }, NOW)).toBe(false);
    expect(isArchivedWorkItem({ ...oldItem, updatedAt: new Date(NOW - LIBRARY_WORK_ITEM_ARCHIVE_AGE_MS).toISOString() }, NOW)).toBe(false);
    expect(isArchivedWorkItem({ ...oldItem, restoredAt: new Date(NOW).toISOString() }, NOW)).toBe(false);
    expect(filterArchivedWorkItems([oldItem, { ...oldItem, id: 'fresh', updatedAt: new Date(NOW).toISOString() }], { query: 'finals', repo: 'tournament' }, NOW)).toEqual([oldItem]);
    expect(filterArchivedWorkItems([oldItem], { query: 'nothing' }, NOW)).toEqual([]);
    expect(filterArchivedWorkItems([oldItem], { repo: 'other' }, NOW)).toEqual([]);
  });

  it('filters sessions by kind, repo, dates and text and counts unique changed files', () => {
    const sessions: SessionRow[] = [
      { sessionId: 'a', pid: null, cwd: '/repo/league', agentKind: 'claude', agentName: 'reviewer', parentId: null, startedAt: '2026-10-15T10:00:00.000Z', lastSeen: null, endedAt: '2026-10-15T11:00:00.000Z', state: 'done', heartbeat: null },
      { sessionId: 'b', pid: null, cwd: '/repo/other', agentKind: 'agy', agentName: 'coder', parentId: null, startedAt: '2026-10-15T10:00:00.000Z', lastSeen: null, endedAt: null, state: 'busy', heartbeat: null },
    ];
    const events: EventRow[] = [
      { id: 1, ts: '2026-10-15T10:10:00.000Z', sessionId: 'a', kind: 'edit', tool: null, path: '/repo/league/a.ts', pathKey: 'a.ts', repo: '/repo/league', checkout: null, isMainCheckout: true, branch: null, intent: null },
      { id: 2, ts: '2026-10-15T10:11:00.000Z', sessionId: 'a', kind: 'write', tool: null, path: '/repo/league/a.ts', pathKey: 'a.ts', repo: '/repo/league', checkout: null, isMainCheckout: true, branch: null, intent: null },
      { id: 3, ts: '2026-10-15T10:12:00.000Z', sessionId: 'a', kind: 'edit', tool: null, path: '/repo/league/b.ts', pathKey: 'b.ts', repo: '/repo/league', checkout: null, isMainCheckout: true, branch: null, intent: null },
    ];
    const transcriptPaths = new Map([['a', '/home/user/transcripts/a.jsonl']]);
    const result = filterSessionRows(sessions, events, { agentType: 'claude', repo: 'league', from: '2026-10-15', to: '2026-10-15', query: 'reviewer' }, transcriptPaths);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ cwd: '/repo/league', editedFileCount: 2, repo: '/repo/league', transcriptPath: '/home/user/transcripts/a.jsonl' });
    expect(filterSessionRows(sessions, events, { agentType: 'agy' }, new Map())).toHaveLength(1);
    expect(filterSessionRows(sessions, events, { from: '2026-10-16' }, new Map())).toHaveLength(0);
  });

  it('parses OpenViking JSON results with URI, summary and score', () => {
    expect(parseOpenVikingOutput(JSON.stringify({ results: [{ uri: 'viking://memory/1', summary: 'A useful note', score: 0.91 }] }))).toEqual([
      { id: 'ov:0:viking://memory/1', kind: 'openViking', title: 'viking://memory/1', uri: 'viking://memory/1', description: 'A useful note', score: 0.91 },
    ]);
    expect(parseOpenVikingOutput('viking://memory/2\nA second result')).toHaveLength(2);
    expect(parseOpenVikingOutput('cmd: ov find -n 10 \"test\"\\n{\"ok\":true,\"result\":{\"memories\":[{\"uri\":\"viking://memory/2\",\"abstract\":\"From OpenViking\",\"score\":0.7}]}}')).toMatchObject([
      { uri: 'viking://memory/2', description: 'From OpenViking', score: 0.7 },
    ]);
    expect(redactOpenVikingSecrets('Authorization: Bearer abcdefghijklmnop API_KEY=secret-value ghp_abcdefghijklmnopqrstuvwxyz')).not.toContain('secret-value');
  });

  it('resolves only known proof ids beneath allowed real roots', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'library-proof-'));
    const allowed = path.join(base, 'allowed');
    const outside = path.join(base, 'outside');
    const reports = path.join(allowed, 'build', 'reports');
    await mkdir(reports, { recursive: true });
    await mkdir(outside, { recursive: true });
    const file = path.join(reports, 'proof.png');
    const secret = path.join(outside, 'secret.png');
    await writeFile(file, 'proof');
    await writeFile(secret, 'secret');
    const linkDirectory = path.join(reports, 'linked');
    await symlink(outside, linkDirectory, 'junction');
    const paths = new Map([['valid-id', file], ['traversal-id', path.join(reports, '..', '..', '..', 'outside', 'secret.png')], ['outside-id', secret], ['link-id', path.join(linkDirectory, 'secret.png')]]);
    const resolve = (candidate: string) => realpath(candidate);
    try {
      expect(await resolveProofPathFromMap('valid-id', paths, [allowed], resolve)).toBe(await resolve(file));
      await expect(resolveProofPathFromMap('..', paths, [allowed], resolve)).rejects.toThrow();
      await expect(resolveProofPathFromMap('traversal-id', paths, [allowed], resolve)).rejects.toThrow();
      await expect(resolveProofPathFromMap('outside-id', paths, [allowed], resolve)).rejects.toThrow();
      await expect(resolveProofPathFromMap('link-id', paths, [allowed], resolve)).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
