import type {
  ProjectMergePreviewRequestMessage,
  ProjectMergePreviewResultMessage,
} from '../../../core/src/messages.js';
import { createGitRunner, type GitRunner } from '../ledger/git.js';
import type { ProcessRunner } from '../ledger/processRunner.js';
import { previewBranchMerge } from './projectMergePreviewEngine.js';
import type { ProjectModuleDeps } from './services.js';

export interface ProjectMergePreviewServices {
  readonly git: GitRunner;
}

export function createProjectMergePreviewServices(runtime: { readonly runProcess: ProcessRunner }): ProjectMergePreviewServices {
  return { git: createGitRunner(runtime.runProcess) };
}

/** Preview the merge between two branches without mutating the repository. */
export async function previewProjectMerge(
  request: ProjectMergePreviewRequestMessage,
  deps: ProjectModuleDeps<ProjectMergePreviewServices>,
): Promise<ProjectMergePreviewResultMessage> {
  const tree = await deps.loadTree();
  const knownRepos = tree.nodes.filter((node) => node.kind === 'repository' && node.path).map((node) => node.path as string);
  return previewBranchMerge(request, { git: deps.services.git, knownRepos });
}
