export interface FleetDiffCommentSelection {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

export interface FleetDiffCommentSelector {
  select(startIndex: number, endIndex?: number): FleetDiffCommentSelection | null;
}

interface SelectableDiffLine {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

const MAX_DIFF_COMMENT_SNIPPET = 1_200;

/** Maps rendered unified-diff line indexes to a file and its new-side line numbers. */
export function createFleetDiffCommentSelector(text: string): FleetDiffCommentSelector {
  const selectable = new Map<number, SelectableDiffLine>();
  const lines = text.split('\n');
  let file = '';
  let newLine = 0;
  let inHunk = false;
  let untrackedFile = false;

  for (const [index, line] of lines.entries()) {
    if (line.startsWith('diff --git a/')) {
      const destination = line.lastIndexOf(' b/');
      file = destination >= 0 ? line.slice(destination + 3) : '';
      newLine = 0;
      inHunk = false;
      untrackedFile = false;
      continue;
    }
    if (line.startsWith('### File mới: ')) {
      file = line.slice('### File mới: '.length);
      newLine = 1;
      inHunk = false;
      untrackedFile = true;
      continue;
    }
    if (!untrackedFile && !inHunk && line.startsWith('+++ ')) {
      const destination = line.slice(4);
      if (destination.startsWith('b/')) {
        file = destination.slice(2);
      } else if (destination !== '/dev/null') {
        file = destination;
        newLine = 1;
        untrackedFile = true;
      }
      continue;
    }
    const hunk = /^@@ .* \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk !== null) {
      newLine = Number(hunk[1]);
      inHunk = true;
      untrackedFile = false;
      continue;
    }
    if (file === '' || line.startsWith('--- ')) continue;

    if (untrackedFile && line.startsWith('+')) {
      selectable.set(index, { file, line: newLine, text: line });
      newLine += 1;
    } else if (inHunk && line.startsWith('+')) {
      selectable.set(index, { file, line: newLine, text: line });
      newLine += 1;
    } else if (inHunk && line.startsWith('-')) {
      selectable.set(index, { file, line: newLine, text: line });
    } else if (inHunk && line.startsWith(' ')) {
      selectable.set(index, { file, line: newLine, text: line });
      newLine += 1;
    } else if (inHunk && !line.startsWith('\\')) {
      inHunk = false;
    }
  }

  return {
    select(startIndex, endIndex = startIndex) {
      if (!Number.isSafeInteger(startIndex) || !Number.isSafeInteger(endIndex)) return null;
      const firstIndex = Math.min(startIndex, endIndex);
      const lastIndex = Math.max(startIndex, endIndex);
      const first = selectable.get(firstIndex);
      if (first === undefined) return null;
      let snippet = '';
      for (let index = firstIndex; index <= lastIndex; index += 1) {
        const selected = selectable.get(index);
        if (selected === undefined) continue;
        if (selected.file !== first.file) return null;
        const separator = snippet === '' ? '' : '\n';
        const available = MAX_DIFF_COMMENT_SNIPPET - snippet.length - separator.length;
        if (available <= 0) break;
        snippet += separator + selected.text.slice(0, available);
        if (selected.text.length > available) break;
      }

      return { file: first.file, line: first.line, snippet };
    },
  };
}
