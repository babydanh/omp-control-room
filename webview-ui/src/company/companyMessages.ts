/**
 * The company message vocabulary, in one place.
 *
 * Two jobs:
 *
 *  1. `isCompanyServerMessage` is the single routing test the app's ONE
 *     transport subscription (useCompanyTransport) uses to hand a server
 *     message to the company client. Anything else the server sends has no
 *     reader on the board, and no second `transport.onMessage` is registered.
 *  2. Builders produce the `ClientMessage` values, so a command is built in
 *     the same shape on both surfaces and a typo in a message `type` is a
 *     compile error rather than a silently ignored command.
 *
 * Nothing here sends. Sending is the client's job, and it is the only place
 * that catches the transport's refusal to queue an action across a disconnect.
 */

import type {
  CompanyModelCatalogEntry,
  QuestionAnswerInput,
  RoleProfile,
  SubmitPromptInput,
} from '../../../core/src/company.js';
import type { ClientMessage } from '../../../core/src/messages.js';
import {
  COMPANY_ARTIFACT_PAGE_BYTES,
  COMPANY_FILE_PAGE_BYTES,
  COMPANY_TERMINAL_DEFAULT_COLS,
  COMPANY_TERMINAL_DEFAULT_ROWS,
} from './constants.js';

const COMPANY_SERVER_MESSAGE_TYPES: Readonly<Record<string, true>> = {
  companySnapshot: true,
  companyStateChanged: true,
  companyCommandResult: true,
  companyTextDelta: true,
  companyModelCatalog: true,
  companyArtifactPage: true,
  companyFileList: true,
  companyFileRead: true,
  companyAttachmentUploaded: true,
  terminalAttached: true,
  terminalSnapshot: true,
  terminalData: true,
  terminalClosed: true,
};

/** Whether a received message belongs to the company client. */
export function isCompanyServerMessage(message: { type?: unknown }): boolean {
  return typeof message.type === 'string' && message.type in COMPANY_SERVER_MESSAGE_TYPES;
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function companySnapshotRequest(
  requestId: string,
  includeDiagnostics = false,
): ClientMessage {
  return { type: 'companySnapshotRequest', requestId, includeDiagnostics };
}

export function promptSubmit(input: SubmitPromptInput): ClientMessage {
  return { type: 'companyPromptSubmit', prompt: input };
}

export function contractDecision(
  requestId: string,
  contractId: string,
  revision: number,
  decision: 'approve' | 'reject',
  note?: string,
): ClientMessage {
  return {
    type: 'companyContractDecision',
    requestId,
    contractId,
    revision,
    decision,
    ...(note === undefined ? {} : { note }),
  };
}

export function questionAnswer(answer: QuestionAnswerInput): ClientMessage {
  return { type: 'companyQuestionAnswer', answer };
}

export function sessionControl(
  requestId: string,
  sessionId: string,
  runEpoch: number,
  action: 'pause' | 'resume' | 'kill' | 'restart' | 'archive',
): ClientMessage {
  return { type: 'companySessionControl', requestId, sessionId, runEpoch, action };
}

export function settingsUpdate(
  requestId: string,
  roleProfiles: Record<string, RoleProfile>,
): ClientMessage {
  return { type: 'companySettingsUpdate', requestId, roleProfiles };
}

export function modelCatalogRequest(requestId: string): ClientMessage {
  return { type: 'companyModelCatalogRequest', requestId };
}

export function artifactRequest(
  requestId: string,
  artifactId: string,
  offset = 0,
  limit = COMPANY_ARTIFACT_PAGE_BYTES,
): ClientMessage {
  return { type: 'companyArtifactRequest', requestId, artifactId, offset, limit };
}

export function fileListRequest(requestId: string, path: string): ClientMessage {
  return { type: 'companyFileListRequest', requestId, path };
}

export function fileReadRequest(
  requestId: string,
  path: string,
  offset = 0,
  limit = COMPANY_FILE_PAGE_BYTES,
): ClientMessage {
  return { type: 'companyFileReadRequest', requestId, path, offset, limit };
}

export function terminalAttach(
  requestId: string,
  sessionId: string,
  runEpoch: number,
  cols = COMPANY_TERMINAL_DEFAULT_COLS,
  rows = COMPANY_TERMINAL_DEFAULT_ROWS,
): ClientMessage {
  return { type: 'terminalAttach', requestId, sessionId, runEpoch, cols, rows };
}

export function terminalInput(
  sessionId: string,
  runEpoch: number,
  data: string,
  leaseId: string,
): ClientMessage {
  return { type: 'terminalInput', sessionId, runEpoch, data, leaseId };
}

export function terminalResize(
  sessionId: string,
  runEpoch: number,
  cols: number,
  rows: number,
  leaseId: string,
): ClientMessage {
  return { type: 'terminalResize', sessionId, runEpoch, cols, rows, leaseId };
}

export function terminalDetach(
  sessionId: string,
  runEpoch: number,
  leaseId: string,
): ClientMessage {
  return { type: 'terminalDetach', sessionId, runEpoch, leaseId };
}

/** The catalog entry a `companyModelCatalog` reply resolves to. */
export type CatalogEntry = CompanyModelCatalogEntry;
