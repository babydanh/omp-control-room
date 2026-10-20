import type { ProjectDiffMessage, ProjectDiffRequestMessage } from '../../../core/src/messages.js';
import { createGitRunner, type GitRunner } from '../ledger/git.js';
import type { EventRow, LedgerSource, SessionRow } from '../ledger/ledgerDb.js';
import type { ProcessRunner } from '../ledger/processRunner.js';
import { readCheckoutDiff } from './projectDiffEngine.js';
import type { ProjectModuleDeps } from './services.js';

export interface ProjectDiffServices {
  readonly git: GitRunner;
  readonly events: () => readonly EventRow[];
  readonly sessions: () => readonly SessionRow[];
}

export function createProjectDiffServices(runtime: { readonly runProcess: ProcessRunner; readonly ledger: Pick<LedgerSource, 'eventRows' | 'sessionRows'> }): ProjectDiffServices {
  return {
    git: createGitRunner(runtime.runProcess),
    events: () => runtime.ledger.eventRows('1970-01-01T00:00:00.000Z'),
    sessions: () => runtime.ledger.sessionRows(),
  };
}

/** Read an allowlisted checkout diff and attribute each changed file to its editor. */
export async function getProjectDiff(
  request: ProjectDiffRequestMessage,
  deps: ProjectModuleDeps<ProjectDiffServices>,
): Promise<ProjectDiffMessage> {
  const tree = await deps.loadTree();
  const knownCheckouts = tree.nodes
    .filter((node) => node.kind === 'checkout' && node.path !== undefined)
    .map((node) => node.path as string);
  return readCheckoutDiff(request, {
    git: deps.services.git,
    knownCheckouts,
    events: deps.services.events(),
    sessions: deps.services.sessions(),
  });
}
