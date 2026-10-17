/**
 * ReportPanel: what the company did, mapped back to what was asked.
 *
 * The shape is fixed on purpose: what you asked for, what was executed, what
 * changed, what proved it, and what the Advisor said. Every line points at
 * something the server holds -- a task, an attempt, an evidence record, a diff
 * artifact -- because a report that only says "done" cannot be checked against
 * the prompt that caused it.
 */

import type {
  CompanyReport,
  Contract,
  VerificationEvidence,
} from '../../../../core/src/company.js';
import { Button } from '../../components/ui/Button.js';
import { companyRoleLabel } from '../companyCharacters.js';
import {
  changeKindLabel,
  requirementOutcomeLabel,
  sessionStatusLabel,
} from '../statusLabels.js';

export interface ReportPanelProps {
  report: CompanyReport;
  contract: Contract | undefined;
  evidence: Record<string, VerificationEvidence>;
  onOpenArtifact: (artifactId: string) => void;
}

export function ReportPanel({ report, contract, evidence, onOpenArtifact }: ReportPanelProps) {
  const taskCode = (taskId: string) =>
    contract?.tasks.find((task) => task.id === taskId)?.code ?? taskId;

  return (
    <div className="flex flex-col gap-3 p-2 text-sm" data-testid="report-panel">
      <section aria-label="Điều bạn đã yêu cầu">
        <h3 className="mb-1 text-xs uppercase tracking-wide text-text-muted">
          Điều bạn đã yêu cầu
        </h3>
        <ul className="flex list-inside list-disc flex-col gap-1 text-text">
          {report.requirements.map((requirement) => {
            const source = contract?.requirements.find(
              (entry) => entry.id === requirement.requirementId,
            );
            return (
              <li key={requirement.requirementId}>
                <span>{source?.text ?? requirement.requirementId}</span>
                <span className="ml-2 text-2xs text-text-muted">
                  qua {requirement.taskIds.map(taskCode).join(', ') || 'không có nhiệm vụ'} &middot;
                  {requirementOutcomeLabel(requirement.result)}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-label="Thay đổi liên quan">
        <h3 className="mb-1 text-xs uppercase tracking-wide text-text-muted">Thay đổi liên quan</h3>
        {report.relatedChanges.length === 0 && (
          <p className="text-2xs text-text-muted">Không có tệp nào bị thay đổi.</p>
        )}
        <ul className="flex flex-col gap-1">
          {report.relatedChanges.map((change) => (
            <li key={change.path} className="flex flex-wrap items-baseline gap-2">
              <span className="text-accent-bright">{changeKindLabel(change.kind)}</span>
              <span className="text-text">{change.path}</span>
              <span className="text-2xs text-text-muted">{change.summary}</span>
              {change.diffArtifactId && (
                <Button size="sm" onClick={() => onOpenArtifact(change.diffArtifactId ?? '')}>
                  Khác biệt
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Bằng chứng kiểm chứng">
        <h3 className="mb-1 text-xs uppercase tracking-wide text-text-muted">
          Bằng chứng kiểm chứng
        </h3>
        {report.verificationEvidenceIds.length === 0 && (
          <p className="text-2xs text-text-muted">Chưa ghi nhận kiểm chứng nào.</p>
        )}
        <ul className="flex flex-col gap-1">
          {report.verificationEvidenceIds.map((evidenceId) => {
            const record = evidence[evidenceId];
            if (!record) {
              return (
                <li key={evidenceId} className="text-2xs text-text-muted">
                  bằng chứng {evidenceId} chưa tới
                </li>
              );
            }
            return (
              <li key={evidenceId} className="flex flex-wrap items-baseline gap-2">
                <span className="text-text">
                  {record.command.executable} {record.command.argv.join(' ')}
                </span>
                <span className={record.exitCode === 0 ? 'text-status-success' : 'text-warning'}>
                  {record.signal ? `tín hiệu ${record.signal}` : `mã thoát ${record.exitCode}`}
                </span>
                {record.stdoutArtifactId && (
                  <Button size="sm" onClick={() => onOpenArtifact(record.stdoutArtifactId ?? '')}>
                    đầu ra
                  </Button>
                )}
                {record.stderrArtifactId && (
                  <Button size="sm" onClick={() => onOpenArtifact(record.stderrArtifactId ?? '')}>
                    đầu lỗi
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-label="Ghi chú của cố vấn">
        <h3 className="mb-1 text-xs uppercase tracking-wide text-text-muted">Ghi chú của cố vấn</h3>
        {report.advisorNotes.length === 0 && (
          <p className="text-2xs text-text-muted">Không có ghi chú kiến trúc nào.</p>
        )}
        <ul className="flex list-inside list-disc flex-col gap-1 text-text">
          {report.advisorNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </section>

      <section aria-label="Các phiên và mô hình">
        <h3 className="mb-1 text-xs uppercase tracking-wide text-text-muted">Các phiên</h3>
        <ul className="flex flex-col gap-1">
          {report.sessions.map((session) => (
            <li key={session.sessionId} className="text-2xs text-text-muted">
              {session.sessionId} &middot; {companyRoleLabel(session.role)} &middot; kỳ{' '}
              {session.runEpoch} &middot;{' '}
              {session.effectiveModel ?? session.requestedModel} &middot;
              {sessionStatusLabel(session.status)}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
