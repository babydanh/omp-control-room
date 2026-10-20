/**
 * SquadPlanRow: one row of a squad proposal in the drawer, editable. The row names the repo, role,
 * subagent (read-only agents are marked), code areas, assignee, priority and acceptance it will run
 * with, and says what it waits for. Every value is sent as the user left it; the drawer checks the
 * whole plan and shows its warnings.
 */

import type {
  CompanyRole,
  OmpAgentInfo,
  SquadDependency,
  WorkItem,
  WorkItemAssignee,
} from '../../../../core/src/messages.js';
import { SQUAD_DEFAULT_AGENT } from '../../../../core/src/squadCompleteness.js';
import { priorityLabel } from '../../../../core/src/workItemGraph.js';
import { assigneeKeyOf, type AssigneeOption, AUTO_ASSIGNEE } from '../assigneeOptions.js';
import type { CompanyViewState } from '../companyState.js';
import { companyRoleLabel } from '../roleProfiles.js';
import {
  agentChipOf,
  agentOptionLabel,
  READ_ONLY_MARK,
  repoChipLabel,
  ROOT_REPO_LABEL,
} from '../squadPlanCheck.js';
import { waitReasonText } from '../squadPlanLayers.js';
import { PRIORITY_CHOICES, proposalRowDepsOptions, type SquadDraftRow } from '../squadView.js';
import { assigneeLabel, AUTO_ASSIGNEE_LABEL, WORK_ITEM_ROLES } from '../workItemView.js';
import { CompanyButton } from './CompanyButton.js';

/** The fields one edit may set on a draft row; the rest of the row stays as it was. */
export type SquadRowChange = Partial<Omit<SquadDraftRow, 'key' | 'dependsOn'>>;

export interface SquadPlanRowProps {
  row: SquadDraftRow;
  /** The row's 0-based place in the proposal; a wait names rows by it. */
  index: number;
  rows: readonly SquadDraftRow[];
  openItems: readonly WorkItem[];
  repos: readonly string[];
  agents: readonly OmpAgentInfo[];
  options: readonly AssigneeOption[];
  state: CompanyViewState;
  workspacePath: string;
  pending: boolean;
  onChange: (change: SquadRowChange) => void;
  onRemove: () => void;
  onToggleWait: (dependency: SquadDependency) => void;
}

const FIELD_CLASS =
  'min-w-0 max-w-full rounded-(--company-radius-sm) bg-well px-2 py-1 text-xs text-text disabled:text-text-muted';

const TEXT_FIELD_CLASS =
  'w-full min-w-0 rounded-(--company-radius-sm) bg-well px-2 py-1.5 text-xs text-text disabled:text-text-muted';

/** One row of a proposal: its text, where it runs, how it is set up, and what it waits for. */
export function SquadPlanRow({
  row,
  index,
  rows,
  openItems,
  repos,
  agents,
  options,
  state,
  workspacePath,
  pending,
  onChange,
  onRemove,
  onToggleWait,
}: SquadPlanRowProps) {
  const number = index + 1;
  const agent = agentChipOf(row.agent, agents);
  const repoMissing = row.repo !== null && !repos.includes(row.repo);
  const roles: readonly CompanyRole[] =
    row.role !== null && !WORK_ITEM_ROLES.includes(row.role)
      ? [...WORK_ITEM_ROLES, row.role]
      : WORK_ITEM_ROLES;
  const reason = waitReasonText(row.dependsOn);
  const waits = proposalRowDepsOptions(rows, index, openItems);
  return (
    <li
      data-testid="squad-plan-row"
      className="flex min-w-0 flex-col gap-1.5 rounded-(--company-radius-sm) bg-raised p-2"
    >
      <textarea
        aria-label={`Nội dung dòng ${number}`}
        rows={2}
        value={row.text}
        disabled={pending}
        onChange={(event) => onChange({ text: event.target.value })}
        className="w-full min-w-0 resize-y rounded-(--company-radius-sm) bg-well px-2 py-1.5 text-xs text-text disabled:text-text-muted"
      />
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <select
          aria-label={`Repo dòng ${number}`}
          value={row.repo ?? ''}
          disabled={pending}
          onChange={(event) =>
            onChange({ repo: event.target.value === '' ? null : event.target.value })
          }
          className={FIELD_CLASS}
        >
          <option value="">{ROOT_REPO_LABEL}</option>
          {repos.map((path) => (
            <option key={path} value={path} title={path}>
              {repoChipLabel(path)}
            </option>
          ))}
          {repoMissing && row.repo !== null ? (
            <option value={row.repo} title={row.repo}>
              {repoChipLabel(row.repo)} (không còn trong thư mục)
            </option>
          ) : null}
        </select>
        <select
          aria-label={`Vai dòng ${number}`}
          value={row.role ?? ''}
          disabled={pending}
          onChange={(event) =>
            onChange({
              role: event.target.value === '' ? null : (event.target.value as CompanyRole),
            })
          }
          className={FIELD_CLASS}
        >
          <option value="">Không chọn vai</option>
          {roles.map((choice) => (
            <option key={choice} value={choice}>
              {companyRoleLabel(choice)}
            </option>
          ))}
        </select>
        <select
          aria-label={`Subagent dòng ${number}`}
          value={row.agent}
          disabled={pending}
          onChange={(event) => onChange({ agent: event.target.value })}
          className={FIELD_CLASS}
        >
          <option value="">{`Mặc định (${SQUAD_DEFAULT_AGENT})`}</option>
          {agents.map((entry) => (
            <option key={entry.name} value={entry.name} title={entry.description}>
              {agentOptionLabel(entry)}
            </option>
          ))}
          {agent.missing ? (
            <option value={row.agent}>{row.agent} (không còn trong thư mục)</option>
          ) : null}
        </select>
        {agent.readOnly ? (
          <span className="shrink-0 rounded-full bg-well px-1.5 text-2xs text-text-muted">
            {READ_ONLY_MARK}
          </span>
        ) : null}
        <AssigneeSelect
          label={`Giao dòng ${number}`}
          assignee={row.assignee}
          options={options}
          state={state}
          workspacePath={workspacePath}
          disabled={pending}
          onChange={(assignee) => onChange({ assignee })}
        />
        <select
          aria-label={`Độ ưu tiên dòng ${number}`}
          value={String(row.priority)}
          disabled={pending}
          onChange={(event) => onChange({ priority: Number(event.target.value) })}
          className="rounded-(--company-radius-sm) bg-well px-2 py-1 text-xs text-text disabled:text-text-muted"
        >
          {PRIORITY_CHOICES.map((choice) => (
            <option key={choice} value={String(choice)}>
              {priorityLabel(choice)}
            </option>
          ))}
        </select>
        <CompanyButton size="sm" disabled={pending} onClick={onRemove}>
          Bỏ dòng
        </CompanyButton>
      </div>
      <input
        type="text"
        aria-label={`Vùng code dòng ${number}`}
        placeholder="vd: auth, billing"
        value={row.areas}
        disabled={pending}
        onChange={(event) => onChange({ areas: event.target.value })}
        className={TEXT_FIELD_CLASS}
      />
      <input
        type="text"
        aria-label={`Xong khi dòng ${number}`}
        placeholder="Xong khi… (không bắt buộc)"
        value={row.acceptance}
        disabled={pending}
        onChange={(event) => onChange({ acceptance: event.target.value })}
        className={TEXT_FIELD_CLASS}
      />
      {reason !== null ? <p className="text-2xs text-text-muted">{reason}</p> : null}
      <div
        role="group"
        aria-label={`Chờ việc, dòng ${number}`}
        className="flex min-w-0 flex-wrap gap-1"
      >
        {waits.length === 0 ? (
          <p className="text-2xs text-text-muted">Không có việc nào để chờ.</p>
        ) : (
          waits.map((option) => (
            <button
              key={option.key}
              type="button"
              aria-pressed={option.selected}
              disabled={pending}
              onClick={() => onToggleWait(option.dependency)}
              className={`touch-target max-w-full truncate rounded-(--company-radius-sm) px-2 py-1 text-left text-2xs disabled:cursor-default ${option.selected ? 'company-selected text-text' : 'bg-well text-text-muted hover:bg-hover'}`}
            >
              {option.label}
            </button>
          ))
        )}
      </div>
    </li>
  );
}

interface AssigneeSelectProps {
  label: string;
  assignee: WorkItemAssignee | null;
  options: readonly AssigneeOption[];
  state: CompanyViewState;
  workspacePath: string;
  disabled: boolean;
  onChange: (assignee: WorkItemAssignee) => void;
}

/** The key of the option that leaves the agent to be picked when the item runs. */
const AUTO_KEY = assigneeKeyOf(AUTO_ASSIGNEE);

/**
 * The row's assignee: auto-pick, or a member picked from the folder's agents and sessions in the same
 * groups the assign dialog uses. A holder the folder no longer lists stays visible, marked as gone,
 * until replaced.
 */
function AssigneeSelect({
  label,
  assignee,
  options,
  state,
  workspacePath,
  disabled,
  onChange,
}: AssigneeSelectProps) {
  const value = assignee === null ? '' : assigneeKeyOf(assignee);
  const listed = value === AUTO_KEY || options.some((option) => option.key === value);
  const herdrRows = options.filter((option) => option.group === 'herdr');
  const sessionRows = options.filter((option) => option.group === 'session');
  const newRows = options.filter((option) => option.group === 'new');
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => {
        if (event.target.value === AUTO_KEY) {
          onChange(AUTO_ASSIGNEE);
          return;
        }
        const picked = options.find((option) => option.key === event.target.value);
        if (picked !== undefined) onChange(picked.assignee);
      }}
      className="min-w-0 max-w-full rounded-(--company-radius-sm) bg-well px-2 py-1 text-xs text-text disabled:text-text-muted"
    >
      {assignee === null && (
        <option value="" disabled>
          Chọn người nhận
        </option>
      )}
      {assignee !== null && !listed && (
        <option value={value} disabled>
          {assigneeLabel(assignee, state, workspacePath)} (không còn trong thư mục)
        </option>
      )}
      <option value={AUTO_KEY}>{AUTO_ASSIGNEE_LABEL}</option>
      {herdrRows.length > 0 && (
        <optgroup label="Agent herdr">
          {herdrRows.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </optgroup>
      )}
      {sessionRows.length > 0 && (
        <optgroup label="Phiên omp">
          {sessionRows.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </optgroup>
      )}
      {newRows.map((option) => (
        <option key={option.key} value={option.key}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
