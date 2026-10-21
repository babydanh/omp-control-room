import type { ProjectBranchCompareMessage, ProjectBranchCompareRequestMessage } from '../../../core/src/messages.js';
import { createGitRunner, type GitRunner } from '../ledger/git.js';
import type { ProcessRunner } from '../ledger/processRunner.js';
import { compareProjectBranches } from './branchCompareEngine.js';
import type { ProjectModuleDeps } from './services.js';

export interface ProjectBranchCompareServices {
  readonly git: GitRunner;
}

export function createProjectBranchCompareServices(runtime: { readonly runProcess: ProcessRunner }): ProjectBranchCompareServices {
  return { git: createGitRunner(runtime.runProcess) };
}

export async function getProjectBranchCompare(
  request: ProjectBranchCompareRequestMessage,
  deps: ProjectModuleDeps<ProjectBranchCompareServices>,
): Promise<ProjectBranchCompareMessage> {
  const tree = await deps.loadTree();
  const knownRepos = tree.nodes
    .filter((node) => node.kind === 'repository' && node.path !== undefined)
    .map((node) => node.path as string);
  return compareProjectBranches(request, { git: deps.services.git, knownRepos });
}
