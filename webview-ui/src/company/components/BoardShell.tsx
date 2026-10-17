/**
 * BoardShell: the whole app -- a full-screen board for Company runs on OMP.
 *
 * Top to bottom, in the order a user needs it:
 *
 *  1. Where the board points and how the company is doing (BoardTopBar).
 *  2. Which model each role runs on (RoleStrip).
 *  3. What is waiting on the user: a Contract to approve, questions to answer
 *     (AttentionBar). These are the only things that unblock the company.
 *  4. The seven lanes, with the detail pane beside them for whatever is open.
 *  5. The composer, always mounted.
 *
 * Everything shown came from a server message. When a revision gap is open the
 * board says so instead of quietly showing stale cards.
 */

import { useEffect, useMemo, useState } from 'react';

import { boardFlow, buildBoardLanes } from '../boardView.js';
import type { CompanyClient } from '../companyClient.js';
import { pendingContract, selectionForTask } from '../selection.js';
import { useCompanyState } from '../useCompanyState.js';
import { AttentionBar } from './AttentionBar.js';
import { type BoardPane, BoardTopBar } from './BoardTopBar.js';
import { CardDetail, type DetailFocus } from './CardDetail.js';
import { CompanyBoard } from './CompanyBoard.js';
import { PromptComposer } from './PromptComposer.js';
import { RoleStrip } from './RoleStrip.js';

export interface BoardShellProps {
  client: CompanyClient;
}

export function BoardShell({ client }: BoardShellProps) {
  const state = useCompanyState(client);
  const [focus, setFocus] = useState<DetailFocus | null>(null);
  const [artifactId, setArtifactId] = useState<string | null>(null);

  const lanes = useMemo(() => buildBoardLanes(state), [state]);
  const pendingQuestions = useMemo(
    () => Object.values(state.questions).filter((question) => question.status === 'pending'),
    [state.questions],
  );
  const selectedTaskId = state.selection.taskId;
  const card = lanes.flatMap((lane) => lane.cards).find((entry) => entry.taskId === selectedTaskId);

  // Diagnostics are a live measurement of processes the user owns: asked for
  // once the board is on screen, never polled in the background.
  useEffect(() => {
    client.requestDiagnostics();
  }, [client]);

  const togglePane = (pane: BoardPane) => setFocus((current) => (current === pane ? null : pane));

  return (
    <div
      className="company-ui flex h-full w-full flex-col overflow-hidden bg-bg"
      data-testid="company-workspace"
    >
      <BoardTopBar
        state={state}
        pane={typeof focus === 'string' ? focus : null}
        onTogglePane={togglePane}
      />
      <RoleStrip profiles={state.settings?.roleProfiles ?? {}} />
      {state.needsSnapshot && (
        <p className="border-b-2 border-warning px-3 py-1 text-2xs text-warning">
          Có thay đổi đã bị bỏ sót; đang chờ một bản chụp mới từ máy chủ.
        </p>
      )}
      <AttentionBar
        contract={pendingContract(state)}
        questions={pendingQuestions}
        onOpenContract={() => setFocus({ kind: 'contract' })}
        onOpenQuestion={(id) => setFocus({ kind: 'question', id })}
      />
      <div className="flex min-h-0 flex-1">
        <CompanyBoard
          lanes={lanes}
          flow={boardFlow(lanes, state.settings?.maxWorkers ?? null)}
          onSelectTask={(taskId) => {
            setFocus(null);
            client.select(selectionForTask(state, taskId));
          }}
        />
        <CardDetail
          client={client}
          state={state}
          focus={focus}
          card={card ?? null}
          artifactId={artifactId}
          onOpenArtifact={(id) => {
            setArtifactId(id);
            setFocus('files');
          }}
          onClearArtifact={() => setArtifactId(null)}
          onShowSelection={() => setFocus(null)}
          onClose={() => {
            setFocus(null);
            client.select({ sessionId: null, taskId: null, tab: null });
          }}
        />
      </div>
      <PromptComposer client={client} />
    </div>
  );
}
