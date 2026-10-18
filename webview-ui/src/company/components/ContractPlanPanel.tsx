import type { Contract, VerificationEvidence } from '../../../../core/src/company.js';
import { buildContractPlanView, type ContractPlanView } from '../contractPlanView.js';
import { contractStatusLabel, taskStatusLabel } from '../statusLabels.js';
import { CompanyButton } from './CompanyButton.js';

/**
 * ContractPlanPanel: the plan the user reads BEFORE approving.
 *
 * It shows the goals in the user's own words, the phases in order, each task
 * with its dependencies and the exact paths it may write, and the acceptance
 * criteria with their evidence state. When the plan has a hole, the approve
 * button is disabled and the gap is spelled out — the user is not asked to
 * approve something the panel cannot justify.
 */

export interface ContractPlanPanelProps {
  contract: Contract;
  /** Criterion -> verification command ids, as the Contract declares them. */
  commandsByCriterion?: ReadonlyMap<string, readonly string[]>;
  evidence?: readonly VerificationEvidence[];
  onApprove?: (revision: number) => void;
  onReject?: (revision: number) => void;
}

const ACCEPTANCE_LABEL: Record<ContractPlanView['acceptance'][number]['state'], string> = {
  passed: 'đạt',
  failed: 'thất bại',
  not_run: 'chưa chạy',
};

export function ContractPlanPanel({
  contract,
  commandsByCriterion,
  evidence,
  onApprove,
  onReject,
}: ContractPlanPanelProps) {
  const view = buildContractPlanView(contract, commandsByCriterion, evidence);

  return (
    <div className="flex flex-col gap-3 p-3 overflow-y-auto" data-testid="contract-plan">
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm text-text-primary">
          {view.code} &middot; bản sửa {view.revision}
        </h2>
        <span className="text-xs text-text-muted">{contractStatusLabel(view.status)}</span>
      </header>

      <dl className="grid grid-cols-3 gap-2 text-xs text-text-muted">
        <div>
          <dt>Mục tiêu</dt>
          <dd className="text-text-primary">
            {view.summary.coveredRequirementCount}/{view.summary.requirementCount} đã lên kế hoạch
          </dd>
        </div>
        <div>
          <dt>Nhiệm vụ</dt>
          <dd className="text-text-primary">{view.summary.taskCount}</dd>
        </div>
        <div>
          <dt>Phạm vi ghi</dt>
          <dd className="text-text-primary">{view.summary.scopeCount}</dd>
        </div>
      </dl>

      <section aria-label="Mục tiêu">
        <h3 className="mb-1 text-xs font-semibold text-text-muted">Điều bạn đã yêu cầu</h3>
        <ul className="flex flex-col gap-1 text-sm">
          {view.goals.map((goal) => (
            <li key={goal.id} className="flex items-start gap-2">
              <span aria-hidden="true" className={goal.covered ? 'text-accent' : 'text-warning'}>
                {goal.covered ? '[x]' : '[ ]'}
              </span>
              <span className="text-text-primary">{goal.text}</span>
              {goal.taskCodes.length > 0 && (
                <span className="text-xs text-text-muted">({goal.taskCodes.join(', ')})</span>
              )}
            </li>
          ))}
        </ul>
      </section>

      {view.phases.map((phase) => (
        <section key={phase.id} aria-label={`Giai đoạn ${phase.ordinal}`}>
          <h3 className="mb-1 text-xs font-semibold text-text-muted">
            {phase.ordinal}. {phase.title}
          </h3>
          <ul className="flex flex-col gap-2">
            {phase.tasks.map((task) => (
              <li key={task.code} className="rounded-(--company-radius-md) p-2">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-text-primary">
                    <span className="text-text-muted">{task.code}</span> {task.title}
                  </span>
                  <span className="text-xs text-text-muted">{taskStatusLabel(task.status)}</span>
                </div>
                {task.writeScopes.length > 0 && (
                  <p className="mt-1 text-xs text-text-muted">
                    ghi: <span className="text-text-primary">{task.writeScopes.join(', ')}</span>
                  </p>
                )}
                {task.readScopes.length > 0 && (
                  <p className="text-xs text-text-muted">
                    đọc: <span className="text-text-primary">{task.readScopes.join(', ')}</span>
                  </p>
                )}
                {task.dependsOnCodes.length > 0 && (
                  <p className="text-xs text-text-muted">sau: {task.dependsOnCodes.join(', ')}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {view.acceptance.length > 0 && (
        <section aria-label="Tiêu chí nghiệm thu">
          <h3 className="mb-1 text-xs font-semibold text-text-muted">
            Cách chúng ta biết nó đã hoàn thành
          </h3>
          <ul className="flex flex-col gap-1 text-sm">
            {view.acceptance.map((criterion) => (
              <li key={criterion.id} className="flex items-baseline gap-2">
                <span
                  className={
                    criterion.state === 'passed'
                      ? 'text-accent'
                      : criterion.state === 'failed'
                        ? 'text-warning'
                        : 'text-text-muted'
                  }
                >
                  {ACCEPTANCE_LABEL[criterion.state]}
                </span>
                <span className="text-text-primary">{criterion.description}</span>
                {criterion.required && <span className="text-xs text-text-muted">bắt buộc</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {!view.canApprove && (
        <section
          aria-label="Vì sao chưa thể phê duyệt"
          className="rounded-(--company-radius-md) bg-warning/12 p-2"
        >
          <h3 className="mb-1 text-xs font-semibold text-warning">Chưa sẵn sàng phê duyệt</h3>
          <ul className="list-inside list-disc text-sm text-text-primary">
            {view.approvalBlockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </section>
      )}

      {onApprove !== undefined && onReject !== undefined && (
        <footer className="flex gap-2">
          <CompanyButton
            variant="accent"
            disabled={!view.canApprove}
            onClick={() => onApprove(view.revision)}
          >
            Duyệt và chạy
          </CompanyButton>
          <CompanyButton onClick={() => onReject(view.revision)}>Từ chối</CompanyButton>
        </footer>
      )}
    </div>
  );
}
