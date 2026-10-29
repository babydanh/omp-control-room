import type { ProjectCommentMessage, ProjectTreeNode } from '../../../core/src/messages.js';
import { ledgerPathKey } from '../ledger/ledgerPath.js';
import type { LedgerService } from '../ledger/ledgerService.js';
import { LibraryUserError } from '../library/libraryError.js';
import type { ProjectModuleDeps } from './services.js';

export const PROJECT_COMMENT_MAX_LENGTH = 4_000;
export const PROJECT_COMMENT_SNIPPET_MAX_LENGTH = 1_200;

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
  const snippet = request.snippet.slice(0, PROJECT_COMMENT_SNIPPET_MAX_LENGTH);
  if (!Number.isSafeInteger(request.line) || request.line < 1 || request.file.trim() === '' || content === '') {
    throw new LibraryUserError('Nội dung nhận xét không hợp lệ.');
  }
  if (content.length > PROJECT_COMMENT_MAX_LENGTH || snippet.trim().length > PROJECT_COMMENT_SNIPPET_MAX_LENGTH) {
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

  const text = formatProjectComment(request.file, request.line, snippet, content);
  if (recipient.agentKind === 'board' || recipient.engine === 'board') {
    await deps.services.sendToBoardSession(request.receivingSessionId, text);
  } else {
    await deps.services.sendToLedgerSession(request.receivingSessionId, text);
  }
}

export function formatProjectComment(file: string, line: number, snippet: string, content: string): string {
  return `[Nhận xét trên diff] ${file}:${line}\n${snippet}\nNhận xét: ${content}`;
}

function isEnded(node: ProjectTreeNode): boolean {
  const state = (node.state ?? '').toLowerCase();
  return state === 'ended' || state === 'stopped' || state === 'closed' || state === 'exited';
}
