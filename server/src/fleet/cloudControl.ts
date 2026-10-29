/**
 * Cloud control: the two things the board may DO to a cloud machine, both through the InstaBox
 * CLI already signed in on this computer (no new credential, no port opened on the machine):
 *
 *  - openTerminal: a local PTY running `instabox ssh <machine> -- -tt ... tmux attach -t <session>`,
 *    registered with the board's PtySessionManager so the existing `/terminal/:id` socket (token +
 *    Origin checked) carries it. Screen bytes flow only while that socket is open.
 *  - createTask: `cloud-giao <repo> <slug> <machine>` on the machine (installed by the cloud bundle):
 *    a worktree on branch `cloud/<machine>-<slug>` and Claude started in tmux session `<slug>`.
 *    The prompt travels on stdin, never on a command line.
 *
 * Every name is validated against a strict pattern before it reaches an argv, and argv is passed
 * without a local shell; on the machine, ssh/exec join it into a shell line, which is why the
 * patterns allow no quoting or shell metacharacters.
 */

import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PtySessionManager } from '../terminal/ptySessionManager.js';
import {
  FLEET_ACCOUNT_CACHE_MS,
  FLEET_INSTABOX_TIMEOUT_MS,
  FLEET_MACHINE_NAME,
  FLEET_PROMPT_MAX,
  FLEET_SESSION_NAME,
  FLEET_TASK_REPOS,
  FLEET_TASK_SLUG,
  FLEET_TERMINAL_ID_BASE,
} from './constants.js';

export type FleetTaskRepo = (typeof FLEET_TASK_REPOS)[number];

export class CloudControlError extends Error {
  constructor(
    readonly code: 'bad_input' | 'no_machine' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

export interface InstaboxResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CloudControlDeps {
  /** Account config homes (each used as XDG_CONFIG_HOME), default account first. */
  listConfigHomes(): Promise<string[]>;
  run(args: readonly string[], configHome: string, input?: string): Promise<InstaboxResult>;
  /** The executable and leading args that start the InstaBox CLI. */
  readonly launcher: { readonly file: string; readonly args: readonly string[] };
  now(): number;
}

export function isTaskRepo(value: unknown): value is FleetTaskRepo {
  return typeof value === 'string' && (FLEET_TASK_REPOS as readonly string[]).includes(value);
}

export class CloudControl {
  #accounts: { readonly at: number; readonly byMachine: Map<string, string> } | null = null;
  readonly #terminalIds = new Map<string, number>();
  #nextTerminalId = FLEET_TERMINAL_ID_BASE;

  constructor(private readonly deps: CloudControlDeps = defaultDeps()) {}

  async openTerminal(ptyManager: PtySessionManager, machine: string, session: string): Promise<number> {
    if (!FLEET_MACHINE_NAME.test(machine) || !FLEET_SESSION_NAME.test(session)) {
      throw new CloudControlError('bad_input', 'invalid name');
    }
    const home = await this.#wake(machine);
    const key = `${machine}/${session}`;
    const existing = this.#terminalIds.get(key);
    if (existing !== undefined && ptyManager.has(existing)) return existing;
    const terminalId = existing ?? ++this.#nextTerminalId;
    this.#terminalIds.set(key, terminalId);
    ptyManager.create({
      agentId: terminalId,
      command: this.deps.launcher.file,
      args: [
        ...this.deps.launcher.args,
        'ssh',
        machine,
        '--',
        '-tt',
        'env',
        'TERM=xterm-256color',
        'tmux',
        'attach',
        '-t',
        session,
      ],
      cwd: os.homedir(),
      env: { XDG_CONFIG_HOME: home },
    });
    return terminalId;
  }

  async createTask(machine: string, repo: unknown, slug: string, prompt: string): Promise<string> {
    if (
      !FLEET_MACHINE_NAME.test(machine) ||
      !isTaskRepo(repo) ||
      !FLEET_TASK_SLUG.test(slug) ||
      prompt.trim() === '' ||
      prompt.length > FLEET_PROMPT_MAX
    ) {
      throw new CloudControlError('bad_input', 'invalid task');
    }
    const home = await this.#wake(machine);
    const result = await this.deps.run(
      ['exec', machine, '--timeout', '300', '--stdin', '--', 'cloud-giao', repo, slug, machine],
      home,
      prompt,
    );
    if (result.code !== 0 || !/^OK /m.test(result.stdout)) {
      const said = `${result.stdout}\n${result.stderr}`.trim().split('\n').filter(Boolean).pop();
      throw new CloudControlError('failed', said ?? `cloud-giao exit ${result.code}`);
    }
    return slug;
  }

  /** The account home owning `machine`, after asking InstaBox to start/wake it (both no-ops when running). */
  async #wake(machine: string): Promise<string> {
    const home = await this.#accountFor(machine);
    await this.deps.run(['start', machine], home).catch(() => undefined);
    await this.deps.run(['wake', machine], home).catch(() => undefined);
    return home;
  }

  async #accountFor(machine: string): Promise<string> {
    const fresh = this.#accounts && this.deps.now() - this.#accounts.at < FLEET_ACCOUNT_CACHE_MS;
    if (!fresh || !this.#accounts?.byMachine.has(machine)) {
      const byMachine = new Map<string, string>();
      for (const home of await this.deps.listConfigHomes()) {
        const listed = await this.deps.run(['ls', '--json'], home).catch(() => null);
        for (const name of machineNames(listed?.stdout ?? '')) {
          if (!byMachine.has(name)) byMachine.set(name, home);
        }
      }
      this.#accounts = { at: this.deps.now(), byMachine };
    }
    const home = this.#accounts?.byMachine.get(machine);
    if (home === undefined) throw new CloudControlError('no_machine', machine);
    return home;
  }
}

export function machineNames(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((box: unknown) =>
      box && typeof box === 'object' && 'name' in box && typeof box.name === 'string' ? [box.name] : [],
    );
  } catch {
    return [];
  }
}

function defaultLauncher(): { file: string; args: string[] } {
  const script =
    process.env.PIXEL_AGENTS_INSTABOX ??
    (process.platform === 'win32' && process.env.APPDATA
      ? path.join(process.env.APPDATA, 'npm', 'node_modules', 'instabox', 'bin', 'instabox.mjs')
      : null);
  return script ? { file: process.execPath, args: [script] } : { file: 'instabox', args: [] };
}

function defaultDeps(): CloudControlDeps {
  const launcher = defaultLauncher();
  return {
    launcher,
    now: () => Date.now(),
    async listConfigHomes() {
      const extra = path.join(os.homedir(), '.config-instabox');
      const names = await readdir(extra, { withFileTypes: true }).catch(() => []);
      return [
        path.join(os.homedir(), '.config'),
        ...names.filter((entry) => entry.isDirectory()).map((entry) => path.join(extra, entry.name)),
      ];
    },
    run(args, configHome, input) {
      return new Promise((resolve) => {
        const child = execFile(
          launcher.file,
          [...launcher.args, ...args],
          {
            env: { ...process.env, XDG_CONFIG_HOME: configHome },
            timeout: FLEET_INSTABOX_TIMEOUT_MS,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
          },
          (error, stdout, stderr) => {
            const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
            resolve({ code, stdout: String(stdout), stderr: String(stderr) });
          },
        );
        if (input !== undefined) child.stdin?.end(input);
        else child.stdin?.end();
      });
    },
  };
}
