/**
 * companyNativeLaunch: the prerequisites a real OMP run needs.
 *
 * Everything here resolves a PATH and refuses rather than substitutes. The
 * rules that matter:
 *
 *  - No shell wrapper. On Windows an npm install puts `omp.cmd` on PATH; running
 *    it would spawn `cmd.exe`, so prompt-adjacent text could be re-interpreted by
 *    a shell and the spawned image would not be the one the supervisor verifies.
 *    A `.cmd`/`.bat` target is refused, and a JavaScript entry point is launched
 *    by a real Node executable instead.
 *  - No credential reads. Resolution touches the filesystem and package
 *    manifests only; nothing here opens a settings file, keychain or auth store.
 *  - No installation. If OMP is not installed, this throws a typed capability
 *    error; it never runs an installer and never creates a stub executable.
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import { CompanyError } from './companyError.js';
import { COMPANY_OMP_BRIDGE_FILENAME, COMPANY_PTY_HOST_FILENAME } from './constants.js';
import type { OmpRunnerCommand } from './ompRunner.js';

/** Windows shell wrappers, which are never a safe process to supervise. */
const SHELL_WRAPPER_EXTENSIONS: Readonly<Record<string, true>> = {
  '.cmd': true,
  '.bat': true,
  '.ps1': true,
};

/** Extensions that mean "run this with a JavaScript runtime", not "execute it". */
const SCRIPT_EXTENSIONS: Readonly<Record<string, true>> = {
  '.js': true,
  '.mjs': true,
  '.cjs': true,
};

/**
 * The published name of the native runtime. Its CLI shim is a BUN script, so the
 * JavaScript runtime that executes it must be Bun even though this host is Node.
 */
const OMP_PACKAGE = '@oh-my-pi/pi-coding-agent';

/** The command name the published package maps in its `bin` field. */
const OMP_COMMAND = 'omp';

export interface NativeLaunchInput {
  /** Explicit override; validated, never re-resolved. */
  readonly runnerCommand?: OmpRunnerCommand;
  /** Explicit override for the bundled OMP bridge extension. */
  readonly extensionPath?: string;
  /** Explicit override for the bundled PTY helper. */
  readonly helperPath?: string;
  /** Directory `dist/` lives in; defaults to this module's own directory. */
  readonly distDir?: string;
}

export interface NativeLaunchResolution {
  readonly command: OmpRunnerCommand;
  readonly extensionPath: string;
  readonly helperPath: string;
}

/** True for an extension a shell would have to run, or a runtime we cannot resolve. */
function isShellWrapper(target: string): boolean {
  return SHELL_WRAPPER_EXTENSIONS[path.extname(target).toLowerCase()] === true;
}

/** True when the file must be handed to a JavaScript runtime, not executed. */
function isScriptEntry(target: string): boolean {
  return SCRIPT_EXTENSIONS[path.extname(target).toLowerCase()] === true;
}

function isReadableFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * The JavaScript runtime that will execute an OMP entry point. Under the VS
 * Code extension host `process.execPath` is Electron, whose ABI does not match
 * a native module build, so `NODE` (or `node` from PATH) is used there.
 */
/**
 * The JavaScript runtime that executes the native entry point.
 *
 * The published CLI is a Bun script, so this host's own Node cannot run it, and
 * an Electron host is never a runtime at all. Bun is located the same way a
 * shell would: `BUN`, beside this runtime, then every PATH directory. The
 * answer is an ABSOLUTE path whenever one exists: the PTY helper spawns
 * through node-pty, which on Windows does not search PATH and fails a bare
 * `bun` with "File not found".
 */
function bunRuntime(): string {
  const configured = process.env.BUN;
  if (configured && isReadableFile(configured)) return configured;
  const executable = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const execDir = path.dirname(process.execPath);
  const pathDirs = (process.env.PATH ?? process.env.Path ?? '')
    .split(path.delimiter)
    .filter((dir) => dir.trim() !== '');
  for (const dir of [execDir, path.join(execDir, '..'), ...pathDirs]) {
    const candidate = path.join(dir, executable);
    if (isReadableFile(candidate)) return candidate;
  }
  return 'bun';
}

function javaScriptRuntime(distDir: string): string {
  const bun = bunRuntime();
  if (bun !== 'bun' || isReadableFile(bun)) return bun;
  // A bare name is resolved by the OS at exec time; failing here would hide a
  // perfectly good PATH install, so it is passed through and never substituted.
  void distDir;
  return bun;
}

/** Every package manifest that could name the OMP entry point, in precedence order. */
function candidatePackageRoots(distDir: string): string[] {
  const roots: string[] = [];
  const require = createRequire(path.join(distDir, 'noop.js'));
  try {
    roots.push(path.dirname(require.resolve(`${OMP_PACKAGE}/package.json`)));
  } catch {
    // Not resolvable from this package; the global roots below may still hold it.
  }
  const execDir = path.dirname(process.execPath);
  roots.push(path.join(execDir, 'node_modules', OMP_PACKAGE));
  roots.push(path.join(execDir, '..', 'node_modules', OMP_PACKAGE));
  const appData = process.env.APPDATA;
  if (appData) roots.push(path.join(appData, 'npm', 'node_modules', OMP_PACKAGE));
  return roots;
}

/**
 * The file a package's `bin` field names, or undefined when it names none. The
 * published package maps its `omp` command (`{ "omp": "dist/cli.js" }`); a map
 * keyed by the package name is accepted too.
 */
function binEntry(packageRoot: string): string | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
  if (manifest === null || typeof manifest !== 'object' || !('bin' in manifest)) return undefined;
  const bin = manifest.bin;
  if (typeof bin === 'string') return path.resolve(packageRoot, bin);
  if (bin === null || typeof bin !== 'object') return undefined;
  for (const key of [OMP_COMMAND, OMP_PACKAGE]) {
    const named: unknown = (bin as Record<string, unknown>)[key];
    if (typeof named === 'string') return path.resolve(packageRoot, named);
  }
  return undefined;
}

/**
 * Resolve the real OMP entry point. A native binary is returned as-is; a
 * JavaScript entry is returned together with the runtime that must execute it.
 */
function resolveInstalledCommand(distDir: string): OmpRunnerCommand {
  const explicitEntry = process.env.OMP_CLI_ENTRY;
  const roots = explicitEntry ? [] : candidatePackageRoots(distDir);
  const candidates = explicitEntry
    ? [explicitEntry]
    : roots.map((root) => binEntry(root)).filter((entry): entry is string => entry !== undefined);

  for (const candidate of candidates) {
    if (!isReadableFile(candidate)) continue;
    if (isShellWrapper(candidate)) continue;
    if (isScriptEntry(candidate)) {
      return { file: javaScriptRuntime(distDir), args: [candidate] };
    }
    return { file: candidate, args: [] };
  }

  throw new CompanyError(
    'omp_executable_unavailable',
    'No installed OMP executable could be resolved. Point the Company runtime at one explicitly, or install OMP; nothing is installed or substituted on its behalf.',
  );
}

/** Resolve a bundled artifact, failing with a capability error rather than a guess. */
function resolveBundled(input: {
  override: string | undefined;
  distDir: string;
  filename: string;
  code: string;
  hint: string;
}): string {
  if (input.override !== undefined) {
    if (!isReadableFile(input.override)) {
      throw new CompanyError(input.code, `${input.override} is not a readable file.`);
    }
    return input.override;
  }
  const bundled = path.join(input.distDir, input.filename);
  if (isReadableFile(bundled)) return bundled;
  throw new CompanyError(input.code, input.hint);
}

/**
 * Resolve every prerequisite, or explain precisely which one is missing.
 *
 * The command is validated the same way whether it was passed in or found, so
 * an explicit override cannot smuggle a shell wrapper past the checks above.
 */
export function resolveNativeLaunch(input: NativeLaunchInput = {}): NativeLaunchResolution {
  const distDir = input.distDir ?? __dirname;
  const command = input.runnerCommand ?? resolveInstalledCommand(distDir);
  if (command.file.trim() === '') {
    throw new CompanyError('omp_executable_unavailable', 'The OMP command has no executable.');
  }
  if (isShellWrapper(command.file)) {
    throw new CompanyError(
      'omp_executable_unavailable',
      `${command.file} is a shell wrapper. Run the real executable or the JavaScript entry point directly so the supervised process is the one that was started.`,
    );
  }
  if (command.file.includes(path.sep) && !isReadableFile(command.file)) {
    throw new CompanyError(
      'omp_executable_unavailable',
      `${command.file} is not a readable executable.`,
    );
  }

  return {
    command,
    extensionPath: resolveBundled({
      override: input.extensionPath,
      distDir,
      filename: COMPANY_OMP_BRIDGE_FILENAME,
      code: 'omp_extension_missing',
      hint: `The OMP bridge extension was not found at ${path.join(distDir, COMPANY_OMP_BRIDGE_FILENAME)}. Build it, or pass an explicit extension path.`,
    }),
    helperPath: resolveBundled({
      override: input.helperPath,
      distDir,
      filename: COMPANY_PTY_HOST_FILENAME,
      code: 'pty_helper_missing',
      hint: `The PTY helper was not found at ${path.join(distDir, COMPANY_PTY_HOST_FILENAME)}. Build it, or pass an explicit helper path.`,
    }),
  };
}
