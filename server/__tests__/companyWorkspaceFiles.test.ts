import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempHome: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof os>('os');
  return { ...actual, homedir: () => tempHome };
});

const { CompanyStore } = await import('../src/company/companyStore.js');
const { listWorkspaceFiles, readWorkspaceFile } = await import('../src/company/workspaceFiles.js');

describe('workspace file access', () => {
  let workspace: string;

  beforeEach(async () => {
    tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pxl-company-files-'));
    workspace = path.join(tempHome, 'workspace');
    await fs.promises.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.promises.mkdir(path.join(workspace, '.git'), { recursive: true });
    await fs.promises.mkdir(path.join(workspace, 'node_modules'), { recursive: true });
    await fs.promises.writeFile(path.join(workspace, 'README.md'), '# hello\nworld\n');
    await fs.promises.writeFile(path.join(workspace, 'src', 'index.ts'), 'export const a = 1;\n');
    await fs.promises.writeFile(path.join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.promises.writeFile(path.join(workspace, 'node_modules', 'big.js'), 'x'.repeat(1000));
  });

  afterEach(async () => {
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  });

  it('lists workspace entries without noise directories', async () => {
    const entries = await listWorkspaceFiles(workspace, '');

    expect(entries.map((entry) => `${entry.kind}:${entry.name}`).sort()).toEqual([
      'directory:src',
      'file:README.md',
    ]);
    expect(entries.find((entry) => entry.name === 'src')?.kind).toBe('directory');
    expect(entries.find((entry) => entry.name === 'README.md')?.sizeBytes).toBe(14);
  });

  it('refuses paths that escape the workspace', async () => {
    await expect(listWorkspaceFiles(workspace, '../..')).rejects.toMatchObject({
      code: 'path_outside_workspace',
    });
    await expect(listWorkspaceFiles(workspace, 'src/../../..')).rejects.toMatchObject({
      code: 'path_outside_workspace',
    });
    await expect(
      readWorkspaceFile(workspace, path.join('..', 'outside.txt'), 0, 1024),
    ).rejects.toMatchObject({ code: 'path_outside_workspace' });
  });

  it('reads text as utf8 and marks a truncated page', async () => {
    const full = await readWorkspaceFile(workspace, 'README.md', 0, 1024);
    expect(full.encoding).toBe('utf8');
    expect(full.truncated).toBe(false);
    expect(full.text).toBe('# hello\nworld\n');

    const partial = await readWorkspaceFile(workspace, 'README.md', 0, 5);
    expect(partial.truncated).toBe(true);
    expect(partial.text).toBe('# hel');
    expect(partial.totalBytes).toBe(14);
    expect(partial.offset).toBe(0);
  });

  it('reads binary content as base64 without corrupting bytes', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
    const name = `${randomUUID()}.bin`;
    await fs.promises.writeFile(path.join(workspace, name), bytes);

    const page = await readWorkspaceFile(workspace, name, 0, 1024);
    expect(page.encoding).toBe('base64');
    expect(Buffer.from(page.dataBase64 ?? '', 'base64').equals(bytes)).toBe(true);
  });

  it('reports a missing file instead of returning empty content', async () => {
    await expect(readWorkspaceFile(workspace, 'missing.txt', 0, 1024)).rejects.toMatchObject({
      code: 'file_not_found',
    });
  });

  it('reuses the store namespace so artifacts and workspace files stay separate', async () => {
    const store = await CompanyStore.open(workspace);
    const namespace = store.namespaceDir;
    expect(namespace.startsWith(path.join(tempHome, '.pixel-agents'))).toBe(true);
  });
});
