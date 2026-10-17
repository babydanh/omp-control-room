/**
 * handoff: what survives when a session's process goes away.
 *
 * Parking a session disposes its PTY and stops it streaming, but its native
 * transcript is still on disk. The handoff is the OTHER half of that: a small,
 * provenance-rich packet written BEFORE the session is archived, so the next
 * session that picks the work up knows what the Contract asked for, what was
 * already decided, which files it touched, and what the last verification
 * actually said.
 *
 * Two rules shape the packet:
 *
 *  - BOUNDED. Every list is capped and every text field is truncated on grapheme
 *    boundaries, with the dropped counts reported rather than silently applied. A
 *    handoff is read by a model with a finite context; an unbounded one would
 *    evict the very facts it was meant to preserve.
 *  - NO TRANSCRIPT. There is deliberately no parameter for a transcript, a
 *    terminal dump or another session's history. The builder's input is a list
 *    of records the caller selected, and the packet references evidence by
 *    artifact id so the bytes stay on disk where they were fetched deliberately.
 */

import type {
  Attempt,
  CompanySession,
  Contract,
  RelatedWorkspaceFile,
  Requirement,
  Task,
  VerificationEvidence,
} from '../../../core/src/company.js';
import { CompanyError } from './companyError.js';

/**
 * Per-field ceilings for one handoff. Overflow is counted in
 * {@link SessionHandoff.truncated}, so a bounded packet is never silently a
 * lossy one.
 */
export const HANDOFF_LIMITS = {
  requirements: 12,
  tasks: 12,
  refs: 24,
  decisions: 12,
  evidence: 8,
  failures: 6,
  text: 600,
} as const;

/** Hard ceiling on the serialized packet. Exceeding it is an error, not a truncation. */
export const HANDOFF_MAX_BYTES = 64 * 1024;

export interface HandoffInput {
  readonly session: CompanySession;
  readonly contract?: Contract;
  readonly requirements?: readonly Requirement[];
  /** Tasks this session carried; other workstreams' tasks are not its business. */
  readonly tasks?: readonly Task[];
  readonly decisions?: readonly string[];
  readonly evidence?: readonly VerificationEvidence[];
  readonly attempts?: readonly Attempt[];
  /** Exact file/symbol references the next session should open first. */
  readonly refs?: readonly RelatedWorkspaceFile[];
  readonly nextAction: string;
  /** Provenance: the native entry the handoff was read up to. */
  readonly nativeEntryId?: string;
  readonly generatedAt: string;
}

export interface HandoffEvidence {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly passed: boolean;
  readonly criterionIds: readonly string[];
  /** Artifact references, never the captured bytes. */
  readonly stdoutArtifactId?: string;
  readonly stderrArtifactId?: string;
  readonly endedAt: string;
}

export interface HandoffFailure {
  readonly attemptId: string;
  readonly taskCode: string;
  readonly error: string;
  readonly evidenceIds: readonly string[];
  readonly endedAt: string;
}

export interface SessionHandoff {
  readonly version: 1;
  readonly source: {
    readonly sessionId: string;
    readonly sessionCode: string;
    readonly role: CompanySession['role'];
    readonly workstreamId: string;
    readonly runEpoch: number;
    readonly nativeSessionId?: string;
    readonly nativeSessionPath?: string;
    /** The native entry the handoff was read up to; absent when unknown. */
    readonly nativeEntryId?: string;
    readonly lastUsedAt: string;
  };
  readonly contract: {
    readonly id: string;
    readonly code: string;
    readonly revision: number;
  } | null;
  readonly requirements: readonly {
    readonly id: string;
    readonly text: string;
    readonly kind: Requirement['kind'];
    readonly status: Requirement['status'];
  }[];
  readonly tasks: readonly {
    readonly id: string;
    readonly code: string;
    readonly title: string;
    readonly status: Task['status'];
    readonly requirementIds: readonly string[];
    readonly writeScopes: Task['writeScopes'];
  }[];
  readonly refs: readonly RelatedWorkspaceFile[];
  readonly decisions: readonly string[];
  readonly evidence: readonly HandoffEvidence[];
  readonly failures: readonly HandoffFailure[];
  readonly nextAction: string;
  readonly truncated: {
    readonly requirements: number;
    readonly tasks: number;
    readonly refs: number;
    readonly decisions: number;
    readonly evidence: number;
    readonly failures: number;
  };
  readonly generatedAt: string;
}
/**
 * Grapheme-safe truncation; a cut emoji must not leave a lone surrogate. The
 * ellipsis is appended only when a segment was actually dropped: a short string
 * of wide graphemes can exceed the limit in UTF-16 units without reaching it in
 * graphemes, and marking that as cut would be a lie.
 */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let count = 0;
  let kept = '';
  for (const { segment } of segmenter.segment(text)) {
    if (count >= limit) return `${kept}…`;
    kept += segment;
    count += 1;
  }
  return kept;
}

function evidenceEntry(record: VerificationEvidence): HandoffEvidence {
  return {
    id: record.id,
    command: [record.command.executable, ...record.command.argv].join(' '),
    cwd: record.command.cwd,
    exitCode: record.exitCode,
    signal: record.signal,
    passed: record.exitCode === 0 && record.signal === undefined,
    criterionIds: record.criterionIds,
    stdoutArtifactId: record.stdoutArtifactId,
    stderrArtifactId: record.stderrArtifactId,
    endedAt: record.endedAt,
  };
}

/** An attempt only counts as a failure to hand over if it did not pass. */
function failureEntry(
  attempt: Attempt,
  taskCodes: ReadonlyMap<string, string>,
): HandoffFailure | null {
  if (attempt.status === 'passed' || attempt.status === 'running') return null;
  return {
    attemptId: attempt.id,
    taskCode: taskCodes.get(attempt.taskId) ?? attempt.taskId,
    error: truncate(attempt.error ?? attempt.status, HANDOFF_LIMITS.text),
    evidenceIds: attempt.evidenceIds,
    endedAt: attempt.endedAt ?? attempt.startedAt,
  };
}

/**
 * Build the packet a later session starts from. Newest evidence first, because
 * the most recent run is what tells the next session where the work actually
 * stopped; older passes are history and stay in the store.
 */
export function buildSessionHandoff(input: HandoffInput): SessionHandoff {
  const requirements = input.requirements ?? [];
  const tasks = input.tasks ?? [];
  const refs = input.refs ?? [];
  const decisions = input.decisions ?? [];
  const evidence = [...(input.evidence ?? [])].sort((left, right) =>
    left.endedAt === right.endedAt
      ? left.id.localeCompare(right.id)
      : left.endedAt < right.endedAt
        ? 1
        : -1,
  );
  const taskCodes = new Map(tasks.map((task) => [task.id, task.code]));
  const failures = (input.attempts ?? [])
    .map((attempt) => failureEntry(attempt, taskCodes))
    .filter((entry): entry is HandoffFailure => entry !== null);

  const handoff: SessionHandoff = {
    version: 1,
    source: {
      sessionId: input.session.id,
      sessionCode: input.session.code,
      role: input.session.role,
      workstreamId: input.session.workstreamId,
      runEpoch: input.session.runEpoch,
      nativeSessionId: input.session.nativeSessionId,
      nativeSessionPath: input.session.nativeSessionPath,
      nativeEntryId: input.nativeEntryId,
      lastUsedAt: input.session.lastUsedAt,
    },
    contract: input.contract
      ? { id: input.contract.id, code: input.contract.code, revision: input.contract.revision }
      : null,
    requirements: requirements.slice(0, HANDOFF_LIMITS.requirements).map((entry) => ({
      id: entry.id,
      text: truncate(entry.text, HANDOFF_LIMITS.text),
      kind: entry.kind,
      status: entry.status,
    })),
    tasks: tasks.slice(0, HANDOFF_LIMITS.tasks).map((task) => ({
      id: task.id,
      code: task.code,
      title: truncate(task.title, HANDOFF_LIMITS.text),
      status: task.status,
      requirementIds: task.requirementIds,
      writeScopes: task.writeScopes,
    })),
    refs: refs.slice(0, HANDOFF_LIMITS.refs),
    decisions: decisions
      .slice(0, HANDOFF_LIMITS.decisions)
      .map((entry) => truncate(entry, HANDOFF_LIMITS.text)),
    evidence: evidence.slice(0, HANDOFF_LIMITS.evidence).map(evidenceEntry),
    failures: failures.slice(0, HANDOFF_LIMITS.failures),
    nextAction: truncate(input.nextAction, HANDOFF_LIMITS.text),
    truncated: {
      requirements: Math.max(0, requirements.length - HANDOFF_LIMITS.requirements),
      tasks: Math.max(0, tasks.length - HANDOFF_LIMITS.tasks),
      refs: Math.max(0, refs.length - HANDOFF_LIMITS.refs),
      decisions: Math.max(0, decisions.length - HANDOFF_LIMITS.decisions),
      evidence: Math.max(0, evidence.length - HANDOFF_LIMITS.evidence),
      failures: Math.max(0, failures.length - HANDOFF_LIMITS.failures),
    },
    generatedAt: input.generatedAt,
  };

  const bytes = handoffByteLength(handoff);
  if (bytes > HANDOFF_MAX_BYTES) {
    throw new CompanyError(
      'company_handoff_too_large',
      `Handoff for ${handoff.source.sessionCode} serializes to ${bytes} bytes, over the ${HANDOFF_MAX_BYTES} byte limit.`,
    );
  }
  return handoff;
}

/** Serialized size in bytes, which is what the ceiling is measured against. */
export function handoffByteLength(handoff: SessionHandoff): number {
  return Buffer.byteLength(JSON.stringify(handoff), 'utf8');
}

/**
 * The text appended to a session's next turn. Deterministic by construction: no
 * clock, no dashboard value and no ordering that depends on the machine, so the
 * same handoff always renders the same block.
 */
export function renderHandoffText(handoff: SessionHandoff): string {
  const lines: string[] = [`Handoff from ${handoff.source.sessionCode} (${handoff.source.role})`];
  if (handoff.source.nativeSessionId)
    lines.push(`Native session: ${handoff.source.nativeSessionId}`);
  if (handoff.source.nativeEntryId) lines.push(`Read up to entry: ${handoff.source.nativeEntryId}`);
  if (handoff.contract) {
    lines.push(`Contract ${handoff.contract.code} revision ${handoff.contract.revision}`);
  }
  if (handoff.requirements.length > 0) {
    lines.push('Requirements:');
    for (const entry of handoff.requirements) {
      lines.push(`- [${entry.status}] ${entry.text}`);
    }
  }
  if (handoff.tasks.length > 0) {
    lines.push('Tasks:');
    for (const task of handoff.tasks) {
      lines.push(`- ${task.code} (${task.status}) ${task.title}`);
    }
  }
  if (handoff.refs.length > 0) {
    lines.push('References:');
    for (const ref of handoff.refs) {
      lines.push(`- ${ref.path} (${ref.relation})${ref.reason ? `: ${ref.reason}` : ''}`);
    }
  }
  if (handoff.decisions.length > 0) {
    lines.push('Decisions already taken:');
    for (const decision of handoff.decisions) lines.push(`- ${decision}`);
  }
  if (handoff.evidence.length > 0) {
    lines.push('Latest verification:');
    for (const record of handoff.evidence) {
      const verdict = record.passed ? 'passed' : `failed (${record.signal ?? record.exitCode})`;
      lines.push(`- ${record.command} [${verdict}]`);
    }
  }
  if (handoff.failures.length > 0) {
    lines.push('Outstanding failures:');
    for (const failure of handoff.failures) {
      lines.push(`- ${failure.taskCode}: ${failure.error}`);
    }
  }
  const dropped = Object.entries(handoff.truncated).filter(([, count]) => count > 0);
  if (dropped.length > 0) {
    lines.push(
      `Omitted for length: ${dropped.map(([field, count]) => `${count} ${field}`).join(', ')}. ` +
        'The full records remain in the company store.',
    );
  }
  lines.push(`Next action: ${handoff.nextAction}`);
  return lines.join('\n');
}
