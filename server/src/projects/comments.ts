import type { ProjectCommentMessage, ProjectTreeNode } from '../../../core/src/messages.js';
import { ledgerPathKey } from '../ledger/ledgerPath.js';
import type { LedgerService } from '../ledger/ledgerService.js';
import { LibraryUserError } from '../library/libraryError.js';
import type { ProjectModuleDeps } from './services.js';

const MAX_COMMENT_LENGTH = 4_000;
const MAX_SNIPPET_LENGTH = 1_200;

export interface ProjectCommentServices {
  sendToBoardSession(sessionId: string, text: string): Promise<void>;
  sendToLedgerSession(sessionId: string, text: string): Promise<void>;
}

export function createProjectCommentServices(runtime: {
  readonly ledger: Pick<LedgerService, 'sendMessage'>;
  readonly sendBoardPrompt: (sessionId: string, text: string) => Promise<void>;
}): ProjectCommentServices {
  return {
    sendToBoardSession: runtime.sendBoardPrompt,
    sendToLedgerSession: async (sessionId, text) => {
      const outcome = await runtime.ledger.sendMessage(sessionId, text);
      if (!outcome.ok) throw new LibraryUserError(outcome.reason ?? 'Không gửi được nhận xét tới phiên.');
    },
  };
}

/** Deliver an anchored diff comment only to a session attached to the selected checkout. */
export async function sendProjectComment(
  request: ProjectCommentMessage,
  deps: ProjectModuleDeps<ProjectCommentServices>,
): Promise<void> {
  const content = request.content.trim();
  const snippet = request.snippet.slice(0, MAX_SNIPPET_LENGTH);
  if (!Number.isSafeInteger(request.line) || request.line < 1 || request.file.trim() === '' || content === '') {
    throw new LibraryUserError('Nội dung nhận xét không hợp lệ.');
  }
  if (content.length > MAX_COMMENT_LENGTH || snippet.trim().length > MAX_SNIPPET_LENGTH) {
    throw new LibraryUserError('Nhận xét quá dài.');
  }

  const { nodes } = await deps.loadTree();
  const checkout = nodes.find((node: ProjectTreeNode) =>
    node.kind === 'checkout' && node.path !== undefined && ledgerPathKey(node.path) === ledgerPathKey(request.checkout),
  );
  if (checkout === undefined) throw new LibraryUserError('Worktree này không có trong cây Project.');
  const recipient = nodes.find((node: ProjectTreeNode) =>
    node.kind === 'session' && node.parentId === checkout.id && node.sessionId === request.receivingSessionId,
  );
  if (recipient === undefined || isEnded(recipient)) {
    throw new LibraryUserError('Phiên nhận xét không còn gắn với worktree này.');
  }

  const text = `[Nhận xét trên diff] ${request.file}:${request.line}\n${snippet}\nNhận xét: ${content}`;
  if (recipient.agentKind === 'board' || recipient.engine === 'board') {
    await deps.services.sendToBoardSession(request.receivingSessionId, text);
  } else {
    await deps.services.sendToLedgerSession(request.receivingSessionId, text);
  }
}

function isEnded(node: ProjectTreeNode): boolean {
  const state = (node.state ?? '').toLowerCase();
  return state === 'ended' || state === 'stopped' || state === 'closed' || state === 'exited';
}
