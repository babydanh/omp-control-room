import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WriteScope } from '../../core/src/company.js';
import { WorkspaceLockTable } from '../src/company/workspaceLocks.js';

let tempHome: string;
let workspace: string;

function file(p: string): WriteScope {
  return { path: p, kind: 'file', operations: ['modify'] };
}

function dir(p: string): WriteScope {
  return { path: p, kind: 'directory', operations: ['create', 'modify'] };
}

/** Case folding is pinned so the Windows rule is exercised on every runner. */
function locks(caseInsensitive: boolean): WorkspaceLockTable {
  return new WorkspaceLockTable({ workspaceRoot: workspace, caseInsensitive });
}

beforeEach(async () => {
  tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pxl-company-locks-'));
  workspace = path.join(tempHome, 'workspace');
  await fs.promises.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.promises.mkdir(path.join(workspace, 'lib'), { recursive: true });
  await fs.promises.writeFile(path.join(workspace, 'src', 'a.ts'), 'export const a = 1;\n');
  await fs.promises.writeFile(path.join(workspace, 'src', 'b.ts'), 'export const b = 2;\n');
  await fs.promises.writeFile(path.join(workspace, 'lib', 'c.ts'), 'export const c = 3;\n');
});

afterEach(async () => {
  await fs.promises.rm(tempHome, { recursive: true, force: true });
});

describe('workspace lock identity', () => {
  it('treats case-equivalent spellings of one file as the same lock on Windows', () => {
    const windows = locks(true);
    expect(windows.acquire({ ownerId: 'task-1', scopes: [file('src/a.ts')] }).granted).toBe(true);

    const blocked = windows.acquire({ ownerId: 'task-2', scopes: [file('SRC/A.TS')] });

    expect(blocked.granted).toBe(false);
    expect(blocked.granted === false && blocked.conflicts[0].ownerIds).toEqual(['task-1']);
  });

  it('keeps different files independent, including a prefix of the same name', () => {
    const table = locks(true);
    table.acquire({ ownerId: 'task-1', scopes: [file('src/a.ts')] });

    expect(table.acquire({ ownerId: 'task-2', scopes: [file('src/b.ts')] }).granted).toBe(true);
    expect(table.acquire({ ownerId: 'task-3', scopes: [file('lib/c.ts')] }).granted).toBe(true);
  });

  it('resolves a parent-directory spelling to the same file', () => {
    const table = locks(true);
    table.acquire({ ownerId: 'task-1', scopes: [file('src/a.ts')] });

    expect(table.acquire({ ownerId: 'task-2', scopes: [file('src/../src/a.ts')] }).granted).toBe(
      false,
    );
  });

  it('locks the whole workspace when a scope escapes it', () => {
    const table = locks(true);
    const escaped = table.acquire({ ownerId: 'task-1', scopes: [file('../outside/secret.ts')] });

    expect(escaped.granted).toBe(true);
    expect(escaped.granted === true && escaped.scopes[0].workspaceWide).toBe(true);

    // A task that touched anything else in the workspace now collides.
    const blocked = table.acquire({ ownerId: 'task-2', scopes: [file('lib/c.ts')] });
    expect(blocked.granted).toBe(false);
  });

  it('locks the whole workspace when a symlink points out of it', async () => {
    await fs.promises.symlink(tempHome, path.join(workspace, 'escape'), 'junction');

    const table = locks(true);
    const throughLink = table.acquire({ ownerId: 'task-1', scopes: [file('escape/a.ts')] });

    expect(throughLink.granted === true && throughLink.scopes[0].workspaceWide).toBe(true);
    expect(table.acquire({ ownerId: 'task-2', scopes: [file('src/a.ts')] }).granted).toBe(false);
  });
});

describe('scope overlap', () => {
  it('refuses a write nested inside another task directory scope', () => {
    const table = locks(true);
    table.acquire({ ownerId: 'task-1', scopes: [dir('src')] });

    expect(table.acquire({ ownerId: 'task-2', scopes: [file('src/b.ts')] }).granted).toBe(false);
  });

  it('refuses a directory scope that contains another task file scope', () => {
    const table = locks(true);
    table.acquire({ ownerId: 'task-1', scopes: [file('src/a.ts')] });

    expect(table.acquire({ ownerId: 'task-2', scopes: [dir('src')] }).granted).toBe(false);
  });

  it('refuses a sibling directory whose name starts with a held one', () => {
    const table = locks(true);
    table.acquire({ ownerId: 'task-1', scopes: [dir('src')] });

    // `src-gen` shares a prefix but is a different directory.
    expect(table.acquire({ ownerId: 'task-2', scopes: [dir('src-gen')] }).granted).toBe(true);
  });

  it('serializes a shared resource across unrelated scopes', () => {
    const table = locks(true);
    table.acquire({
      ownerId: 'task-1',
      scopes: [file('src/a.ts')],
      resources: ['package-lock.json'],
    });

    const blocked = table.acquire({
      ownerId: 'task-2',
      scopes: [file('lib/c.ts')],
      resources: ['package-lock.json'],
    });

    expect(blocked.granted).toBe(false);
    expect(blocked.granted === false && blocked.conflicts[0].kind).toBe('resource');
  });
});

describe('atomic acquisition', () => {
  it('takes nothing when one scope in the set is already held', () => {
    const table = locks(true);
    table.acquire({ ownerId: 'task-1', scopes: [file('src/b.ts')] });

    const result = table.acquire({
      ownerId: 'task-2',
      scopes: [file('lib/c.ts'), file('src/b.ts')],
    });

    expect(result.granted).toBe(false);
    // `lib/c.ts` is untouched: no partial lock survives a refused request.
    expect(table.acquire({ ownerId: 'task-3', scopes: [file('lib/c.ts')] }).granted).toBe(true);
  });

  it('lets an owner re-lock its own scope without conflicting with itself', () => {
    const table = locks(true);
    table.acquire({ ownerId: 'task-1', scopes: [file('src/a.ts')] });

    expect(table.acquire({ ownerId: 'task-1', scopes: [file('src/a.ts')] }).granted).toBe(true);

    table.release('task-1');
    expect(table.acquire({ ownerId: 'task-2', scopes: [file('src/a.ts')] }).granted).toBe(true);
  });

  it('frees every key an owner held on release', () => {
    const table = locks(true);
    table.acquire({
      ownerId: 'task-1',
      scopes: [file('src/a.ts'), file('src/b.ts')],
      resources: ['schema.prisma'],
    });

    table.release('task-1');

    expect(table.acquire({ ownerId: 'task-2', scopes: [file('src/a.ts')] }).granted).toBe(true);
    expect(
      table.acquire({ ownerId: 'task-3', scopes: [file('lib/c.ts')], resources: ['schema.prisma'] })
        .granted,
    ).toBe(true);
  });
});
