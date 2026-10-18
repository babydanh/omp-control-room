/**
 * TaskReport: the report for a task's current contract revision. A report
 * written against an older revision is not shown as this revision's report.
 */

import type { CompanyViewState } from '../companyState.js';
import { ReportPanel } from './ReportPanel.js';

export interface TaskReportProps {
  state: CompanyViewState;
  taskId: string | null;
  onOpenArtifact: (artifactId: string) => void;
}

export function TaskReport({ state, taskId, onOpenArtifact }: TaskReportProps) {
  const task = taskId === null ? undefined : state.tasks[taskId];
  const contract = task ? state.contracts[task.contractId] : undefined;
  const report =
    contract === undefined
      ? undefined
      : Object.values(state.reports).find(
          (entry) => entry.contractId === contract.id && entry.revision === contract.revision,
        );
  if (contract === undefined || report === undefined) {
    return (
      <p className="p-2 text-2xs text-text-muted">Chưa có báo cáo cho bản sửa hợp đồng này.</p>
    );
  }
  return (
    <ReportPanel
      report={report}
      contract={contract}
      evidence={state.evidence}
      onOpenArtifact={onOpenArtifact}
    />
  );
}
