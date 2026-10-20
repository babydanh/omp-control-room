import type { ProjectDiffMessage, ProjectDiffRequestMessage } from '../../../core/src/messages.js';
import { LibraryUserError } from '../library/libraryError.js';

/** Read an allowlisted checkout diff and attribute each changed file to its editor. */
export async function getProjectDiff(
  _request: ProjectDiffRequestMessage,
): Promise<ProjectDiffMessage> {
  throw new LibraryUserError('Chưa làm');
}
