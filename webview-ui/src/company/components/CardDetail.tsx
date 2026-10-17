/**
 * CardDetail: the right-hand pane of the board.
 *
 * It shows ONE thing, in this order: what the user explicitly opened (the
 * Contract to approve, a question, the sessions list, the workspace files),
 * otherwise the shared selection -- a task card and the session running it.
 * Closing the pane clears that, so the board gets its full width back.
 */

import type { ReactNode } from 'react';

import type { BoardCard } from '../boardView.js';
import { WAIT_REASON_LABELS } from '../boardView.js';
import type { CompanyClient } from '../companyClient.js';
import type { CompanyViewState } from '../companyState.js';
import { questionProvenance } from '../questionProvenance.js';
import { companyRoleLabel } from '../roleProfiles.js';
import { pendingContract, selectionForSession } from '../selection.js';
import { sessionStatusLabel, taskStatusLabel } from '../statusLabels.js';
import type { BoardPane } from './BoardTopBar.js';
import { ContractPanel } from './ContractPanel.js';
import { QuestionPanel } from './QuestionPanel.js';
import { SessionDrawer } from './SessionDrawer.js';
import { WorkspaceFileBrowser } from './WorkspaceFileBrowser.js';

/** What the user explicitly opened; null falls back to the selection. */
export type DetailFocus = { kind: 'contract' } | { kind: 'question'; id: string } | BoardPane;

export interface CardDetailProps {
  client: CompanyClient;
  state: CompanyViewState;
  focus: DetailFocus | null;
  card: BoardCard | null;
  artifactId: string | null;
  onOpenArtifact: (artifactId: string) => void;
  onClearArtifact: () => void;
  onClose: () => void;
}

function Pane({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <aside
      className="flex w-[440px] shrink-0 flex-col border-l-2 border-border bg-bg"
      data-testid="card-detail"
    >
      <header className="flex items-center justify-between gap-2 border-b-2 border-border px-3 py-2">
        <h2 className="truncate text-sm text-text">{title}</h2>
        <button type="button" className="cursor-pointer text-2xs text-text-muted" onClick={onClose}>
          đóng
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </aside>
  );
}

function SessionList({ client, state }: { client: CompanyClient; state: CompanyViewState }) {
  const sessions = Object.values(state.sessions);
  if (sessions.length === 0)
    return <p className="p-3 text-2xs text-text-muted">Chưa có phiên nào.</p>;
  return (
    <ul className="flex flex-col gap-1 p-2">
      {sessions.map((entry) => (
        <li key={entry.id}>
          <button
            type="button"
            className="w-full cursor-pointer border-2 border-border bg-bg-dark p-2 text-left text-2xs hover:border-accent"
            onClick={() => client.select(selectionForSession(state, entry.id))}
          >
            {entry.code} · {companyRoleLabel(entry.role)} · {sessionStatusLabel(entry.status)} ·{' '}
            {entry.effectiveModel ?? entry.requestedModel}
          </button>
        </li>
      ))}
    </ul>
  );
}

function TaskFacts({ card }: { card: BoardCard }) {
  return (
    <div className="flex flex-col gap-1 border-b-2 border-border p-3 text-2xs text-text-muted">
      <p className="uppercase tracking-wide">{taskStatusLabel(card.status)}</p>
      <p>
        {card.contractCode} · {card.phaseTitle}
      </p>
      {card.waitReason && (
        <p className="text-warning">
          {card.waitReason === 'blocked_by_dependencies'
            ? `${WAIT_REASON_LABELS[card.waitReason]} (${card.blockedByCodes.join(', ')})`
            : WAIT_REASON_LABELS[card.waitReason]}
        </p>
      )}
      {card.routeReason && <p className="italic">{card.routeReason}</p>}
      {card.session === null && <p>Chưa có phiên nào nhận việc này.</p>}
    </div>
  );
}

function FocusedContent({ client, state, focus, artifactId, onClearArtifact }: CardDetailProps) {
  if (focus === 'files') {
    return (
      <WorkspaceFileBrowser
        client={client}
        workspacePath={state.settings?.workspacePath ?? ''}
        artifactId={artifactId}
        onClearArtifact={onClearArtifact}
      />
    );
  }
  if (focus === 'sessions') return <SessionList client={client} state={state} />;
  if (focus?.kind === 'question') {
    const question = state.questions[focus.id];
    if (!question || question.status !== 'pending') {
      return <p className="p-3 text-2xs text-text-muted">Câu hỏi này đã được xử lý.</p>;
    }
    return (
      <div className="p-2">
        <QuestionPanel
          question={question}
          onAnswer={(input) => client.answerQuestion(input)}
          provenance={questionProvenance(state.streams[question.sessionId])}
        />
      </div>
    );
  }
  const contract = pendingContract(state);
  if (contract === null) {
    return <p className="p-3 text-2xs text-text-muted">Không còn kế hoạch nào chờ duyệt.</p>;
  }
  return (
    <ContractPanel
      contract={contract}
      verificationProfiles={state.settings?.verificationProfiles ?? {}}
      evidence={Object.values(state.evidence)}
      onApprove={(revision) => client.decideContract(contract.id, revision, 'approve')}
      onReject={(revision) => client.decideContract(contract.id, revision, 'reject')}
    />
  );
}

const FOCUS_TITLES: Record<BoardPane | 'contract' | 'question', string> = {
  sessions: 'Các phiên',
  files: 'Tệp trong workspace',
  contract: 'Kế hoạch chờ duyệt',
  question: 'Câu hỏi chờ trả lời',
};

export function CardDetail(props: CardDetailProps) {
  const { client, state, focus, card, onOpenArtifact, onClose } = props;
  if (focus !== null) {
    const title = FOCUS_TITLES[typeof focus === 'string' ? focus : focus.kind];
    return (
      <Pane title={title} onClose={onClose}>
        <FocusedContent {...props} />
      </Pane>
    );
  }
  const sessionId = state.selection.sessionId;
  if (card === null && sessionId === null) return null;
  const title = card
    ? `${card.code} · ${card.title}`
    : (state.sessions[sessionId ?? '']?.code ?? 'Phiên');
  return (
    <Pane title={title} onClose={onClose}>
      {card && <TaskFacts card={card} />}
      {sessionId !== null && (
        <SessionDrawer client={client} sessionId={sessionId} onOpenArtifact={onOpenArtifact} />
      )}
    </Pane>
  );
}
