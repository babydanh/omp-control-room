/**
 * PromptComposer: ONE box, shaped like OMP's own composer.
 *
 * There is exactly one input: a textarea that takes a prompt or one of OMP's
 * `/` commands, and nothing else. The four controls that used to sit above it
 * are gone because OMP has no equivalent of any of them, and each one had a
 * rule to move into the box instead:
 *
 *  - Role. OMP's box names no role. The company borrows the role of the
 *    session the box is pointed at, and falls back to the director when
 *    nothing is selected.
 *  - Model. Moved into the box as OMP's own `/model` and `/switch`
 *    (builtin-modes.ts:451-543), with the completion and the wording ported in
 *    `slashCommands.ts`.
 *  - Delivery. OMP decides it from the session instead of asking: a streaming
 *    session steers and an idle one starts a turn
 *    (input-controller.ts:1216-1233). Ctrl+Enter is the follow-up path
 *    (input-controller.ts:1851-1860). Those two keys cover all three
 *    deliveries the wire allows.
 *  - Attach. OMP's box carries an image picker that the company bridge cannot
 *    reach, so the affordance is gone rather than faked.
 *
 * Dispatch is OMP's, rule for rule: `resolveSlashCommand` decides whether a
 * draft is a command at all, and a command this box cannot execute itself is
 * sent to the model as the literal text typed — which is what OMP does for
 * text its own dispatcher declines (input-controller.ts:1071-1081).
 */

import { type ChangeEvent, type KeyboardEvent, useEffect, useMemo, useState } from 'react';

import type { CompanyModelCatalogEntry, CompanyRole } from '../../../../core/src/company.js';
import { Button } from '../../components/ui/Button.js';
import type { CompanyClient } from '../companyClient.js';
import { isSubmitChord, promptBlockReason } from '../promptSubmission.js';
import { companyRoleLabel, withRoleModel } from '../roleProfiles.js';
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

/** Session states in which OMP steers rather than starting a new turn. */
const BUSY_STATUSES: readonly string[] = ['busy', 'running', 'starting'];

/** A row in the completion popup. */
type CompletionRow =
  | { kind: 'command'; command: OmpSlashCommand; insert: string }
  | { kind: 'model'; completion: ArgumentCompletion; insert: string };

export interface PromptComposerProps {
  client: CompanyClient;
}

export function PromptComposer({ client }: PromptComposerProps) {
  const state = useCompanyState(client);
  const draft = state.prompt;
  const [notice, setNotice] = useState<string | null>(null);
  /** Which command opened the catalog picker, for OMP's own echo wording. */
  const [picker, setPicker] = useState<OmpSlashCommand | null>(null);
  const [highlight, setHighlight] = useState(0);

  const selectedSession =
    state.selection.sessionId === null ? null : (state.sessions[state.selection.sessionId] ?? null);
  const role: CompanyRole = selectedSession?.role ?? 'director';
  const selectedModel = selectedSession?.requestedModel ?? state.selectedModel;
  const busy = draft.pendingSubmit !== null;
  const blocker = promptBlockReason(draft);

  // The catalog is a request, not an assumption: without it `/model` cannot
  // offer a single model. Asked once per mount, never polled.
  useEffect(() => {
    if (state.modelCatalog.length === 0) client.requestModelCatalog();
  }, [client, state.modelCatalog.length]);

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
    client.setModel(entry.id);
    const outcome = client.updateRoleProfiles(
      withRoleModel(state.settings?.roleProfiles ?? {}, role, entry.id),
    );
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
    if (args === '') {
      // OMP opens the Model Hub here and the picker for `/switch`; the company
      // has neither dashboard, so both open the one catalog picker.
      setPicker(command);
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

  const submitPrompt = (delivery: 'prompt' | 'steer' | 'follow_up') => {
    client.setDraftDelivery(delivery);
    const outcome = client.submitPrompt();
    setNotice(outcome.ok ? null : (outcome.message ?? outcome.errorCode ?? 'Chưa gửi được.'));
  };

  const onSubmitKey = () => {
    if (resolved !== null && runModelCommand(resolved.command, resolved.parsed.args)) return;
    const steering =
      selectedSession !== null && BUSY_STATUSES.includes(selectedSession.status)
        ? 'steer'
        : 'prompt';
    submitPrompt(steering);
  };

  const accept = (row: CompletionRow) => {
    setHighlight(0);
    setNotice(null);
    client.setDraftText(row.insert);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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
    // OMP sends Ctrl+Enter down the follow-up path, which never dispatches a
    // slash command (input-controller.ts:1851-1860).
    if (isSubmitChord(event)) {
      event.preventDefault();
      submitPrompt('follow_up');
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

  return (
    <section className="border-t-2 border-border bg-bg p-2" data-testid="prompt-composer">
      {rows.length > 0 && (
        <ul
          className="mb-1 max-h-40 overflow-auto border-2 border-border"
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

      {picker !== null && (
        <ul
          className="mb-1 max-h-40 overflow-auto border-2 border-border"
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
                  applyModel(entry, picker);
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

      <textarea
        value={draft.text}
        onChange={onChange}
        onKeyDown={onKeyDown}
        rows={4}
        placeholder="Hãy bảo công ty cần xây dựng gì. / để gõ lệnh, Ctrl+Enter để gửi tiếp."
        data-testid="prompt-input"
        className="w-full border-2 border-border bg-bg-dark p-2 text-sm text-text"
      />

      <p className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-text-muted">
        <span>{modelLabel}</span>
        {selectedSession !== null && <span>vai trò {companyRoleLabel(selectedSession.role)}</span>}
        <span>Ctrl+Enter để gửi tiếp</span>
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

      <div className="mt-2 flex items-center gap-2">
        <span className="flex-1" />
        <Button
          size="sm"
          variant="accent"
          disabled={blocker !== null || busy || picker !== null}
          onClick={onSubmitKey}
        >
          {busy ? 'Đang gửi...' : 'Gửi'}
        </Button>
      </div>
      {blocker !== null && draft.text.trim().length > 0 && (
        <p className="mt-1 text-2xs text-text-muted">{blocker}</p>
      )}
    </section>
  );
}
