/**
 * projectSyntax: a small per-line highlighter for the Thay đổi page. Diff hunks are
 * fragments, so a full parser cannot help; a token pass in the VS Code Dark+ style
 * (control keywords, declarations, strings, numbers, comments, calls, types,
 * variables, punctuation) makes code readable. A string or block comment that
 * spans lines is only coloured on the line it opens.
 */

export type SyntaxKind =
  | 'plain'
  | 'keyword'
  | 'storage'
  | 'string'
  | 'number'
  | 'comment'
  | 'function'
  | 'type'
  | 'variable'
  | 'punctuation';

export interface SyntaxToken {
  readonly text: string;
  readonly kind: SyntaxKind;
}

interface Language {
  /** Control flow: coloured like VS Code's pink keywords. */
  readonly keywords: ReadonlySet<string>;
  /** Declarations and constants: coloured like VS Code's blue keywords. */
  readonly storage: ReadonlySet<string>;
  readonly lineComment: string | null;
  readonly blockComment: boolean;
}

const words = (list: string): ReadonlySet<string> => new Set(list.split(' '));

const C_LIKE: Language = {
  keywords: words(
    'await break case catch continue default do else export finally for from if import in instanceof is of ' +
      'return switch throw try while with yield as delete new typeof',
  ),
  storage: words(
    'abstract async class const dynamic enum extends false final function get implements interface late let ' +
      'null override private protected public readonly required set static super this true type undefined var ' +
      'void package fn func struct impl mut pub use mod',
  ),
  lineComment: '//',
  blockComment: true,
};
const PYTHON: Language = {
  keywords: words('assert await break continue del elif else except finally for from if import in is not or and pass raise return try while with yield'),
  storage: words('async class def False global lambda None nonlocal self True'),
  lineComment: '#',
  blockComment: false,
};
const HASH_COMMENTED: Language = {
  keywords: words('if then else elif fi for in do done while case esac return'),
  storage: words('function export local true false null yes no on off'),
  lineComment: '#',
  blockComment: false,
};
const JSON_LIKE: Language = { keywords: words(''), storage: words('true false null'), lineComment: null, blockComment: false };

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, Language>> = {
  ts: C_LIKE, tsx: C_LIKE, js: C_LIKE, jsx: C_LIKE, mjs: C_LIKE, cjs: C_LIKE, dart: C_LIKE, java: C_LIKE,
  kt: C_LIKE, cs: C_LIKE, go: C_LIKE, rs: C_LIKE, c: C_LIKE, h: C_LIKE, cpp: C_LIKE, swift: C_LIKE,
  css: C_LIKE, scss: C_LIKE, sql: C_LIKE,
  py: PYTHON,
  sh: HASH_COMMENTED, bash: HASH_COMMENTED, ps1: HASH_COMMENTED, yaml: HASH_COMMENTED, yml: HASH_COMMENTED,
  toml: HASH_COMMENTED, env: HASH_COMMENTED,
  json: JSON_LIKE,
};

const patterns = new Map<Language, RegExp>();

function patternFor(language: Language): RegExp {
  const cached = patterns.get(language);
  if (cached !== undefined) return cached;
  const comment = [
    language.blockComment ? String.raw`\/\*.*?(?:\*\/|$)` : null,
    language.lineComment === null ? null : `${language.lineComment.replace(/[/#]/g, (char) => `\\${char}`)}.*$`,
  ].filter((part): part is string => part !== null);
  const source = [
    comment.length > 0 ? `(?<comment>${comment.join('|')})` : null,
    String.raw`(?<string>"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|` + '`(?:\\\\.|[^`\\\\])*`?)',
    String.raw`(?<number>\b(?:0x[0-9a-fA-F]+|\d[\d_]*(?:\.\d+)?)\b)`,
    String.raw`(?<word>[A-Za-z_$][\w$]*)`,
    // `/` and `#` stay out of punctuation runs so `);//` still opens a comment.
    String.raw`(?<punctuation>[^\w\s$'"/#` + '`' + String.raw`]+)`,
  ].filter((part): part is string => part !== null).join('|');
  const pattern = new RegExp(source, 'g');
  patterns.set(language, pattern);
  return pattern;
}

function extensionOf(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? '';
  if (name.startsWith('.env')) return 'env';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Splits one line of `filePath` into coloured tokens; unknown file types come back as one plain token. */
export function highlightLine(text: string, filePath: string): SyntaxToken[] {
  const extension = extensionOf(filePath);
  if (extension === 'md') return [{ text, kind: /^#{1,6}\s/.test(text) ? 'keyword' : 'plain' }];
  const language = LANGUAGE_BY_EXTENSION[extension];
  if (language === undefined || text === '') return [{ text, kind: 'plain' }];
  const pattern = patternFor(language);
  const tokens: SyntaxToken[] = [];
  let cursor = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match[0] === '') {
      pattern.lastIndex += 1;
      continue;
    }
    if (match.index > cursor) tokens.push({ text: text.slice(cursor, match.index), kind: 'plain' });
    const end = match.index + match[0].length;
    tokens.push({ text: match[0], kind: kindOf(match.groups ?? {}, language, text.slice(end)) });
    cursor = end;
  }
  if (cursor < text.length) tokens.push({ text: text.slice(cursor), kind: 'plain' });
  return tokens;
}

function kindOf(groups: Record<string, string | undefined>, language: Language, rest: string): SyntaxKind {
  if (groups.comment !== undefined) return 'comment';
  if (groups.string !== undefined) return 'string';
  if (groups.number !== undefined) return 'number';
  if (groups.punctuation !== undefined) return 'punctuation';
  const word = groups.word ?? '';
  if (language.keywords.has(word)) return 'keyword';
  if (language.storage.has(word)) return 'storage';
  if (/^\s*(?:<[^>]*>)?\s*\(/.test(rest)) return 'function';
  if (/^[A-Z][a-z0-9]/.test(word)) return 'type';
  return 'variable';
}
