/**
 * CompanyWorkspace: the company side of the app.
 *
 * One column, in the order a user needs it:
 *
 *  1. A Contract waiting for a decision, with its plan mounted in full. It is
 *     rendered ABOVE the board because it is the only thing that unblocks
 *     execution, and it is rendered through `ContractPlanPanel`, which refuses
 *     to offer approval for a plan it cannot justify.
 *  2. Questions the company is blocked on. Each is answered with the wire
 *     answer, including the epoch and digest it was asked with.
 *  3. The board lanes, or the workspace browser, depending on the view.
 *  4. The selected session's drawer -- whatever is selected, from either
 *     surface, because there is only one selection.
 *  5. The composer, always mounted.
 *
 * Everything it shows came from a server message. When a revision gap is open,
 * the header says so instead of quietly showing stale cards.
 */

import { useEffect, useMemo, useState } from 'react';

import type { CompanyModelCatalogEntry } from '../../../../core/src/company.js';
import { boardFlow, buildBoardLanes } from '../boardView.js';
import { companyRoleLabel } from '../companyCharacters.js';
import type { CompanyClient } from '../companyClient.js';
import { questionProvenance } from '../questionProvenance.js';
import { pendingContract, selectionForSession, selectionForTask } from '../selection.js';
import { sessionStatusLabel, WORKSPACE_VIEW_LABELS } from '../statusLabels.js';
import { useCompanyState } from '../useCompanyState.js';
import { CompanyBoard } from './CompanyBoard.js';
import { ContractPanel } from './ContractPanel.js';
import { PromptComposer } from './PromptComposer.js';
import { QuestionPanel } from './QuestionPanel.js';
import { SessionDrawer } from './SessionDrawer.js';
import { WorkspaceFileBrowser } from './WorkspaceFileBrowser.js';

export interface CompanyWorkspaceProps {
  client: CompanyClient;
  /**
   * False when the app renders the composer itself (narrow-window tab mode),
   * so exactly one composer is mounted at a time.
   */
  showComposer?: boolean;
}

type WorkspaceView = 'board' | 'files';

function CatalogStatus({ entries }: { entries: readonly CompanyModelCatalogEntry[] }) {
  if (entries.length === 0) {
    return <span className="text-text-muted">danh mục mô hình: chưa tải</span>;
  }
  const usable = entries.filter((entry) => entry.credentialsConfigured).length;
  return (
    <span className="text-text-muted">
      mô hình: {usable}/{entries.length} dùng được
    </span>
  );
}

export function CompanyWorkspace({ client, showComposer }: CompanyWorkspaceProps) {
  const state = useCompanyState(client);
  const [view, setView] = useState<WorkspaceView>('board');
  const [artifactId, setArtifactId] = useState<string | null>(null);

  const lanes = useMemo(() => buildBoardLanes(state), [state]);
  const contract = pendingContract(state);
  const pendingQuestions = useMemo(
    () => Object.values(state.questions).filter((question) => question.status === 'pending'),
    [state.questions],
  );
  const session = state.selection.sessionId;

  // Diagnostics are a live measurement of processes the user owns; they are
  // asked for while this panel is on screen and never polled in the background.
  useEffect(() => {
    client.requestDiagnostics();
  }, [client]);

  return (
    <aside
      className="company-ui flex h-full min-h-0 flex-col border-l-2 border-border bg-bg"
      data-testid="company-workspace"
    >
      <header className="flex items-center justify-between gap-2 border-b-2 border-border p-2">
        <h2 className="text-sm text-text">Công ty</h2>
        <div className="flex gap-1">
          {(['board', 'files'] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              onClick={() => setView(entry)}
              aria-current={view === entry}
              className={
                view === entry
                  ? 'cursor-pointer border-2 border-accent px-2 text-2xs text-text'
                  : 'cursor-pointer border-2 border-transparent px-2 text-2xs text-text-muted'
              }
            >
              {WORKSPACE_VIEW_LABELS[entry]}
            </button>
          ))}
        </div>
      </header>

      <p className="flex flex-wrap gap-2 px-2 py-1 text-2xs text-text-muted">
        <span>bản sửa {state.revision ?? '-'}</span>
        <CatalogStatus entries={state.modelCatalog} />
        {state.diagnostics && (
          <span>
            đang chạy {state.diagnostics.liveRunners}/{state.diagnostics.modelLeases} ·{' '}
            xếp hàng {state.diagnostics.queuedTasks} · giữ lại{' '}
            {state.diagnostics.retainedSessions}
          </span>
        )}
      </p>
      {state.needsSnapshot && (
        <p className="border-b-2 border-warning px-2 py-1 text-2xs text-warning">
          Có thay đổi đã bị bỏ sót; đang chờ một bản chụp mới từ máy chủ.
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {contract && (
          <div className="border-b-2 border-border">
            <ContractPanel
              contract={contract}
              verificationProfiles={state.settings?.verificationProfiles ?? {}}
              evidence={Object.values(state.evidence)}
              onApprove={(revision) => client.decideContract(contract.id, revision, 'approve')}
              onReject={(revision) => client.decideContract(contract.id, revision, 'reject')}
            />
          </div>
        )}

        {pendingQuestions.length > 0 && (
          <div className="flex flex-col gap-2 border-b-2 border-border p-2">
            {pendingQuestions.map((question) => (
              <QuestionPanel
                key={question.id}
                question={question}
                onAnswer={(input) => client.answerQuestion(input)}
                provenance={questionProvenance(state.streams[question.sessionId])}
              />
            ))}
          </div>
        )}

        {view === 'board' ? (
          <CompanyBoard
            lanes={lanes}
            flow={boardFlow(lanes, state.settings?.maxWorkers ?? null)}
            onSelectTask={(taskId) => client.select(selectionForTask(state, taskId))}
          />
        ) : (
          <WorkspaceFileBrowser
            client={client}
            workspacePath={state.settings?.workspacePath ?? ''}
            artifactId={artifactId}
            onClearArtifact={() => setArtifactId(null)}
          />
        )}

        {session !== null && (
          <div className="border-t-2 border-border">
            <div className="flex items-center justify-between p-2">
              <span className="text-xs uppercase tracking-wide text-text-muted">Phiên</span>
              <button
                type="button"
                className="cursor-pointer text-2xs text-text-muted"
                onClick={() => client.select({ sessionId: null, taskId: null })}
              >
                đóng
              </button>
            </div>
            <SessionDrawer
              client={client}
              sessionId={session}
              onOpenArtifact={(id) => {
                setArtifactId(id);
                setView('files');
              }}
            />
          </div>
        )}

        {session === null && (
          <div className="border-t-2 border-border p-2">
            <h3 className="mb-1 text-xs uppercase tracking-wide text-text-muted">Các phiên</h3>
            {Object.values(state.sessions).length === 0 && (
              <p className="text-2xs text-text-muted">Chưa có phiên nào.</p>
            )}
            <ul className="flex flex-col gap-1">
              {Object.values(state.sessions).map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="w-full cursor-pointer border-2 border-border bg-bg-dark p-2 text-left text-2xs hover:border-accent"
                    onClick={() => client.select(selectionForSession(state, entry.id))}
                  >
                    {entry.code} &middot; {companyRoleLabel(entry.role)} &middot;{' '}
                    {sessionStatusLabel(entry.status)} &middot;{' '}
                    {entry.effectiveModel ?? entry.requestedModel}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {(showComposer ?? true) && <PromptComposer client={client} />}
    </aside>
  );
}
