/**
 * usePromptImages: sends the prompt box's images to the server and appends each
 * saved path to the draft (see `promptImages.ts` for why a path, not bytes).
 */

import { useEffect, useState } from 'react';

import type { ProjectImageSaveMessage } from '../../../core/src/messages.js';
import type { CompanyClient } from './companyClient.js';
import { projectStore } from './projects/projectClient.js';
import { useProjectState } from './projects/projectStore.js';
import {
  IMAGE_SAVE_FALLBACK,
  IMAGE_SIZE_NOTICE,
  IMAGE_TYPE_NOTICE,
  PROMPT_IMAGE_MAX_BYTES,
  PROMPT_IMAGE_TYPES,
  withImagePath,
} from './promptImages.js';

function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/** `onNotice` hears refusals; `saving` counts the images still on their way. */
export function usePromptImages(
  client: CompanyClient,
  onNotice: (text: string) => void,
): { attach: (files: readonly File[]) => void; saving: number } {
  const projects = useProjectState(projectStore);
  const [pending, setPending] = useState<readonly string[]>([]);

  useEffect(() => {
    const done = pending.filter((id) => projects.results[id] !== undefined);
    if (done.length === 0) return;
    for (const id of done) {
      const result = projects.results[id];
      if (result?.type === 'projectImageSaved') {
        client.setDraftText(withImagePath(client.getState().prompt.text, result.path));
      } else {
        onNotice((result !== undefined && 'reason' in result && result.reason) || IMAGE_SAVE_FALLBACK);
      }
    }
    setPending((current) => current.filter((id) => !done.includes(id)));
  }, [client, onNotice, pending, projects.results]);

  const attach = (files: readonly File[]) => {
    for (const file of files) {
      if (!PROMPT_IMAGE_TYPES.has(file.type)) {
        onNotice(IMAGE_TYPE_NOTICE);
        continue;
      }
      if (file.size > PROMPT_IMAGE_MAX_BYTES) {
        onNotice(IMAGE_SIZE_NOTICE);
        continue;
      }
      void base64Of(file).then(
        (dataBase64) => {
          const id = projectStore.saveImage({
            fileName: file.name || 'anh',
            mediaType: file.type as ProjectImageSaveMessage['mediaType'],
            dataBase64,
          });
          setPending((current) => [...current, id]);
        },
        () => onNotice(IMAGE_SAVE_FALLBACK),
      );
    }
  };

  return { attach, saving: pending.length };
}
