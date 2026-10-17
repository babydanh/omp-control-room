/**
 * verificationDiscovery: verification profiles read out of the workspace itself.
 *
 * A Contract may only run commands the user approved, and the only honest
 * source of "what could this project verify with" is the project's own manifest
 * plus its lockfile. Nothing here installs, migrates, or writes to the
 * workspace: it reads two files, resolves executables, and reports what it found
 * along with what it had to skip and why.
 *
 * Shell-free by construction. `npm test` on Windows is an `npm.cmd` that
 * re-enters `cmd.exe`; a script string with `|`, `&&`, `;` or a redirection is
 * a chain a single argv cannot express. Both are refused rather than
 * approximated, and the refusal is reported. Instead the underlying script is
 * resolved to the real `.js`/`.mjs` entry the tool publishes and run under a
 * Node executable, which is the same program without the shell in between.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { VerificationCommand, VerificationProfile } from '../../../core/src/company.js';
import {
  COMPANY_VERIFICATION_DEFAULT_TIMEOUT_SECONDS,
  COMPANY_VERIFICATION_MAX_TIMEOUT_SECONDS,
} from './constants.js';

/** Lockfiles that identify which package manager produced `node_modules`. */
const LOCKFILES: Readonly<Record<string, string>> = {
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'yarn.lock': 'yarn',
  'pnpm-lock.yaml': 'pnpm',
  'bun.lockb': 'bun',
  'bun.lock': 'bun',
};

/** Manifest script names worth offering, mapped to the profile they produce. */
const SCRIPT_ROLES: Readonly<Record<string, string[]>> = {
  test: ['test', 'tests', 'check:tests'],
  typecheck: ['typecheck', 'type-check', 'check:types', 'types'],
  lint: ['lint', 'check:lint'],
  build: ['build', 'compile'],
};

/** Package-manager run forms that name another script rather than a program. */
const RUN_FORMS: Readonly<Record<string, string>> = {
  npm: 'npm',
  pnpm: 'pnpm',
  yarn: 'yarn',
  bun: 'bun',
};

/** `npm run <script>` and the bare `npm test` shorthand. */
const RUN_SCRIPT: Readonly<Record<string, string>> = {
  run: 'run',
  run_script: 'run',
};

/** Operators that make a script string unrepresentable as one argv. */
const SHELL_CHAIN = /[|;&<>`]|\$\(|\$\{|\n|\r/;

/** Extensions Node must be handed rather than executed directly. */
const SCRIPT_EXTENSIONS: Readonly<Record<string, true>> = {
  '.js': true,
  '.mjs': true,
  '.cjs': true,
};

const SHELL_WRAPPER_EXTENSIONS: Readonly<Record<string, true>> = {
  '.cmd': true,
  '.bat': true,
  '.ps1': true,
};

/** Bare JavaScript runtime names a manifest script may legitimately start with. */
const JS_RUNTIMES: Readonly<Record<string, string>> = { node: 'node', bun: 'bun' };

/**
 * The runtime that will execute a script. Node is this process's own executable
 * unless it is Electron, whose ABI a native module cannot use; Bun is taken from
 * the environment because this host may not be Bun at all.
 */
function runtimeExecutable(runtime: string): string {
  if (runtime === 'node') {
    if (!/electron/i.test(path.basename(process.execPath))) return process.execPath;
    const configured = process.env.NODE;
    return configured !== undefined && configured !== '' ? configured : 'node';
  }
  const configured = process.env.BUN;
  return configured !== undefined && configured !== '' ? configured : 'bun';
}

export interface VerificationDiscovery {
  readonly profiles: VerificationProfile[];
  /** Which package manager the lockfile names, or `unknown`. */
  readonly packageManager: string;
  /** Lockfiles actually present, as workspace-relative names. */
  readonly lockfiles: readonly string[];
  /** Scripts that were seen but could not be turned into one safe argv. */
  readonly skipped: readonly { readonly script: string; readonly reason: string }[];
}

interface ManifestScripts {
  readonly scripts: Readonly<Record<string, string>>;
  readonly manifestName: string;
}

function readJson(candidate: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function readManifest(workspaceRoot: string): ManifestScripts | null {
  const manifest = readJson(path.join(workspaceRoot, 'package.json'));
  if (!manifest || !('scripts' in manifest)) return null;
  const scripts = manifest.scripts;
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) return null;
  const collected: Record<string, string> = {};
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value === 'string' && value.trim() !== '') collected[name] = value;
  }
  const declaredName = typeof manifest['name'] === 'string' ? manifest['name'] : 'workspace';
  return { scripts: collected, manifestName: declaredName };
}

function detectPackageManager(workspaceRoot: string): {
  packageManager: string;
  lockfiles: string[];
} {
  const lockfiles: string[] = [];
  let packageManager = 'unknown';
  for (const [name, manager] of Object.entries(LOCKFILES)) {
    if (!fs.existsSync(path.join(workspaceRoot, name))) continue;
    lockfiles.push(name);
    // npm's lockfile wins ties: it is the only one that also pins the tree.
    if (packageManager === 'unknown' || manager === 'npm') packageManager = manager;
  }
  return { packageManager, lockfiles };
}

/** The Node runtime that executes a JavaScript entry point. */
function javaScriptRuntime(): string {
  if (!/electron/i.test(path.basename(process.execPath))) return process.execPath;
  const configured = process.env.NODE;
  if (configured && fs.existsSync(configured)) return configured;
  return 'node';
}

interface ResolvedCommand {
  readonly file: string;
  readonly argv: string[];
}

/**
 * Resolve the `.bin` shim target a package publishes, never the shim itself.
 * `node_modules/.bin` holds `.cmd` files on Windows, so the package manifest is
 * followed to the real JavaScript entry it names.
 */
function resolvePackageEntry(workspaceRoot: string, packageName: string): string | null {
  const scoped = packageName.startsWith('@');
  const packageRoot = path.join(workspaceRoot, 'node_modules', packageName);
  const manifest = readJson(path.join(packageRoot, 'package.json'));
  if (!manifest) return null;
  if (scoped && !('bin' in manifest)) return null;
  if (scoped) {
    const bin = manifest.bin;
    if (bin !== null && typeof bin === 'object' && packageName in bin) {
      const named = Object.entries(bin).find(([key]) => key === packageName)?.[1];
      if (typeof named === 'string') return path.resolve(packageRoot, named);
    }
    return null;
  }
  if (typeof manifest.bin === 'string') return path.resolve(packageRoot, manifest.bin);
  if (manifest.bin !== null && typeof manifest.bin === 'object') {
    const bin = manifest.bin;
    if (packageName in bin) {
      const named = Object.entries(bin).find(([key]) => key === packageName)?.[1];
      if (typeof named === 'string') return path.resolve(packageRoot, named);
    }
  }
  return null;
}

/** Split a script into its leading program and the words after it. */
function splitScript(script: string): { program: string; rest: string[] } {
  const words = script
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  const program = words.shift() ?? '';
  return { program, rest: words.filter((word) => !word.startsWith('-')) };
}

/** The bare package a program name refers to, unwrapping a scoped name. */
function packageOf(program: string): string {
  const segments = program.split('/');
  return program.startsWith('@') && segments.length === 2
    ? segments.join('/')
    : (segments[0] ?? program);
}

/**
 * Turn one manifest script into a single shell-free argv.
 *
 * `npm run test`, `npm test` and `yarn test` are rewritten to the script they
 * name and then resolved; anything else is resolved as a program. The result is
 * `undefined` when no honest argv exists, and the reason says which rule refused.
 */
function resolveScriptCommand(
  workspaceRoot: string,
  script: string,
  scripts: Readonly<Record<string, string>>,
): ResolvedCommand | { readonly reason: string } {
  if (SHELL_CHAIN.test(script)) {
    return {
      reason: 'the script chains commands or redirects output, which one argv cannot express',
    };
  }
  const { program, rest } = splitScript(script);
  if (program === '') return { reason: 'the script is empty' };

  const manager = RUN_FORMS[program.replace(/\.(cmd|bat|exe)$/i, '')];
  if (manager !== undefined) {
    const verb = rest[0] ?? '';
    const target = RUN_SCRIPT[verb] !== undefined ? rest[1] : verb;
    const named = target === undefined ? undefined : scripts[target];
    if (named === undefined) {
      return { reason: `${manager} would run a script this manifest does not define` };
    }
    return resolveScriptCommand(workspaceRoot, named, scripts);
  }

  // `node verify.cjs` is a real, shell-free command. A runtime is not a workspace
  // package, so it resolves to this host's own runtime rather than being reported
  // as a missing dependency. The command id convention is untouched.
  const runtime = JS_RUNTIMES[program.replace(/\.exe$/i, '')];
  if (runtime !== undefined) {
    return { file: runtimeExecutable(runtime), argv: [...rest] };
  }

  if (program === 'npx' || program === 'pnpx') {
    const target = rest[0];
    if (target === undefined) return { reason: 'npx was given no package' };
    const entry = resolvePackageEntry(workspaceRoot, packageOf(target));
    if (entry === null)
      return { reason: `${packageOf(target)} is not installed in this workspace` };
    return toResolvedCommand(entry, rest.slice(1));
  }

  if (program.startsWith('.') || path.isAbsolute(program)) {
    const absolute = path.resolve(workspaceRoot, program);
    return toResolvedCommand(absolute, rest);
  }

  const entry = resolvePackageEntry(workspaceRoot, packageOf(program));
  if (entry === null) {
    return { reason: `${packageOf(program)} is not installed in this workspace` };
  }
  return toResolvedCommand(entry, rest);
}

/** Decide how one resolved entry is executed, refusing shell wrappers outright. */
function toResolvedCommand(
  entry: string,
  rest: string[],
): ResolvedCommand | { readonly reason: string } {
  const extension = path.extname(entry).toLowerCase();
  if (SHELL_WRAPPER_EXTENSIONS[extension] === true) {
    return { reason: `${entry} is a shell wrapper; run the JavaScript entry point directly` };
  }
  if (!fs.existsSync(entry)) return { reason: `${entry} does not exist` };
  if (SCRIPT_EXTENSIONS[extension] === true) {
    return { file: javaScriptRuntime(), argv: [entry, ...rest] };
  }
  return { file: entry, argv: [...rest] };
}

/**
 * Discover what this workspace can verify with. Returns the profiles that
 * resolved to a real, shell-free command and a per-script account of the ones
 * that did not, so a missing runner is reported rather than assumed absent.
 */
export async function discoverVerificationProfiles(
  workspaceRoot: string,
): Promise<VerificationDiscovery> {
  const { packageManager, lockfiles } = detectPackageManager(workspaceRoot);
  const manifest = readManifest(workspaceRoot);
  if (manifest === null) {
    return { profiles: [], packageManager, lockfiles, skipped: [] };
  }

  const prerequisites = [`package.json:${manifest.manifestName}`, ...lockfiles];
  const profiles: VerificationProfile[] = [];
  const skipped: { script: string; reason: string }[] = [];

  for (const [profileId, candidates] of Object.entries(SCRIPT_ROLES)) {
    const scriptName = candidates.find((candidate) => manifest.scripts[candidate] !== undefined);
    if (scriptName === undefined) continue;
    const resolved = resolveScriptCommand(
      workspaceRoot,
      manifest.scripts[scriptName] ?? '',
      manifest.scripts,
    );
    if ('reason' in resolved) {
      skipped.push({ script: scriptName, reason: resolved.reason });
      continue;
    }
    const command: VerificationCommand = {
      id: `${profileId}:${scriptName}`,
      executable: resolved.file,
      argv: resolved.argv,
      // `.` is the Contract validator's marker for the workspace root. An
      // absolute cwd was refused outright, which made every profile this
      // workspace discovers unusable in a Contract.
      cwd: '.',
      timeoutSeconds: Math.min(
        COMPANY_VERIFICATION_DEFAULT_TIMEOUT_SECONDS,
        COMPANY_VERIFICATION_MAX_TIMEOUT_SECONDS,
      ),
    };
    profiles.push({
      id: profileId,
      criterionIds: [],
      commands: [command],
      prerequisites,
      outputScopes: [],
    });
  }

  return { profiles, packageManager, lockfiles, skipped };
}
