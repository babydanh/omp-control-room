/**
 * WorkDialogHost: the work dialogs an agent menu opens. The board mounts it, not the menu,
 * because the menu closes as soon as its item is chosen. Each dialog keeps its own pending state
 * and refusal notice, and closes when the server accepts the command.
 */

import { useState } from 'react';

import type { WorkItemAssignee } from '../../../../core/src/messages.js';
import type { AssigneeOption } from '../assigneeOptions.js';
import { failureNotice } from '../commandResults.js';
import type { CompanyClient, CompanyCommandHandle } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { roleDescriptionFor } from '../workItemView.js';
import { AssignWorkDialog } from './AssignWorkDialog.js';
import { RoleDescriptionDialog } from './RoleDescriptionDialog.js';

/** A dialog an agent menu asks the board to open. */
export type WorkDialogRequest =
  | { kind: 'assign'; workspacePath: string; assignee: WorkItemAssignee; label: string }
  | { kind: 'role'; workspacePath: string; agent: WorkItemAssignee; label: string };

type RoleRequest = Extract<WorkDialogRequest, { kind: 'role' }>;

const ASSIGN_FALLBACK = 'Chưa giao được việc.';
const ROLE_FALLBACK = 'Chưa lưu được mô tả vai trò.';

/**
 * Sends a dialog's command and follows it to its verdict: a refusal stays in the dialog as a
 * notice, and an accepted command runs `onAccepted`. `pending` holds while the verdict is awaited.
 */
function useCommandDialog(client: CompanyClient, onAccepted: () => void) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(handle: CompanyCommandHandle, fallback: string): Promise<void> {
    const refused = failureNotice(handle, fallback);
    if (refused !== null) {
      setNotice(refused);
      return;
    }
    setPending(true);
    setNotice(null);
    const verdict = await client.waitForCommand(handle);
    setPending(false);
    if (verdict.ok) {
      onAccepted();
      return;
    }
    setNotice(failureNotice(verdict, fallback));
  }

  return { pending, notice, run };
}

export interface CreateWorkDialogProps {
  client: CompanyClient;
  /** The folder the new work item belongs to. */
  workspacePath: string;
  title: string;
  initialText: string;
  textEditable: boolean;
  fixedAssignee?: WorkItemAssignee;
  options: AssigneeOption[];
  /** Runs once the server accepts the work item. */
  onAccepted(): void;
  onClose(): void;
}

/** Gives new work to an agent: the assign dialog wired to the server's create command. */
export function CreateWorkDialog({
  client,
  workspacePath,
  title,
  initialText,
  textEditable,
  fixedAssignee,
  options,
  onAccepted,
  onClose,
}: CreateWorkDialogProps) {
  const { pending, notice, run } = useCommandDialog(client, onAccepted);
  return (
    <AssignWorkDialog
      title={title}
      submitLabel="Giao việc"
      initialText={initialText}
      textEditable={textEditable}
      fixedAssignee={fixedAssignee}
      options={options}
      pending={pending}
      notice={notice}
      onSubmit={(assignee, text) =>
        void run(client.createWorkItem(workspacePath, text, assignee), ASSIGN_FALLBACK)
      }
      onClose={onClose}
    />
  );
}

interface RoleWorkDialogProps {
  client: CompanyClient;
  state: CompanyViewState;
  request: RoleRequest;
  onClose(): void;
}

/** Edits an agent's role note, starting from the note the board holds when the dialog opens. */
function RoleWorkDialog({ client, state, request, onClose }: RoleWorkDialogProps) {
  const { pending, notice, run } = useCommandDialog(client, onClose);
  const [initialDescription] = useState(() =>
    roleDescriptionFor(state, request.workspacePath, request.agent),
  );
  return (
    <RoleDescriptionDialog
      label={request.label}
      workspacePath={request.workspacePath}
      agent={request.agent}
      initialDescription={initialDescription}
      pending={pending}
      notice={notice}
      onSave={(description) =>
        void run(
          client.setAgentRole(request.workspacePath, request.agent, description),
          ROLE_FALLBACK,
        )
      }
      onClose={onClose}
    />
  );
}

export interface WorkDialogHostProps {
  client: CompanyClient;
  state: CompanyViewState;
  request: WorkDialogRequest | null;
  onClose(): void;
}

/** Shows the dialog an agent menu asked for, or nothing. */
export function WorkDialogHost({ client, state, request, onClose }: WorkDialogHostProps) {
  if (request === null) return null;
  if (request.kind === 'assign') {
    return (
      <CreateWorkDialog
        client={client}
        workspacePath={request.workspacePath}
        title={`Giao việc cho ${request.label}`}
        initialText=""
        textEditable
        fixedAssignee={request.assignee}
        options={[]}
        onAccepted={onClose}
        onClose={onClose}
      />
    );
  }
  return <RoleWorkDialog client={client} state={state} request={request} onClose={onClose} />;
}
