export interface NumberedDiffLine {
  readonly kind: 'addition' | 'deletion' | 'context' | 'meta';
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly text: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Assign old/new line numbers to a unified diff's hunk content. */
export function numberDiffLines(content: string): NumberedDiffLine[] {
  let oldLine: number | null = null;
  let newLine: number | null = null;
  return content.split('\n').filter((line, index, lines) => !(index === lines.length - 1 && line === '')).map((text) => {
    const header = HUNK_HEADER.exec(text);
    if (header !== null) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      return { kind: 'meta', oldLine: null, newLine: null, text };
    }
    if (oldLine === null || newLine === null || text.startsWith('\\')) {
      return { kind: 'meta', oldLine: null, newLine: null, text };
    }
    const prefix = text[0];
    if (prefix === '+') {
      const numbered = { kind: 'addition' as const, oldLine: null, newLine, text: text.slice(1) };
      newLine += 1;
      return numbered;
    }
    if (prefix === '-') {
      const numbered = { kind: 'deletion' as const, oldLine, newLine: null, text: text.slice(1) };
      oldLine += 1;
      return numbered;
    }
    const numbered = { kind: 'context' as const, oldLine, newLine, text: text.startsWith(' ') ? text.slice(1) : text };
    oldLine += 1;
    newLine += 1;
    return numbered;
  });
}
