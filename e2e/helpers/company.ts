import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const READY_PREFIX = '[company-e2e-ready] ';
const ROOT = path.resolve(__dirname, '../..');
export const COMPANY_FIXTURE_OUTPUT = 'mock-omp-company wrote this file for the E2E scenario.\n';

export interface CompanySmokeHost {
  url: string;
  workspacePath: string;
  child: ChildProcess;
  logs(): string;
  close(): Promise<void>;
}

/** Launches real owner/HTTP/helper/bridge processes under an isolated home. */
export async function startCompanySmokeHost(): Promise<CompanySmokeHost> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pixel-company-e2e-'));
  const workspacePath = path.join(home, 'workspace');
  await fs.mkdir(workspacePath);
  await fs.writeFile(path.join(workspacePath, 'package.json'), JSON.stringify({
    name: 'company-smoke', version: '1.0.0', private: true,
    // Named `test` because discovery maps a manifest script to a profile role,
    // and `test` is the only role that runs a check here; the command id it
    // publishes is `${profileId}:${scriptName}` = `test:test`, which is exactly
    // what the fixture's company_verify call names.
    scripts: { test: 'node verify.cjs' },
  }));
  await fs.writeFile(path.join(workspacePath, 'package-lock.json'), JSON.stringify({
    name: 'company-smoke', version: '1.0.0', lockfileVersion: 3, packages: {},
  }));
  await fs.writeFile(path.join(workspacePath, 'verify.cjs'),
    `const assert = require('node:assert/strict');\n` +
    `const fs = require('node:fs');\n` +
    `assert.equal(fs.readFileSync('result.txt', 'utf8'), ${JSON.stringify(COMPANY_FIXTURE_OUTPUT)});\n` +
    `console.log('Company result content verified');\n`,
  );
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'e2e/fixtures/company-host.ts'), workspacePath], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = '';
  child.stderr?.on('data', (data: Buffer) => { logs += data.toString(); });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        if (child.connected) child.send('shutdown');
        else child.kill();
        const deadline = setTimeout(() => child.kill(), 15_000);
        try { await exited; } finally { clearTimeout(deadline); }
      }
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    })();
    return closing;
  };
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let pending = '';
      const deadline = setTimeout(() => reject(new Error(`Company host readiness timed out:\n${logs}`)), 30_000);
      const fail = (error: Error) => { clearTimeout(deadline); reject(error); };
      child.once('error', fail);
      child.once('exit', (code) => fail(new Error(`Company host exited ${String(code)}:\n${logs}`)));
      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        logs += text;
        pending += text;
        for (let index = pending.indexOf('\n'); index >= 0; index = pending.indexOf('\n')) {
          const line = pending.slice(0, index).trim();
          pending = pending.slice(index + 1);
          if (!line.startsWith(READY_PREFIX)) continue;
          try {
            const payload = JSON.parse(line.slice(READY_PREFIX.length)) as { url: string };
            clearTimeout(deadline);
            resolve(payload.url);
          } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
        }
      });
    });
    return { url, workspacePath, child, logs: () => logs, close };
  } catch (error) {
    await close();
    throw error;
  }
}
