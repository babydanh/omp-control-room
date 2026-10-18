/**
 * Which client messages may survive a dropped socket.
 *
 * The transport queues whatever it was given while disconnected and flushes it
 * on reconnect. That is right for the legacy office commands (a `saveLayout`
 * replayed after a reconnect is the intent), and wrong for anything that
 * performs an action: replaying a prompt would submit it twice, replaying an
 * approval answer could answer a question that has since been superseded, and
 * replaying terminal input would re-send keystrokes the user already sent.
 *
 * The rule lives next to the protocol rather than inside the transport so every
 * transport branch decides the same way, and so a new company command added
 * later is either explicitly replayable or dropped -- never queued by accident.
 */

/**
 * Messages that are safe to send again on reconnect: they either only read
 * server state or re-establish a subscription.
 */
const REPLAYABLE_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'webviewReady',
  'requestDiagnostics',
  'focusAgent',
  'saveLayout',
  'saveAgentSeats',
  'exportLayout',
  'importLayout',
  'companySnapshotRequest',
  'companyArtifactRequest',
  'companyModelCatalogRequest',
  'companyFileListRequest',
  'companyFileReadRequest',
  'companySessionLogRequest',
  'companySessionInfoRequest',
  'herdrInfoRequest',
]);

/** Error a UI surfaces to keep a draft instead of losing it to a silent drop. */
export const TRANSPORT_DISCONNECTED_ERROR = 'transport_disconnected';

/**
 * True when a message may be queued across a disconnect. An unknown message
 * type is treated as NOT replayable: the safe default is to make the client
 * re-send it deliberately rather than to fire it twice unasked.
 */
export function isReplayableClientMessage(message: { type?: unknown }): boolean {
  return typeof message.type === 'string' && REPLAYABLE_MESSAGE_TYPES.has(message.type);
}
