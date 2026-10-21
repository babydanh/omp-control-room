const NOTICE_PREFIX = /^\[Tin từ [^\]]+\] ?/;
const REPLY_GUIDANCE = /\n?\(Trả lời nếu cần:[^\n]*\)\s*$/;

/** Removes the lane delivery wrapper and trailing reply instructions from a notice. */
export function coordinationMessageContent(content: string): string {
  return content.replace(NOTICE_PREFIX, '').replace(REPLY_GUIDANCE, '').trimEnd();
}

export function handoffSection(markdown: string, sectionName: string): string {
  const lines = markdown.split(/\r?\n/);
  const heading = lines.findIndex((line) => line.trim() === `## ${sectionName}`);
  if (heading < 0) return '';
  let end = heading + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end])) end += 1;
  return lines
    .slice(heading + 1, end)
    .join('\n')
    .trim()
    .slice(0, 300);
}
