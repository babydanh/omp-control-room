/**
 * AttemptRow: one run of a task -- what it changed and the evidence the server
 * holds for it. Evidence the server has not sent yet reads as "chưa tới", never
 * as a pass.
 */

import type { Attempt, VerificationEvidence } from '../../../../core/src/company.js';
import { attemptStatusLabel, changeKindLabel } from '../statusLabels.js';

export interface AttemptRowProps {
  attempt: Attempt;
  evidence: Record<string, VerificationEvidence>;
  onOpenArtifact: (artifactId: string) => void;
}

export function AttemptRow({ attempt, evidence, onOpenArtifact }: AttemptRowProps) {
  return (
    <div className="rounded-(--company-radius-md) p-2">
      <p className="text-2xs text-text">
        lượt chạy {attempt.id.slice(0, 8)} &middot; {attemptStatusLabel(attempt.status)}
        {attempt.error ? ` · ${attempt.error}` : ''}
      </p>
      {attempt.changes.map((change) => (
        <p key={change.path} className="text-2xs text-text-muted">
          {changeKindLabel(change.kind)} {change.path} — {change.summary}
          {change.diffArtifactId && (
            <button
              type="button"
              className="ml-2 cursor-pointer text-accent-bright"
              onClick={() => onOpenArtifact(change.diffArtifactId ?? '')}
            >
              khác biệt
            </button>
          )}
        </p>
      ))}
      {attempt.evidenceIds.map((evidenceId) => {
        const record = evidence[evidenceId];
        if (!record) {
          return (
            <p key={evidenceId} className="text-2xs text-text-muted">
              bằng chứng {evidenceId.slice(0, 8)} chưa tới
            </p>
          );
        }
        return (
          <p key={evidenceId} className="text-2xs text-text-muted">
            {record.command.executable} {record.command.argv.join(' ')} →{' '}
            {record.signal ? `tín hiệu ${record.signal}` : `mã thoát ${record.exitCode}`}
            {record.stdoutArtifactId && (
              <button
                type="button"
                className="ml-2 cursor-pointer text-accent-bright"
                onClick={() => onOpenArtifact(record.stdoutArtifactId ?? '')}
              >
                đầu ra
              </button>
            )}
            {record.stderrArtifactId && (
              <button
                type="button"
                className="ml-2 cursor-pointer text-accent-bright"
                onClick={() => onOpenArtifact(record.stderrArtifactId ?? '')}
              >
                đầu lỗi
              </button>
            )}
          </p>
        );
      })}
    </div>
  );
}
