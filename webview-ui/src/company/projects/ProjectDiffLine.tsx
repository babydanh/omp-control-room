import { useMemo } from 'react';

import type { NumberedDiffLine } from './projectDiffLines.js';
import { highlightLine, type SyntaxKind } from './projectSyntax.js';

const SYNTAX_CLASS: Readonly<Record<SyntaxKind, string>> = {
  plain: 'text-syntax-punctuation',
  keyword: 'text-syntax-keyword',
  storage: 'text-syntax-storage',
  string: 'text-syntax-string',
  number: 'text-syntax-number',
  comment: 'text-syntax-comment italic',
  function: 'text-syntax-function',
  type: 'text-syntax-type',
  variable: 'text-syntax-variable',
  punctuation: 'text-syntax-punctuation',
};
const LINE_CLASS: Readonly<Record<NumberedDiffLine['kind'], string>> = {
  addition: 'bg-status-success/15',
  deletion: 'bg-status-error/15',
  context: '',
  meta: 'bg-raised text-text-muted',
};
const MARK_CLASS: Readonly<Record<NumberedDiffLine['kind'], string>> = {
  addition: 'text-status-success',
  deletion: 'text-status-error',
  context: 'text-text-muted',
  meta: 'text-text-muted',
};

export function ProjectDiffLine({ line, filePath, onComment }: {
  line: NumberedDiffLine;
  filePath: string;
  onComment?: (line: number | null) => void;
}) {
  const tokens = useMemo(() => line.kind === 'meta' ? [{ text: line.text, kind: 'plain' as const }] : highlightLine(line.text, filePath), [line, filePath]);
  const numberClass = 'w-9 text-right text-text-muted hover:text-text disabled:invisible';
  return <div className={`flex whitespace-pre ${LINE_CLASS[line.kind]}`}>
    <span className="flex shrink-0 gap-1 border-r border-hairline pr-2">
      {onComment === undefined
        ? <><span className={numberClass}>{line.oldLine ?? ''}</span><span className={numberClass}>{line.newLine ?? ''}</span></>
        : <><button disabled={line.oldLine === null} className={numberClass} onClick={() => onComment(line.oldLine)}>{line.oldLine ?? ''}</button><button disabled={line.newLine === null} className={numberClass} onClick={() => onComment(line.newLine)}>{line.newLine ?? ''}</button></>}
    </span>
    <span className={`w-5 shrink-0 select-none text-center ${MARK_CLASS[line.kind]}`}>{line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '−' : ''}</span>
    <span className="pr-3 text-text">{tokens.map((token, index) => <span key={index} className={SYNTAX_CLASS[token.kind]}>{token.text}</span>)}</span>
  </div>;
}
