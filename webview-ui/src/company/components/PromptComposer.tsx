/**
 * PromptComposer: ONE box, shaped like OMP's own composer.
 *
 * The box takes a prompt or one of OMP's `/` commands. The key that sends it
 * decides where it goes, and the line above the box always names the target.
 * The rules live in `composerRouting.ts`:
 *
 *  - Enter, and the Send button: a chat prompt to the selected omp session. A
 *    busy session is steered (input-controller.ts:1216-1233). With no session
 *    selected, Enter opens a new omp chat, and `/new` clears the selection.
 *  - Ctrl/Cmd+Enter: a follow-up into the selected session, as OMP's Ctrl+Enter
 *    sends it (input-controller.ts:1851-1860). With no session selected it is a
 *    plain prompt.
 *  - Ctrl/Cmd+Shift+Enter, and the "Giao cho công ty" button: the Company
 *    workflow (Director, Contract, approval, workers). A selected Company session
 *    becomes the target; a plain omp chat never does.
 *  - Attach. OMP's box carries an image picker that the company bridge cannot
 *    reach, so the affordance is gone rather than faked.
 *
 * Commands: `/new` clears the selection and the draft. `/resume` opens a picker
 * over the omp sessions saved in this folder. `/model` and `/switch` run here.
 * Every other OMP command is typed into the selected session's terminal, so it
 * runs as the command OMP itself would run, not as text the model reads. Ctrl+Enter
 * and the Company route never dispatch a command; they send the text as a prompt.
 */

import {
  type ChangeEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { CompanyModelCatalogEntry, CompanyRole } from '../../../../core/src/company.js';
import type { OmpSessionEntry } from '../../../../core/src/messages.js';
import { failureNotice } from '../commandResults.js';
import type { CompanyClient } from '../companyClient.js';
import { composerInputHeight } from '../composerHeight.js';
import { composerStorage, readComposerHeight, writeComposerHeight } from '../composerPrefs.js';
import {
  chatRoute,
  companyRoute,
  followUpRoute,
  planComposerCommand,
  resumeListView,
  sendTargetLabel,
  startNewChat,
} from '../composerRouting.js';
import {
  isCompanyChord,
  isFollowUpChord,
  promptBlockReason,
  type PromptRoute,
} from '../promptSubmission.js';
import { thinkingForModel, withRoleModel } from '../roleProfiles.js';
import {
  type ArgumentCompletion,
  commandCompletionQuery,
  commandCompletions,
  matchModelSelector,
  modelCompletions,
  ompModelMessage,
  type OmpSlashCommand,
  resolveSlashCommand,
  slashArgumentPrefix,
} from '../slashCommands.js';
import { useCompanyState } from '../useCompanyState.js';
import { CompanyButton } from './CompanyButton.js';
import { OmpSessionPicker } from './OmpSessionPicker.js';

/** The notice `/new` shows: the next send opens a new omp chat. */
const NEW_CHAT_NOTICE = 'Phiên mới: lần gửi tới sẽ mở một phiên omp mới.';

/** The keys this box answers to, shown in the `?` tooltip beside the target line. */
const COMPOSER_HINTS =
  'Enter gửi tới phiên đang chọn · Shift+Enter xuống dòng · Ctrl+Enter để gửi tiếp · Ctrl+Shift+Enter để giao cho công ty · / để gõ lệnh';

/** A row in the completion popup. */
type CompletionRow =
  | { kind: 'command'; command: OmpSlashCommand; insert: string }
  | { kind: 'model'; completion: ArgumentCompletion; insert: string };

/** The popup open over the box: a model catalog, or the omp sessions saved in this folder. */
type ComposerPicker =
  { kind: 'model'; command: OmpSlashCommand } | { kind: 'resume'; requestId: string };

export interface PromptComposerProps {
  client: CompanyClient;
}

/** One line's height, the padding and border around it, and the height the text needs. */
interface BoxMetrics {
  rowPx: number;
  chromePx: number;
  fitPx: number;
}

/** A handle drag in progress: where the pointer began, the box's height then, its metrics. */
interface ResizeDrag {
  startY: number;
  startPx: number;
  metrics: BoxMetrics;
}

/**
 * Measure the box against its text. The box is set to `auto` first, so the text's own
 * height is what gets measured; the caller sets the height afterwards.
 */
function measureBox(el: HTMLTextAreaElement): BoxMetrics {
  el.style.height = 'auto';
  const style = getComputedStyle(el);
  const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  const chromePx = border + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  return { rowPx: parseFloat(style.lineHeight), chromePx, fitPx: el.scrollHeight + border };
}

/**
 * Size the composer's text box to its text: at least COMPOSER_MIN_ROWS rows, a row more for
 * each line up to COMPOSER_MAX_ROWS rows, where it scrolls. A height the user dragged the box
 * to is the floor it keeps.
 */
function fitTextarea(el: HTMLTextAreaElement | null, savedPx: number | null): void {
  if (el === null) return;
  const { rowPx, chromePx, fitPx } = measureBox(el);
  el.style.height = `${composerInputHeight(fitPx, rowPx, chromePx, savedPx)}px`;
}

export function PromptComposer({ client }: PromptComposerProps) {
  const state = useCompanyState(client);
  const draft = state.prompt;
  const [notice, setNotice] = useState<string | null>(null);
  /** The popup open over the box, if any. A model picker keeps the command that opened it. */
  const [picker, setPicker] = useState<ComposerPicker | null>(null);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** The height the user dragged the box to, or null when it has never been dragged. */
  const [savedHeight, setSavedHeight] = useState<number | null>(() =>
    readComposerHeight(composerStorage()),
  );
  const resizeRef = useRef<ResizeDrag | null>(null);

  const selectedSession =
    state.selection.sessionId === null ? null : (state.sessions[state.selection.sessionId] ?? null);
  const role: CompanyRole = selectedSession?.role ?? 'director';
  const selectedModel = selectedSession?.requestedModel ?? state.selectedModel;
  const busy = draft.pendingSubmit !== null;
  const blocker = promptBlockReason(draft);
  const modelCommand = picker?.kind === 'model' ? picker.command : null;
  const resumeRequest = picker?.kind === 'resume' ? picker.requestId : null;
  const resumeView =
    resumeRequest === null
      ? null
      : resumeListView(resumeRequest, state.ompSessions, state.commandResults[resumeRequest]);

  // The catalog is a request, not an assumption: without it `/model` cannot
  // offer a single model. Asked once per mount, never polled.
  useEffect(() => {
    if (state.modelCatalog.length === 0) client.requestModelCatalog();
  }, [client, state.modelCatalog.length]);

  // Grow the box with its text, never shorter than the height the user dragged it to.
  // Wrapping changes with the window width, so re-measure on resize too.
  useLayoutEffect(() => fitTextarea(inputRef.current, savedHeight), [draft.text, savedHeight]);
  useEffect(() => {
    const refit = () => fitTextarea(inputRef.current, savedHeight);
    window.addEventListener('resize', refit);
    return () => window.removeEventListener('resize', refit);
  }, [savedHeight]);

  // OMP's status line names the model as `provider/id`
  // (builtin-modes.ts:456-459). A model the server holds but this catalog does
  // not list is shown raw rather than guessed at.
  const modelEntry =
    selectedModel === null
      ? null
      : (state.modelCatalog.find((entry) => entry.id === selectedModel) ?? null);
  const modelLabel =
    selectedModel === null
      ? ompModelMessage('current', '')
      : ompModelMessage(
          'current',
          modelEntry === null ? selectedModel : `${modelEntry.provider}/${modelEntry.model}`,
        );

  const resolved = resolveSlashCommand(draft.text);

  const rows: readonly CompletionRow[] = useMemo(() => {
    // OMP completes a command name only while the first token is being typed,
    // and a model argument only for the one command that accepts arguments.
    const nameToken = commandCompletionQuery(draft.text);
    if (nameToken !== null) {
      return commandCompletions(nameToken).map((command) => ({
        kind: 'command' as const,
        command,
        insert: `/${command.name}${command.allowArgs ? ' ' : ''}`,
      }));
    }
    if (resolved === null || resolved.command.name !== 'switch') return [];
    const prefix = slashArgumentPrefix(draft.text);
    if (prefix === null) return [];
    return modelCompletions(prefix, state.modelCatalog).map((completion) => ({
      kind: 'model' as const,
      completion,
      insert: `/${resolved.command.name} ${completion.value}`,
    }));
  }, [draft.text, resolved, state.modelCatalog]);

  const active = rows.length === 0 ? 0 : Math.min(highlight, rows.length - 1);

  const applyModel = (entry: CompanyModelCatalogEntry, command: OmpSlashCommand) => {
    const profiles = state.settings?.roleProfiles ?? {};
    const thinking = thinkingForModel(entry.thinking, profiles[role]?.thinking);
    if (thinking === undefined) {
      setNotice(
        `${entry.id} không khai báo mức suy nghĩ nào nên công ty chưa dùng được model này.`,
      );
      return;
    }
    client.setModel(entry.id);
    const outcome = client.updateRoleProfiles(withRoleModel(profiles, role, entry.id, thinking));
    setNotice(
      outcome.ok
        ? ompModelMessage(
            command.name === 'switch' ? 'switched' : 'set',
            `${entry.provider}/${entry.model}`,
          )
        : (outcome.message ?? outcome.errorCode ?? 'Thay đổi mô hình đã bị từ chối.'),
    );
  };

  /**
   * Run `/model` and `/switch`, the two commands this box can carry out on its
   * own. Returns false when the draft is not one of them, which leaves the
   * caller to send the text as an ordinary prompt.
   */
  const runModelCommand = (command: OmpSlashCommand, args: string): boolean => {
    if (command.name !== 'model' && command.name !== 'switch') return false;
    if (args === '') {
      // OMP opens the Model Hub here and the picker for `/switch`; the company
      // has neither dashboard, so both open the one catalog picker.
      setPicker({ kind: 'model', command });
      client.setDraftText('');
      return true;
    }
    const entry = matchModelSelector(args, state.modelCatalog);
    if (entry === null) {
      setNotice(ompModelMessage('unknown', args));
      return true;
    }
    applyModel(entry, command);
    client.setDraftText('');
    return true;
  };

  /** Hand the draft to the client along a route, and show the reason when it does not go. */
  const send = (route: PromptRoute) => {
    const outcome = client.submitPrompt(route);
    setNotice(outcome.ok ? null : (outcome.message ?? outcome.errorCode ?? 'Chưa gửi được.'));
  };

  /**
   * Every other OMP command runs in the selected session itself. The bridge
   * hands prompts to OMP with command handling off, so `/compact` sent as a
   * prompt would be text for the model; typed into the session's terminal it is
   * the command, exactly as in OMP.
   */
  const runSessionCommand = () => {
    if (selectedSession === null) {
      setNotice('Chọn một phiên (bấm thẻ hoặc nút Phiên) để chạy lệnh này trong omp của phiên đó.');
      return;
    }
    const outcome = client.writeTerminal(
      selectedSession.id,
      selectedSession.runEpoch,
      `${draft.text.trim()}\r`,
    );
    if (!outcome.ok) {
      setNotice('Terminal của phiên chưa mở; mở tab Bảng điều khiển của phiên rồi gửi lại.');
      return;
    }
    setNotice(`Đã chạy ${draft.text.trim().split(/\s/)[0]} trong ${selectedSession.code}.`);
    client.setDraftText('');
  };

  /**
   * `/resume`: ask the server for the omp sessions saved in this folder, and show
   * them in a picker. The answer is matched to this request by its requestId.
   */
  const openResumePicker = () => {
    const handle = client.requestOmpSessions();
    if (!handle.ok) {
      setNotice(handle.message ?? handle.errorCode ?? 'Chưa tải được danh sách phiên.');
      return;
    }
    client.setDraftText('');
    setNotice(null);
    setPicker({ kind: 'resume', requestId: handle.requestId });
  };

  /**
   * Resume the saved session the picker chose. The board selects it once it is on
   * the board; a refusal, at send or in the verdict, is shown here.
   */
  const resumeEntry = (entry: OmpSessionEntry) => {
    setPicker(null);
    const handle = client.resumeSession(entry.file);
    if (!handle.ok) {
      setNotice(handle.message ?? handle.errorCode ?? 'Chưa mở được phiên.');
      return;
    }
    void client.waitForCommand(handle).then((verdict) => {
      if (!verdict.ok) setNotice(failureNotice(verdict, 'Chưa mở được phiên.'));
    });
  };

  /** Enter and the Send button: the command the draft names decides what happens. */
  const onSubmitKey = () => {
    const plan = planComposerCommand(draft.text);
    switch (plan.kind) {
      case 'new':
        startNewChat(client);
        setNotice(NEW_CHAT_NOTICE);
        return;
      case 'resume':
        openResumePicker();
        return;
      case 'command':
        if (!runModelCommand(plan.resolved.command, plan.resolved.parsed.args)) {
          runSessionCommand();
        }
        return;
      case 'prompt':
        send(chatRoute(selectedSession));
        return;
    }
  };

  const accept = (row: CompletionRow) => {
    setHighlight(0);
    setNotice(null);
    client.setDraftText(row.insert);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // While an IME is composing (Vietnamese Telex and similar), Enter only confirms a candidate.
    if (event.nativeEvent.isComposing) return;
    if (picker !== null && event.key === 'Escape') {
      event.preventDefault();
      setPicker(null);
      return;
    }
    if (rows.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlight((current) => (current + 1) % rows.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlight((current) => (current - 1 + rows.length) % rows.length);
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        const row = rows[active];
        if (row !== undefined) accept(row);
        return;
      }
    }
    // Ctrl/Cmd+Shift+Enter hands the prompt to the Company workflow. It never
    // dispatches a slash command: the text is sent as the prompt.
    if (isCompanyChord(event)) {
      event.preventDefault();
      send(companyRoute(selectedSession));
      return;
    }
    // OMP sends Ctrl+Enter down the follow-up path, which never dispatches a
    // slash command (input-controller.ts:1851-1860).
    if (isFollowUpChord(event)) {
      event.preventDefault();
      send(followUpRoute(selectedSession));
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      onSubmitKey();
    }
  };

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setHighlight(0);
    setPicker(null);
    setNotice(null);
    client.setDraftText(event.target.value);
  };

  const error = draft.error?.message ?? draft.error?.errorCode ?? null;

  // The handle on the box's top edge. Dragging up makes the box taller; the height is clamped
  // to the rows and to the text, and it is remembered when the drag ends.
  function startResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const el = inputRef.current;
    if (el === null) return;
    const startPx = el.getBoundingClientRect().height;
    const metrics = measureBox(el);
    el.style.height = `${startPx}px`;
    resizeRef.current = { startY: event.clientY, startPx, metrics };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = resizeRef.current;
    const el = inputRef.current;
    if (drag === null || el === null) return;
    const { rowPx, chromePx, fitPx } = drag.metrics;
    const wantedPx = drag.startPx + (drag.startY - event.clientY);
    el.style.height = `${composerInputHeight(fitPx, rowPx, chromePx, wantedPx)}px`;
  }

  function endResize(): void {
    const el = inputRef.current;
    if (resizeRef.current === null || el === null) return;
    resizeRef.current = null;
    rememberHeight(el);
  }

  // Arrow keys move the handle one row at a time, so the box can be sized without a mouse.
  function nudgeResize(event: KeyboardEvent<HTMLDivElement>): void {
    const el = inputRef.current;
    const step = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
    if (el === null || step === 0) return;
    event.preventDefault();
    const currentPx = el.getBoundingClientRect().height;
    const { rowPx, chromePx, fitPx } = measureBox(el);
    el.style.height = `${composerInputHeight(fitPx, rowPx, chromePx, currentPx + step * rowPx)}px`;
    rememberHeight(el);
  }

  /** Keep the box's current height as the floor it grows from, here and after a reload. */
  function rememberHeight(el: HTMLTextAreaElement): void {
    const px = Math.round(el.getBoundingClientRect().height);
    setSavedHeight(px);
    writeComposerHeight(composerStorage(), px);
  }

  return (
    <section className="border-t border-border bg-bg px-2 py-1" data-testid="prompt-composer">
      {rows.length > 0 && (
        <ul
          className="mb-1 max-h-40 overflow-auto rounded-[6px] border border-border"
          data-testid="prompt-completions"
        >
          {rows.map((row, index) => (
            <li key={row.insert}>
              <button
                type="button"
                onClick={() => accept(row)}
                className={`block w-full cursor-pointer px-2 py-1 text-left text-2xs ${
                  index === active ? 'bg-bg-dark text-text' : 'text-text-muted'
                }`}
              >
                {row.kind === 'command' ? (
                  <>
                    <span className="text-text">/{row.command.name}</span>
                    {row.command.inlineHint && <span> {row.command.inlineHint}</span>}
                    <span> &mdash; {row.command.description}</span>
                  </>
                ) : (
                  <>
                    <span className="text-text">{row.completion.label}</span>
                    <span> &mdash; {row.completion.description}</span>
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {modelCommand !== null && (
        <ul
          className="mb-1 max-h-40 overflow-auto rounded-[6px] border border-border"
          data-testid="model-picker"
        >
          {state.modelCatalog.length === 0 && (
            <li className="px-2 py-1 text-2xs text-text-muted">Danh mục mô hình đang trống.</li>
          )}
          {state.modelCatalog.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => {
                  applyModel(entry, modelCommand);
                  setPicker(null);
                }}
                className="block w-full cursor-pointer px-2 py-1 text-left text-2xs text-text-muted hover:text-text"
              >
                {entry.provider}/{entry.model} &mdash;{' '}
                {entry.credentialsConfigured
                  ? entry.id
                  : `${entry.id} (chưa có thông tin đăng nhập)`}
              </button>
            </li>
          ))}
        </ul>
      )}

      {resumeView !== null && <OmpSessionPicker view={resumeView} onChoose={resumeEntry} />}

      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Kéo để đổi chiều cao ô nhập"
        tabIndex={0}
        title="Kéo để đổi chiều cao · Mũi tên lên hoặc xuống để chỉnh"
        data-testid="prompt-resize"
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onKeyDown={nudgeResize}
        className="flex h-1.5 cursor-row-resize touch-none items-center justify-center focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      >
        <span aria-hidden="true" className="h-0.5 w-8 rounded-full bg-border" />
      </div>
      <div className="flex items-end gap-1.5">
        <textarea
          ref={inputRef}
          value={draft.text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="Nhập tin nhắn · / để gõ lệnh"
          aria-label="Tin nhắn"
          data-testid="prompt-input"
          className="min-w-0 flex-1 resize-none rounded-[6px] border border-border bg-bg-dark px-2 py-1 text-sm leading-5 text-text"
        />
        <CompanyButton
          size="sm"
          variant="default"
          className="shrink-0 whitespace-nowrap"
          disabled={blocker !== null || busy || picker !== null}
          onClick={() => send(companyRoute(selectedSession))}
        >
          Giao cho công ty
        </CompanyButton>
        <CompanyButton
          size="sm"
          variant="accent"
          className="shrink-0"
          disabled={blocker !== null || busy || picker !== null}
          onClick={onSubmitKey}
        >
          {busy ? 'Đang gửi...' : 'Gửi'}
        </CompanyButton>
      </div>
      <p className="mt-1 flex min-w-0 items-center gap-2 text-2xs text-text-muted">
        <span className="min-w-0 truncate" data-testid="prompt-target">
          {sendTargetLabel(selectedSession)}
        </span>
        <span className="min-w-0 truncate" title={modelLabel}>
          {modelLabel}
        </span>
        <span
          tabIndex={0}
          title={COMPOSER_HINTS}
          aria-label={COMPOSER_HINTS}
          className="ml-auto shrink-0 cursor-help rounded-full border border-border px-1.5"
        >
          ?
        </span>
      </p>
      {notice !== null && (
        <p className="mt-1 text-2xs text-warning" data-testid="prompt-notice">
          {notice}
        </p>
      )}
      {error !== null && (
        <p className="mt-1 text-2xs text-warning" data-testid="prompt-error">
          {error}
        </p>
      )}
      {blocker !== null && draft.text.trim().length > 0 && (
        <p className="mt-1 text-2xs text-text-muted">{blocker}</p>
      )}
    </section>
  );
}
