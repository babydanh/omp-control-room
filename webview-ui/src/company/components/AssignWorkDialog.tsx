/**
 * AssignWorkDialog: gives a piece of work to an agent. The parent sends the command and reads its
 * verdict; this dialog only gathers the text, the assignee and, when new work is filed, its
 * schedule: priority, acceptance and the open items it waits for. A fixed assignee is named rather
 * than picked, and a text that may not change is shown read-only (reassigning a work item keeps
 * its text and schedule). Escape closes the dialog; Ctrl/Cmd+Enter submits it.
 */

import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import type { WorkItem, WorkItemAssignee } from '../../../../core/src/messages.js';
import {
  priorityLabel,
  WORK_ITEM_ACCEPTANCE_MAX_CHARS,
  WORK_ITEM_DEPENDS_MAX,
  WORK_ITEM_PRIORITY_DEFAULT,
} from '../../../../core/src/workItemGraph.js';
import { assigneeKeyOf, type AssigneeOption } from '../assigneeOptions.js';
import type { WorkItemCreateOptions } from '../companyMessages.js';
import { openItemsOf, PRIORITY_CHOICES, waitItemLabel } from '../squadView.js';
import { CompanyButton } from './CompanyButton.js';

/** What new work carries beyond its assignee and text. */
export interface AssignScheduling {
  /** Every item of the folder; the wait list offers the open ones, by #n. */
  openItems: readonly WorkItem[];
}

export interface AssignWorkDialogProps {
  title: string;
  submitLabel: string;
  initialText: string;
  /** False when the text is fixed: it is then shown read-only. */
  textEditable: boolean;
  /** When set, the assignee is named rather than picked, and no picker is shown. */
  fixedAssignee?: WorkItemAssignee;
  /** Preselected in the picker when it is among the options. */
  currentAssignee?: WorkItemAssignee;
  options: AssigneeOption[];
  /**
   * Set when new work is filed: the dialog then offers priority, acceptance and a wait list. A
   * reassignment leaves it unset, so the item keeps its own schedule.
   */
  scheduling?: AssignScheduling;
  /** True while the parent waits for the server's verdict; the submit is then disabled. */
  pending?: boolean;
  /** The reason the last submit was refused, shown in the dialog; null when there is none. */
  notice?: string | null;
  /** Sends the assignee and text, and the schedule when the dialog offered one. */
  onSubmit(assignee: WorkItemAssignee, text: string, options?: WorkItemCreateOptions): void;
  onClose(): void;
}

const NO_AGENT_TEXT = 'Chưa có agent nào trong thư mục này. Mở agent herdr hoặc bấm Phiên mới.';

export function AssignWorkDialog({
  title,
  submitLabel,
  initialText,
  textEditable,
  fixedAssignee,
  currentAssignee,
  options,
  scheduling,
  pending = false,
  notice = null,
  onSubmit,
  onClose,
}: AssignWorkDialogProps) {
  const [text, setText] = useState(initialText);
  const [selectedKey, setSelectedKey] = useState<string | null>(() =>
    currentAssignee === undefined ? null : assigneeKeyOf(currentAssignee),
  );
  const [priority, setPriority] = useState<number>(WORK_ITEM_PRIORITY_DEFAULT);
  const [acceptance, setAcceptance] = useState('');
  const [waitIds, setWaitIds] = useState<string[]>([]);
  const [opener] = useState<Element | null>(() => document.activeElement);
  const dialogRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const trimmed = text.trim();
  const picked = options.find((option) => option.key === selectedKey) ?? null;
  const assignee: WorkItemAssignee | null = fixedAssignee ?? picked?.assignee ?? null;
  const waitItems: WorkItem[] = scheduling === undefined ? [] : openItemsOf(scheduling.openItems);
  // Only ids the folder still holds as open items can be waited for; a closed one is dropped.
  const dependsOn = waitIds.filter((id) => waitItems.some((item) => item.id === id));
  const acceptanceText = acceptance.trim();
  const acceptanceTooLong = Array.from(acceptanceText).length > WORK_ITEM_ACCEPTANCE_MAX_CHARS;
  const canSubmit = trimmed !== '' && assignee !== null && !pending && !acceptanceTooLong;

  // The text takes the focus when it can change; otherwise the dialog does, so Escape reaches it.
  useEffect(() => {
    if (textEditable) {
      textRef.current?.focus();
    } else {
      dialogRef.current?.focus();
    }
  }, [textEditable]);

  // Focus goes back to the control that opened the dialog.
  useEffect(() => {
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [opener]);

  function submit(): void {
    if (assignee === null || !canSubmit) return;
    if (scheduling === undefined) {
      onSubmit(assignee, trimmed);
      return;
    }
    onSubmit(assignee, trimmed, {
      priority,
      acceptance: acceptanceText === '' ? undefined : acceptanceText,
      dependsOn,
    });
  }

  function toggleWait(id: string): void {
    setWaitIds((current) => {
      if (current.includes(id)) return current.filter((entry) => entry !== id);
      return current.length >= WORK_ITEM_DEPENDS_MAX ? current : [...current, id];
    });
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  }

  function onFormSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    submit();
  }

  const herdrRows = options.filter((option) => option.group === 'herdr');
  const sessionRows = options.filter((option) => option.group === 'session');
  const newRows = options.filter((option) => option.group === 'new');
  const groups = [
    { heading: 'Agent herdr', rows: herdrRows },
    { heading: 'Phiên omp', rows: sessionRows },
  ].filter((group) => group.rows.length > 0);
  const hasAgents = herdrRows.length + sessionRows.length > 0;

  const renderRow = (option: AssigneeOption) => {
    const selected = option.key === selectedKey;
    return (
      <button
        key={option.key}
        type="button"
        aria-pressed={selected}
        disabled={pending}
        onClick={() => setSelectedKey(option.key)}
        className={`touch-target flex min-w-0 items-center justify-between gap-2 rounded-(--company-radius-sm) px-2 py-1.5 text-left text-xs disabled:cursor-default ${selected ? 'company-selected text-text' : 'text-text-muted hover:bg-hover'}`}
      >
        <span className="min-w-0 truncate text-text">{option.label}</span>
        {option.detail === undefined ? null : (
          <span className="min-w-0 truncate text-2xs text-text-muted">{option.detail}</span>
        )}
      </button>
    );
  };

  const dialog = (
    <div className="company-ui">
      <div className="fixed inset-0 z-40 flex items-center justify-center">
        <button
          type="button"
          aria-label="Đóng hộp thoại giao việc"
          onClick={onClose}
          className="absolute inset-0 cursor-default bg-black/40"
        />
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="assign-work-title"
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="relative flex max-h-[88vh] w-[min(420px,92vw)] flex-col gap-3 overflow-hidden rounded-(--company-radius-md) bg-panel p-3 text-xs text-text max-md:w-full max-md:rounded-none"
        >
          <h2 id="assign-work-title" className="text-sm text-text">
            {title}
          </h2>
          <form onSubmit={onFormSubmit} className="flex min-h-0 flex-col gap-3">
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
              {textEditable ? (
                <label className="flex flex-col gap-1 text-text-muted">
                  Nội dung việc
                  <textarea
                    ref={textRef}
                    value={text}
                    rows={4}
                    disabled={pending}
                    onChange={(event) => setText(event.target.value)}
                    className="resize-y rounded-(--company-radius-sm) bg-well px-2 py-1.5 text-xs text-text disabled:text-text-muted"
                  />
                </label>
              ) : (
                <div className="flex flex-col gap-1 text-text-muted">
                  Nội dung việc
                  <p className="max-h-40 overflow-y-auto rounded-(--company-radius-sm) bg-well px-2 py-1.5 whitespace-pre-wrap break-words text-text">
                    {text}
                  </p>
                </div>
              )}
              {fixedAssignee === undefined ? (
                <div className="flex min-h-0 flex-col gap-1">
                  <p id="assign-work-picker" className="text-text-muted">
                    Giao cho
                  </p>
                  <div
                    role="group"
                    aria-labelledby="assign-work-picker"
                    className="flex max-h-56 flex-col gap-2 overflow-y-auto"
                  >
                    {hasAgents ? null : <p className="px-2 text-text-muted">{NO_AGENT_TEXT}</p>}
                    {groups.map((group) => (
                      <div key={group.heading} className="flex flex-col gap-0.5">
                        <p className="px-2 text-2xs text-text-muted">{group.heading}</p>
                        {group.rows.map(renderRow)}
                      </div>
                    ))}
                    <div className="flex flex-col gap-0.5">{newRows.map(renderRow)}</div>
                  </div>
                </div>
              ) : null}
              {scheduling === undefined ? null : (
                <>
                  <div className="flex flex-col gap-1">
                    <p id="assign-work-priority" className="text-text-muted">
                      Độ ưu tiên
                    </p>
                    <div
                      role="group"
                      aria-labelledby="assign-work-priority"
                      className="flex flex-wrap gap-1.5"
                    >
                      {PRIORITY_CHOICES.map((choice) => {
                        const selected = priority === choice;
                        return (
                          <button
                            key={choice}
                            type="button"
                            aria-pressed={selected}
                            disabled={pending}
                            onClick={() => setPriority(choice)}
                            className={`touch-target min-w-12 rounded-(--company-radius-sm) px-2 py-1 text-xs disabled:cursor-default ${selected ? 'company-selected text-text' : 'bg-well text-text-muted hover:bg-hover'}`}
                          >
                            {priorityLabel(choice)}
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-2xs text-text-muted">P0 làm trước. Mặc định P2.</p>
                  </div>
                  <label className="flex flex-col gap-1 text-text-muted">
                    Xong khi…
                    <textarea
                      value={acceptance}
                      rows={2}
                      disabled={pending}
                      placeholder="Không bắt buộc"
                      onChange={(event) => setAcceptance(event.target.value)}
                      className="resize-y rounded-(--company-radius-sm) bg-well px-2 py-1.5 text-xs text-text disabled:text-text-muted"
                    />
                  </label>
                  {acceptanceTooLong ? (
                    <p role="alert" className="text-danger">
                      Xong khi dài quá {WORK_ITEM_ACCEPTANCE_MAX_CHARS} ký tự.
                    </p>
                  ) : null}
                  <div className="flex min-h-0 flex-col gap-1">
                    <p id="assign-work-waits" className="text-text-muted">
                      Chờ việc…
                    </p>
                    <div
                      role="group"
                      aria-labelledby="assign-work-waits"
                      className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto"
                    >
                      {waitItems.length === 0 ? (
                        <p className="px-2 text-text-muted">Chưa có việc nào đang mở để chờ.</p>
                      ) : null}
                      {waitItems.map((item) => {
                        const selected = dependsOn.includes(item.id);
                        const full = !selected && dependsOn.length >= WORK_ITEM_DEPENDS_MAX;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            aria-pressed={selected}
                            disabled={pending || full}
                            onClick={() => toggleWait(item.id)}
                            className={`touch-target max-w-full truncate rounded-(--company-radius-sm) px-2 py-1 text-left text-2xs disabled:cursor-default ${selected ? 'company-selected text-text' : 'bg-well text-text-muted hover:bg-hover'}`}
                          >
                            {waitItemLabel(item)}
                          </button>
                        );
                      })}
                    </div>
                    {dependsOn.length >= WORK_ITEM_DEPENDS_MAX ? (
                      <p className="text-2xs text-text-muted">
                        Chờ tối đa {WORK_ITEM_DEPENDS_MAX} việc.
                      </p>
                    ) : null}
                  </div>
                </>
              )}
              {notice ? (
                <p role="alert" className="text-danger">
                  {notice}
                </p>
              ) : null}
            </div>
            <div className="flex justify-end gap-1">
              <CompanyButton type="button" size="sm" onClick={onClose}>
                Huỷ
              </CompanyButton>
              <CompanyButton type="submit" size="sm" variant="accent" disabled={!canSubmit}>
                {submitLabel}
              </CompanyButton>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
  return createPortal(dialog, document.body);
}
