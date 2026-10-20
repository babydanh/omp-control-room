import type {
  ProjectMergePreviewRequestMessage,
  ProjectMergePreviewResultMessage,
} from '../../../core/src/messages.js';
import { LibraryUserError } from '../library/libraryError.js';

/** Preview the merge between two branches without mutating the repository. */
export async function previewProjectMerge(
  _request: ProjectMergePreviewRequestMessage,
): Promise<ProjectMergePreviewResultMessage> {
  throw new LibraryUserError('Chưa làm');
}
