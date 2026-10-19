/**
 * Production wiring for the ledger: the activity database and scripts under the
 * user's home folder, the real git and python runners, and the real clock and
 * timers. Both the standalone server and the VS Code adapter create their
 * ledger here.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import {
  LEDGER_DB_SEGMENTS,
  LEDGER_OVERLAP_SCRIPT_SEGMENTS,
  LEDGER_PYTHON_COMMAND,
  LEDGER_WHO_SCRIPT_SEGMENTS,
} from './constants.js';
import { createGitRunner } from './git.js';
import { openLedgerSource } from './ledgerDb.js';
import { LedgerService } from './ledgerService.js';
import { runProcess, type ScriptRunner } from './processRunner.js';

export interface LedgerRuntimeOptions {
  /** Extra repo folders to scan, such as the company workspace folders. */
  readonly extraRepoPaths?: () => readonly string[];
  /** The open Company folder that holds a path (deepest match), or undefined. Never rejects. */
  readonly workspaceFor?: (path: string) => Promise<string | undefined>;
}

/** Creates the ledger service for this user. Call `dispose()` on shutdown. */
export function createLedgerService(options: LedgerRuntimeOptions = {}): LedgerService {
  const home = os.homedir();
  const dbPath = path.join(home, ...LEDGER_DB_SEGMENTS);
  const overlapScript = path.join(home, ...LEDGER_OVERLAP_SCRIPT_SEGMENTS);
  const whoScript = path.join(home, ...LEDGER_WHO_SCRIPT_SEGMENTS);
  return new LedgerService({
    source: openLedgerSource(dbPath),
    git: createGitRunner(runProcess),
    overlap: pythonRunner(overlapScript),
    who: pythonRunner(whoScript),
    now: Date.now,
    schedule: { setInterval, clearInterval },
    extraRepoPaths: options.extraRepoPaths,
    workspaceFor: options.workspaceFor,
  });
}

/** Runs one of the operator's python scripts. The argv never goes through a shell. */
function pythonRunner(script: string): ScriptRunner {
  return (argv, runOptions) => runProcess(LEDGER_PYTHON_COMMAND, [script, ...argv], runOptions);
}
