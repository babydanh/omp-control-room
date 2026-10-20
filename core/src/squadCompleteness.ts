/**
 * Completeness of a squad plan: pure checks on the proposed rows, shared by the server (which stores
 * the warnings on the proposal) and the webview (which re-checks rows as the user edits them). A
 * warning is advice only: it never blocks approval.
 */

/** Most warnings one plan reports; the rest are dropped. */
export const SQUAD_WARNINGS_MAX = 20;

/** The omp agent a row runs under when it names none: the default worker. */
export const SQUAD_DEFAULT_AGENT = 'task';

/** Read-only review agent every code-changing row should be checked by. */
const REVIEW_AGENT = 'reviewer';
/** Security review agent a risky row should be checked by. */
const SECURITY_AGENT = 'security-reviewer';
/** Mechanical work that needs no review. */
const EXEMPT_AGENT = 'sonic';

/** Assignee kind of a herdr pane: the pane runs the default worker, so a named subagent is a hint. */
const HERDR_KIND = 'herdr';

/** One row as the completeness check reads it. */
export interface CompletenessRow {
  readonly text: string;
  readonly acceptance?: string;
  /** The row's omp agent; undefined means the default worker. */
  readonly agent?: string;
  readonly areas?: readonly string[];
  /** The WorkItemAssignee kind the row goes to: herdr, session, new-session or auto. */
  readonly assigneeKind?: string;
  /** What the row waits for. Only `row` entries matter here; item dependencies are ignored. */
  readonly dependsOn: readonly { readonly kind: string; readonly row?: number }[];
}

/**
 * Risky topics a row may touch, with the label the warning names. The patterns are a hint for the
 * user, not a security analysis.
 */
const RISK_TOPICS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'auth', pattern: /auth|login|đăng nhập|mật khẩu|password|oauth|\bsso\b/i },
  { label: 'token', pattern: /token|jwt|api[ -]?key|secret|cookie|khóa bí mật/i },
  { label: 'SQL', pattern: /\bsql\b|query|truy vấn|database|migration/i },
  {
    label: 'đầu vào người dùng',
    pattern: /user input|input|form|upload|đầu vào|biểu mẫu|tải lên/i,
  },
  { label: 'đường dẫn file', pattern: /file path|đường dẫn|path traversal/i },
  { label: 'shell', pattern: /shell|exec|child_process|spawn|lệnh hệ thống/i },
];

/**
 * Warnings for a plan, in row order, each naming its row as #n (1-based). `readOnlyAgents` holds
 * the names of the agents that change no files; an agent outside it, or the default worker, counts
 * as code-changing unless it is the mechanical `sonic` agent.
 */
export function planCompleteness(
  rows: readonly CompletenessRow[],
  readOnlyAgents: ReadonlySet<string>,
): string[] {
  const warnings: string[] = [];
  rows.forEach((row, index) => {
    const label = `#${index + 1}`;
    const agent = row.agent ?? SQUAD_DEFAULT_AGENT;
    const changesCode = !readOnlyAgents.has(agent) && agent !== EXEMPT_AGENT;
    if (changesCode && !isReviewedBy(rows, index, REVIEW_AGENT)) {
      warnings.push(`Thiếu bước review cho ${label}`);
    }
    const topic = riskTopic(row);
    if (topic !== undefined && !isReviewedBy(rows, index, SECURITY_AGENT)) {
      warnings.push(`Nên có review bảo mật cho ${label} (đụng ${topic})`);
    }
    if ((row.acceptance ?? '').trim() === '') {
      warnings.push(`Thiếu tiêu chí nghiệm thu cho ${label}`);
    }
    if (row.assigneeKind === HERDR_KIND && agent !== SQUAD_DEFAULT_AGENT) {
      warnings.push(`Agent herdr: subagent chỉ là gợi ý (${label})`);
    }
  });
  return warnings.slice(0, SQUAD_WARNINGS_MAX);
}

/** Whether some row run by `agent` waits for the row at `index`. */
function isReviewedBy(rows: readonly CompletenessRow[], index: number, agent: string): boolean {
  for (const other of rows) {
    if ((other.agent ?? SQUAD_DEFAULT_AGENT) !== agent) continue;
    if (
      other.dependsOn.some((dependency) => dependency.kind === 'row' && dependency.row === index)
    ) {
      return true;
    }
  }
  return false;
}

/** The first risky topic the row's text or areas mention, or undefined. */
function riskTopic(row: CompletenessRow): string | undefined {
  const haystack = [row.text, ...(row.areas ?? [])].join('\n');
  return RISK_TOPICS.find((topic) => topic.pattern.test(haystack))?.label;
}
