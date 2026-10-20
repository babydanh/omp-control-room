import type {
  ProjectSessionStartMessage,
  ProjectSessionStartResultMessage,
} from '../../../core/src/messages.js';
import { LibraryUserError } from '../library/libraryError.js';

/** Start a session from a Project checkout using a separate worktree or shared directory. */
export async function startProjectSession(
  _request: ProjectSessionStartMessage,
): Promise<ProjectSessionStartResultMessage> {
  throw new LibraryUserError('Chưa làm');
}
