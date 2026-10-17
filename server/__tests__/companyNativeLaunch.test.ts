import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveNativeLaunch } from '../src/company/companyNativeLaunch.js';

const BUN_FILE = process.platform === 'win32' ? 'bun.exe' : 'bun';

let root: string;

/** An npm global install of OMP under `<root>/npm`, as `npm i -g` lays it out. */
function installOmp(bin: unknown): string {
  const packageRoot = path.join(root, 'npm', 'node_modules', '@oh-my-pi', 'pi-coding-agent');
  fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ bin }));
  const entry = path.join(packageRoot, 'dist', 'cli.js');
  fs.writeFileSync(entry, '#!/usr/bin/env bun\n');
  return entry;
}

function resolve() {
  return resolveNativeLaunch({ distDir: root, extensionPath: __filename, helperPath: __filename });
}

describe('resolveNativeLaunch', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-native-launch-'));
    vi.stubEnv('APPDATA', root);
    vi.stubEnv('OMP_CLI_ENTRY', '');
    vi.stubEnv('BUN', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds the published omp command and runs it with Bun found on PATH', () => {
    const entry = installOmp({ omp: 'dist/cli.js' });
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, BUN_FILE), '');
    vi.stubEnv('PATH', binDir);

    // node-pty does not search PATH on Windows, so a bare `bun` cannot start.
    expect(resolve().command).toEqual({ file: path.join(binDir, BUN_FILE), args: [entry] });
  });

  it('still accepts a bin map keyed by the package name', () => {
    const entry = installOmp({ '@oh-my-pi/pi-coding-agent': 'dist/cli.js' });

    expect(resolve().command.args).toEqual([entry]);
  });

  it('refuses a bin map that names neither command', () => {
    installOmp({ other: 'dist/cli.js' });

    expect(resolve).toThrowError(expect.objectContaining({ code: 'omp_executable_unavailable' }));
  });
});
