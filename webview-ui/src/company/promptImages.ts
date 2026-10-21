/**
 * promptImages: images pasted, dropped or picked into the prompt box.
 *
 * A prompt reaches an agent as text typed into its terminal, so an image cannot ride
 * along as bytes. The server saves it under ~/.pixel-agents/attachments and answers
 * with the path; the path goes into the draft, and the agent opens the image from it
 * (omp and Claude Code read images from a path). `usePromptImages.ts` sends them.
 */

/** The image types the server keeps. */
export const PROMPT_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Largest image sent, matching the server's limit: 10 MiB. */
export const PROMPT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export const IMAGE_TYPE_NOTICE = 'Chỉ gửi được ảnh PNG, JPEG, GIF hoặc WebP.';
export const IMAGE_SIZE_NOTICE = 'Ảnh lớn hơn 10 MB.';
export const IMAGE_SAVE_FALLBACK = 'Không lưu được ảnh.';

/** The draft with an image path appended, on the same line, separated by one space. */
export function withImagePath(text: string, path: string): string {
  const gap = text === '' || /\s$/.test(text) ? '' : ' ';
  return `${text}${gap}${path} `;
}

/** The images among pasted or dropped items; other files are left to the browser. */
export function imageFiles(files: Iterable<File>): File[] {
  return [...files].filter((file) => file.type.startsWith('image/'));
}
