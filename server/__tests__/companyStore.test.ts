import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompanyChange, CompanyEvent } from '../../core/src/company.js';

let tempHome: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof os>('os');
  return { ...actual, homedir: () => tempHome };
});
// Import after mocking os.homedir so persistence stays inside the isolated home.

const { CompanyStore } = await import('../src/company/companyStore.js');

async function findFile(directory: string, name: string): Promise<string | undefined> {
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFile(entryPath, name);
      if (nested) return nested;
    } else if (entry.name === name) {
      return entryPath;
    }
  }
  return undefined;
}

function countersEvent(sequence: number, baseRevision: number, sessionCount: number): CompanyEvent {
  const change: CompanyChange = {
    entity: 'counters',
    op: 'put',
    id: 'counters',
    value: { session: sessionCount, task: 0, contract: 0 },
  };
  return {
    id: randomUUID(),
    sequence,
    at: new Date().toISOString(),
    baseRevision,
    changes: [change],
  };
}

describe('CompanyStore', () => {
  let workspace: string;

  beforeEach(async () => {
    tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pxl-company-store-'));
    workspace = path.join(tempHome, 'workspace');
    await fs.promises.mkdir(workspace);
  });

  afterEach(async () => {
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  });

  it('replays committed events after reopening the same workspace store', async () => {
    const first = await CompanyStore.open(workspace);
    await first.load();
    await first.commit(countersEvent(1, 0, 1));

    const reopened = await CompanyStore.open(workspace);
    const state = await reopened.load();
    expect(state.revision).toBe(1);
    expect(state.counters.session).toBe(1);
  });
  it('atomically replaces the persisted snapshot after each committed event', async () => {
    const store = await CompanyStore.open(workspace);
    await store.load();
    await store.commit(countersEvent(1, 0, 1));
    await store.commit(countersEvent(2, 1, 2));

    const snapshotPath = path.join(store.namespaceDir, 'state.json');
    const persisted = JSON.parse(await fs.promises.readFile(snapshotPath, 'utf-8')) as {
      revision: number;
      counters: { session: number };
    };
    expect(persisted.revision).toBe(2);
    expect(persisted.counters.session).toBe(2);
    await expect(fs.promises.access(`${snapshotPath}.tmp`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('pages artifacts by raw-byte offset without losing UTF-8 bytes', async () => {
    const store = await CompanyStore.open(workspace);
    const content = Buffer.alloc(70_000);
    for (let i = 0; i < content.length; i += 1) content[i] = i % 251;
    const id = await store.writeArtifact(content, 'application/octet-stream');

    const first = await store.readArtifact(id, 0, 65_536);
    const second = await store.readArtifact(
      id,
      first.offset + Buffer.from(first.dataBase64, 'base64').length,
      65_536,
    );
    const reconstructed = Buffer.concat([
      Buffer.from(first.dataBase64, 'base64'),
      Buffer.from(second.dataBase64, 'base64'),
    ]);
    expect(first.totalBytes).toBe(content.length);
    expect(first.eof).toBe(false);
    expect(second.eof).toBe(true);
    expect(reconstructed.equals(content)).toBe(true);
    await expect(store.readArtifact('../config.json', 0, 64)).rejects.toMatchObject({
      code: 'invalid_artifact_id',
    });
  });

  it('retains an incomplete final journal record as a readable recovery artifact', async () => {
    const first = await CompanyStore.open(workspace);
    await first.load();
    await first.commit(countersEvent(1, 0, 1));
    const journal = await findFile(tempHome, 'events.jsonl');
    expect(journal).toBeDefined();
    const interrupted = Buffer.from('{"id":"interrupted', 'utf8');
    await fs.promises.appendFile(journal!, interrupted);

    const recovered = await CompanyStore.open(workspace);
    const state = await recovered.load();
    expect(state.revision).toBe(1);
    expect(recovered.recoveryArtifactIds).toHaveLength(1);
    const page = await recovered.readArtifact(recovered.recoveryArtifactIds[0], 0, 1024);
    expect(Buffer.from(page.dataBase64, 'base64').equals(interrupted)).toBe(true);

    await recovered.commit(countersEvent(2, 1, 2));
    expect((await recovered.load()).revision).toBe(2);
  });

  it('refuses a malformed complete journal record without resetting committed state', async () => {
    const first = await CompanyStore.open(workspace);
    await first.load();
    await first.commit(countersEvent(1, 0, 1));
    const journal = await findFile(tempHome, 'events.jsonl');
    await fs.promises.appendFile(journal!, 'not-json\n');

    const reopened = await CompanyStore.open(workspace);
    await expect(reopened.load()).rejects.toMatchObject({ code: 'company_store_corrupt' });
  });

  it('rejects nonexistent and non-directory workspace roots', async () => {
    await expect(CompanyStore.open(path.join(tempHome, 'missing'))).rejects.toMatchObject({
      code: 'invalid_workspace',
    });
    const file = path.join(tempHome, 'not-a-directory');
    await fs.promises.writeFile(file, 'x');
    await expect(CompanyStore.open(file)).rejects.toMatchObject({ code: 'invalid_workspace' });
  });
});
