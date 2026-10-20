import type { ProjectCommentMessage } from '../../../core/src/messages.js';
import { LibraryUserError } from '../library/libraryError.js';

/** Deliver an anchored diff comment to the selected running session. */
export async function sendProjectComment(_request: ProjectCommentMessage): Promise<void> {
  throw new LibraryUserError('Chưa làm');
}
