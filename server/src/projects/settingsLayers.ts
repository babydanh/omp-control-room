import type {
  ProjectSettingsClearMessage,
  ProjectSettingsMessage,
  ProjectSettingsRequestMessage,
  ProjectSettingsSetMessage,
} from '../../../core/src/messages.js';
import { LibraryUserError } from '../library/libraryError.js';

/** Resolve effective settings and their global/project/folder source labels. */
export async function getProjectSettings(
  _request: ProjectSettingsRequestMessage,
): Promise<ProjectSettingsMessage> {
  throw new LibraryUserError('Chưa làm');
}

/** Persist a project- or folder-level settings override. */
export async function setProjectSettings(_request: ProjectSettingsSetMessage): Promise<void> {
  throw new LibraryUserError('Chưa làm');
}

/** Clear a project- or folder-level override to reveal the inherited value. */
export async function clearProjectSettings(_request: ProjectSettingsClearMessage): Promise<void> {
  throw new LibraryUserError('Chưa làm');
}
