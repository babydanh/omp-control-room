/**
 * ompBridge: the host half of the in-process OMP bridge.
 *
 * One bridge owns one local endpoint for one managed company session and
 * authenticates exactly one extension — the one OMP loads from
 * `--extension dist/company/omp-bridge.mjs` inside that session's own process.
 * The wire is newline-delimited JSON over a Windows named pipe or an
 * owner-only Unix socket inside the company namespace: no TCP, no HTTP, no
 * port, nothing a browser can reach.
 *
 * Three rules shape the code:
 *
 *  - **Nothing is trusted from the pipe.** The first frame must be a `hello`
 *    carrying this run's session id, run epoch and random nonce; every later
 *    request repeats the session id and epoch. A frame that fails any check is
 *    rejected with a code, never interpreted further, and never echoed back.
 *  - **The host is the authority.** The extension may ask, but the decision for
 *    a tool call, a company tool effect or a native subagent spawn is made here
 *    and correlated by request id. Answers are bounded (128 in flight) and
 *    timed; a late, lost or unanswered call is an error the caller fails closed
 *    on.
 *  - **Diagnostics carry no content.** Error events carry a static code and a
 *    static sentence — never terminal content, file bodies, tool arguments,
 *    prompts or credentials. Pipe content stays in the pipe.
 *
 * The model catalog is the one read the host pulls rather than is pushed. Only
 * a process inside OMP can see the runtime's own credential-filtered model set,
 * so `requestModelCatalog()` asks the authenticated extension and validates what
 * comes back — run identity first, then every field. The answer carries model
 * metadata only; a base url, a price or a header never crosses this pipe.
 *
 * Prompts carry images as real bytes, and the host is where that promise is
 * kept. `sendPrompt` validates every image — media type against the installed
 * runtime's own list, canonical base64, the container signature the type
 * declares, one attachment's budget and the prompt's image budget — and refuses
 * the whole prompt before writing a byte, because a partly delivered image is
 * the model describing an attachment the user attached intact. A payload too
 * large for one frame travels as a digested chunk sequence rather than being
 * trimmed, and delivery is confirmed by the extension before the call resolves:
 * `sendUserMessage` is fire-and-forget inside OMP, so a drained write is not a
 * delivered turn.
 *
 * The extension half lives in `ompBridgeExtension.ts` and is bundled
 * separately: it uses Node built-ins and the injected `pi` API only.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type { AgentToolInfo } from '../../../core/src/company.js';
import { CompanyError } from './companyError.js';
import { COMPANY_ATTACHMENT_MAX_BYTES } from './constants.js';
import type { OmpModelDescriptor } from './modelCatalog.js';

/** Wire version; both halves must agree or the run is not safe to start. */
export const OMP_BRIDGE_PROTOCOL_VERSION = 1 as const;

/** One frame may not exceed 256 KiB. Larger payloads are chunked, never truncated. */
export const OMP_BRIDGE_MAX_FRAME_BYTES = 256 * 1024;

/** UTF-8 payload bytes carried by one chunk of an oversized prompt. */
export const OMP_BRIDGE_CHUNK_BYTES = 64 * 1024;

/**
 * Image media types the installed runtime accepts, read from
 * `@oh-my-pi/pi-ai` 18.4.9 rather than guessed: `Base64ImageSource.media_type`
 * is the closed union `image/jpeg | image/png | image/gif | image/webp`, and
 * the OpenAI path builds `data:<mime>;base64,<data>` from the same declared
 * type. Anything else is refused here instead of failing inside a provider
 * turn, where the model would already have seen the text.
 */
export const OMP_BRIDGE_IMAGE_MIME_TYPES: readonly string[] = Object.freeze([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/** Images one prompt may carry. */
export const OMP_BRIDGE_MAX_PROMPT_IMAGES = 8;

/**
 * Decoded image bytes one prompt may total. A prompt's base64 travels at one
 * third over the frame cap in chunks, so this is a delivery budget, not a
 * buffer: past it the pipe cost outgrows what one turn can usefully carry.
 */
export const OMP_BRIDGE_MAX_PROMPT_IMAGE_BYTES = 16 * 1024 * 1024;

/**
 * Deadline for the extension to answer whether the native session took a
 * prompt. `sendUserMessage` is fire-and-forget inside OMP, so the write
 * draining proves nothing; without an answer the host would report a delivery
 * that never happened.
 */
export const OMP_BRIDGE_PROMPT_ACK_TIMEOUT_MS = 30_000;

/** Prompt reassemblies held at once; a second one per id is a duplicate. */
export const OMP_BRIDGE_MAX_PENDING_PROMPTS = 4;

/** Correlated calls the host holds at once. Beyond this the host refuses. */
export const OMP_BRIDGE_MAX_PENDING_RPCS = 128;

/** Default deadline for one correlated call. */
export const OMP_BRIDGE_DEFAULT_RPC_TIMEOUT_MS = 120_000;
/** Deadline for a native generation abort acknowledgement. */
export const OMP_BRIDGE_ABORT_TIMEOUT_MS = 5_000;

/** Default deadline for the extension to present an authenticated hello. */
export const OMP_BRIDGE_DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * Model rows one catalog answer may carry; larger answers are refused. Sized
 * for an OpenRouter-scale registry (hundreds of models from one provider); the
 * byte ceiling the extension enforces is what keeps the answer inside a frame.
 */
export const OMP_BRIDGE_MAX_CATALOG_MODELS = 2048;

/** Catalog requests held at once. Beyond this the caller is told, not queued. */
export const OMP_BRIDGE_MAX_PENDING_MODEL_REQUESTS = 4;

/** Deadline for one catalog read; the runtime answers it synchronously. */
export const OMP_BRIDGE_CATALOG_TIMEOUT_MS = 15_000;

/** Describe reads held at once; beyond this the caller is told, not queued. */
export const OMP_BRIDGE_MAX_PENDING_INFO_REQUESTS = 4;

/** Deadline for one describe read; the extension answers it synchronously. */
export const OMP_BRIDGE_INFO_TIMEOUT_MS = 5_000;

/** Tools or skills one describe answer may carry; the extension caps at this count. */
export const OMP_BRIDGE_MAX_INFO_ITEMS = 500;

/** Longest name, model, thinking or description text one describe answer may carry. */
const OMP_BRIDGE_MAX_INFO_TEXT = 300;

/** Longest working-directory or session-file path one describe answer may carry. */
const OMP_BRIDGE_MAX_INFO_PATH = 4096;

/**
 * One catalog read from the native runtime, stamped with the run that produced
 * it so a caller holding it across a restart can refuse it as stale.
 */
export interface OmpBridgeModelCatalog {
  readonly sessionId: string;
  readonly runEpoch: number;
  readonly models: readonly OmpModelDescriptor[];
}

/** One loaded skill as the native session reports it. */
export interface OmpBridgeSessionSkill {
  readonly name: string;
  readonly description?: string;
}

/**
 * What the live native session has loaded, read at call time. The host keeps it
 * as reported; skill usage is not part of it, because only the durable session
 * log knows which skills ran.
 */
export interface OmpBridgeSessionDescription {
  readonly cwd: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly sessionFile?: string;
  readonly tools: readonly AgentToolInfo[];
  readonly skills: readonly OmpBridgeSessionSkill[];
}

/**
 * Child-process environment contract. The host fills these in `childEnv`; the
 * extension reads nothing else to find its host.
 */
export const OMP_BRIDGE_ENV = {
  /** Pipe path (Windows) or socket path (POSIX). */
  socket: 'PIXEL_AGENTS_OMP_BRIDGE_SOCKET',
  /** 256-bit random nonce proving this process may attach to this run. */
  token: 'PIXEL_AGENTS_OMP_BRIDGE_TOKEN',
  /** Company session id the host expects in hello and in every request. */
  session: 'PIXEL_AGENTS_OMP_BRIDGE_SESSION',
  /** Run epoch; a restart mints a new one and invalidates the old run. */
  epoch: 'PIXEL_AGENTS_OMP_BRIDGE_EPOCH',
  /** Company role this session runs as. */
  role: 'PIXEL_AGENTS_OMP_BRIDGE_ROLE',
  /** Deadline for one correlated call, in milliseconds. */
  rpcTimeoutMs: 'PIXEL_AGENTS_OMP_BRIDGE_RPC_TIMEOUT_MS',
  /** Extension-side connect retries. Tuning only; the host does not set it. */
  connectAttempts: 'PIXEL_AGENTS_OMP_BRIDGE_CONNECT_ATTEMPTS',
  /** Extension-side retry spacing. Tuning only; the host does not set it. */
  connectRetryMs: 'PIXEL_AGENTS_OMP_BRIDGE_CONNECT_RETRY_MS',
} as const;

/** Identity every frame of one run carries. */
export interface OmpBridgeRunIdentity {
  readonly sessionId: string;
  readonly runEpoch: number;
}

/** Authorization the host returns for a native tool call. */
export interface OmpBridgeToolAuthorization {
  readonly allow: boolean;
  readonly reason?: string;
  /** Replacement arguments; OMP revalidates them against the tool schema. */
  readonly input?: Record<string, unknown>;
}

/** Authorization the host returns for a native subagent spawn. */
export interface OmpBridgeSubagentAuthorization {
  readonly allow: boolean;
  readonly reason?: string;
  /** Routing explanation surfaced with the resolved model. */
  readonly note?: string;
}

/**
 * A correlated request from the extension. `id` is opaque and unique per run;
 * `method` decides which other fields are present.
 */
export type OmpBridgeRpcRequest = OmpBridgeRunIdentity &
  (
    | {
        readonly id: string;
        readonly method: 'authorize_tool';
        /** OMP's tool call id, so an approval can name the exact call. */
        readonly toolCallId: string;
        readonly toolName: string;
        /** Arguments as the gate saw them, before OMP normalizes them further. */
        readonly input: Record<string, unknown>;
        /** Whether the call came from the session main agent or a native child. */
        readonly agentKind?: string;
      }
    | {
        readonly id: string;
        readonly method: 'company_tool';
        readonly toolCallId: string;
        readonly toolName: string;
        readonly role: string;
        readonly payload: Record<string, unknown>;
      }
    | {
        readonly id: string;
        readonly method: 'authorize_subagent';
        readonly agent: string;
        readonly invocationKind: 'task' | 'eval';
        readonly modelRole?: string;
        readonly patterns: readonly string[];
        readonly spawnKey?: string;
      }
    | {
        /**
         * A native `ask` tool call became a durable Company Question. The
         * host answers with the question id every later step names, so both
         * the terminal dialog and the board resolve the SAME record.
         */
        readonly id: string;
        readonly method: 'publish_question';
        readonly toolCallId: string;
        readonly questions: readonly OmpBridgeAskQuestion[];
      }
    | {
        /** The terminal dialog won; record its answer against that question. */
        readonly id: string;
        readonly method: 'answer_question';
        readonly toolCallId: string;
        readonly questionId: string;
        readonly answer: OmpBridgeAskAnswer;
      }
    | {
        /**
         * The question can no longer be answered — the native tool went away,
         * the call was aborted, or this session cannot ask at all. Carrying a
         * cancellation rather than an answer is what keeps "cancelled" from
         * ever reading as a yes.
         */
        readonly id: string;
        readonly method: 'cancel_question';
        readonly toolCallId: string;
        readonly questionId: string;
        readonly code: string;
      }
  );

/**
 * One question exactly as the native `ask` tool declares it: an id, the text,
 * and the options a user picks from. Anything richer (a note, a rich preview)
 * stays in the native dialog; the durable record needs only what a decision
 * depends on.
 */
export interface OmpBridgeAskQuestion {
  readonly id: string;
  readonly question: string;
  readonly header?: string;
  readonly options: readonly { readonly label: string; readonly description?: string }[];
  readonly multi?: boolean;
  /** Zero-based index of the recommended option, as the native tool states it. */
  readonly recommended?: number;
}

/** The answer to one question, whichever surface the user chose it on. */
export interface OmpBridgeAskAnswer {
  readonly selectedOptions: readonly string[];
  readonly customInput?: string;
  readonly multi: boolean;
}

/** The answer to one question of an ask call, named by the question's own id. */
export interface OmpBridgeQuestionAnswer extends OmpBridgeAskAnswer {
  readonly id: string;
}

/** One board answer bound to the run that is still waiting on it. */
export interface OmpBridgeAnswerQuestion {
  readonly questionId: string;
  /** One entry per question the user answered; an ask call may hold several. */
  readonly answers: readonly OmpBridgeQuestionAnswer[];
  /** Run epoch the answer was accepted on; a restart invalidates it. */
  readonly runEpoch?: number;
}

/** A withdrawal bound to the run whose question died. */
export interface OmpBridgeCancelQuestion {
  readonly questionId: string;
  /** Static reason code; never prose, never the user's answer. */
  readonly code: string;
  readonly runEpoch?: number;
}

/** The decisions the host owns. Anything else is a bridge bug, not a call. */
export type OmpBridgeRpcMethod = OmpBridgeRpcRequest['method'];

/**
 * Handler for one correlated request. Resolve with the decision, or reject with
 * an {@link OmpBridgeRpcError} to answer `ok: false`; the extension treats every
 * error, timeout and disconnect as a refusal.
 */
export type OmpBridgeRpcHandler = (request: OmpBridgeRpcRequest) => Promise<unknown> | unknown;

/** A refused call, or the static code explaining why it was refused. */
export class OmpBridgeRpcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OmpBridgeRpcError';
    this.code = code;
  }
}

/** One bounded fact about a run, in the order the extension produced it. */
export type OmpBridgeEvent =
  | {
      readonly k: 'session';
      readonly phase: 'started' | 'shutdown';
      readonly nativeSessionId?: string;
      readonly nativeSessionPath?: string;
    }
  | {
      /** Assistant text, split into bounded frames and ordered by `seq`. */
      readonly k: 'text';
      readonly seq: number;
      readonly text: string;
    }
  | {
      readonly k: 'tool';
      readonly phase: 'start' | 'end';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly isError?: boolean;
      /** The skill a `read` of `skill://<name>` loads; set only on a start event for such a read. */
      readonly skill?: string;
    }
  | {
      /** Raw provider usage for one finished assistant message. */
      readonly k: 'usage';
      readonly model?: string;
      readonly provider?: string;
      readonly nativeSessionId?: string;
      /** Provider response id; the ledger dedupes on (session, responseId). */
      readonly responseId?: string;
      readonly input: number;
      readonly output: number;
      readonly cacheRead: number;
      readonly cacheWrite: number;
      readonly totalTokens?: number;
      /** Provider-reported occupancy for this turn, never cumulative spend. */
      readonly contextTokens?: number;
      readonly costUsd?: number;
    }
  | {
      /** True only when idle, nothing queued and no native async job running. */
      readonly k: 'quiescent';
      readonly idle: boolean;
    }
  | {
      /**
       * Overview snapshot of the running session, pushed when it changes. Rows are
       * unvalidated here; the company runtime checks and bounds every field.
       */
      readonly k: 'insight';
      readonly todo?: { readonly phases: readonly unknown[] };
      readonly planMode: string;
      readonly subagents: readonly unknown[];
    }
  | {
      /** A static protocol or lifecycle failure. Never carries content. */
      readonly k: 'error';
      readonly code: string;
      readonly message: string;
    };

export type OmpBridgeEventHandler = (event: OmpBridgeEvent) => void;

/**
 * One image carried with a prompt, shaped as the installed OMP `ImageContent`
 * block: base64 of the real bytes, never a path, a link or a markdown data url.
 */
export interface OmpBridgePromptImage {
  readonly mimeType: string;
  /** Canonical base64 of the raw image bytes. */
  readonly data: string;
}

export interface OmpBridgeSendPrompt {
  readonly requestId: string;
  readonly text: string;
  /**
   * Run epoch the caller believes it is sending on. A restart mints a new one,
   * so a prompt composed for the previous run is refused rather than delivered
   * into the session that replaced it. Omitted means "this run".
   */
  readonly runEpoch?: number;
  /**
   * Images delivered to the native session as real image blocks. Omitted or
   * empty is a text-only prompt and keeps the single-string delivery a text
   * model already expects.
   */
  readonly images?: readonly OmpBridgePromptImage[];
  /** Native queue semantics; omitted starts a turn when idle, steers while streaming. */
  readonly delivery?: 'prompt' | 'steer' | 'follow_up';
}

export interface OmpBridgeOptions {
  readonly sessionId: string;
  readonly runEpoch: number;
  /** Company role this session runs as; cross-checked on every company tool call. */
  readonly role: string;
  /** POSIX only: directory that will hold the socket. Owner-only permissions. */
  readonly socketDir?: string;
  /** Explicit endpoint; used by callers that own the namespace path. */
  readonly endpoint?: string;
  readonly rpcHandler: OmpBridgeRpcHandler;
  readonly rpcTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  /** Test seam for a predictable endpoint; production generates 256 bits. */
  readonly nonce?: string;
}

export interface OmpBridgeHandle {
  /** Pipe path or socket path the child connects to. */
  readonly endpoint: string;
  /** The 256-bit nonce a client must present to authenticate. */
  readonly nonce: string;
  readonly sessionId: string;
  readonly runEpoch: number;
  readonly role: string;
  /** Exact environment for the child process; spread it into the spawn env. */
  readonly childEnv: Readonly<Record<string, string>>;
  /** Resolves only after the authenticated handshake; rejects on disposal. */
  readonly ready: Promise<void>;
  /** Correlated calls accepted and not yet answered. */
  readonly pendingRpcs: number;
  /**
   * Deliver a prompt into the live native session, images included.
   *
   * Resolves only once the extension has reported that the session took it, so
   * a refusal — a native throw, a channel loss, a prompt that stayed
   * unacknowledged — rejects here instead of reading as a delivered turn. A
   * prompt whose images fail validation rejects before anything is written.
   */
  sendPrompt(input: OmpBridgeSendPrompt): Promise<void>;
  /** Abort the current native generation through its authenticated OMP context. */
  abort(): Promise<void>;
  /**
   * Deliver a board answer to a question the native `ask` tool is waiting on.
   *
   * This is the web half of the SAME durable Question the terminal dialog is
   * showing, not a second question: the extension cancels its dialog and
   * answers the tool with exactly this. It is a write, not a request — the
   * answer is already persisted by whoever accepted it on the board, and
   * whoever lost the race learns it from the tool result.
   */
  answerQuestion(input: OmpBridgeAnswerQuestion): Promise<void>;
  /**
   * Withdraw a question nobody answered. A cancellation travels as its own
   * frame so it can never be read as an answer, and the native tool is told
   * the question died rather than handed a default.
   */
  cancelQuestion(input: OmpBridgeCancelQuestion): Promise<void>;
  onEvent(handler: OmpBridgeEventHandler): () => void;
  /**
   * Ask the live native session which models the runtime actually offers.
   *
   * This is a pull, not a subscription: the registry is read at call time, so
   * the answer reflects the credential state of this moment. It rejects rather
   * than answering empty — no live session, no model facade, an unreadable
   * registry, a malformed or oversized catalog, and another run's answer all
   * fail closed, because an empty catalog would read as "you have no models".
   */
  requestModelCatalog(): Promise<OmpBridgeModelCatalog>;
  /**
   * Ask the live native session what it has loaded: working directory, model,
   * thinking level, session file, every registered tool with its source and
   * active flag, and every skill. A pull at call time, like the model catalog.
   * It rejects rather than answering empty, so a missing registry or another
   * run's answer never reads as "this session has no tools".
   */
  requestSessionInfo(): Promise<OmpBridgeSessionDescription>;
  dispose(): Promise<void>;
}

/**
 * Minimal deferred. `Promise.withResolvers` does not exist under this project's
 * ES2022 lib and needs Node 22, so the resolver pair is captured explicitly.
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (err: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Static failure text. Pipe content never reaches a diagnostic string. */
const ERROR_TEXT = {
  malformed_frame: 'the peer sent a frame that is not a bridge frame',
  frame_too_large: 'the peer sent a frame above the 256 KiB cap',
  unauthenticated: 'the peer sent a request before authenticating',
  bad_handshake: 'the peer presented a handshake this run does not accept',
  stale_run_identity: 'the peer sent a request for another session or run epoch',
  role_mismatch: 'the peer claims a role this run does not have',
  unknown_tool: 'the peer invoked a company tool this bridge does not offer',
  tool_role_forbidden: 'the peer invoked a company tool that belongs to another role',
  duplicate_client: 'a second client presented this run nonce',
  duplicate_request_id: 'the peer reused a request id that is still pending',
  too_many_pending: 'the peer has more correlated calls in flight than the bridge allows',
  unknown_frame: 'the peer sent a frame type this run does not accept',
  rpc_timeout: 'the host did not answer a correlated call in time',
  rpc_failed: 'the host failed a correlated call',
  disconnected: 'the bridge is closed',
  disposed: 'the bridge was disposed before the handshake completed',
  abort_timeout: 'the native session did not acknowledge abort in time',
  abort_pending: 'a native abort is already pending',
  abort_failed: 'the native session could not abort its active generation',
  handshake_timeout: 'the extension did not authenticate in time',
  catalog_busy:
    'the native session already has as many model catalog reads in flight as the bridge allows',
  catalog_timeout: 'the native session did not answer the model catalog request in time',
  catalog_malformed:
    'the native session answered the model catalog request with an unusable catalog',
  catalog_unavailable: 'the native runtime model catalog is unavailable',
  info_busy: 'the native session already has as many describe reads in flight',
  info_timeout: 'the native session did not describe itself in time',
  info_malformed: 'the native session described itself with an unusable answer',
  info_unavailable: 'the native runtime does not expose its loaded tools and skills',
  catalog_capability_missing:
    'this OMP session exposes no model query, so the runtime catalog cannot be read',
  catalog_too_large: 'the runtime model list does not fit one catalog answer',
  prompt_not_text: 'a prompt needs text, and a prompt is never images alone',
  prompt_ack_timeout: 'the native session did not answer whether it took the prompt',
  prompt_delivery_failed: 'the native session refused the prompt',
  prompt_malformed: 'the peer sent a prompt this run cannot reassemble',
  image_type_unsupported: 'a prompt image is not a media type the native runtime accepts',
  image_data_malformed: 'a prompt image is not canonical base64 image data',
  image_mime_mismatch: 'a prompt image does not carry the bytes its media type declares',
  image_too_large: 'a prompt image is larger than one attachment may be',
  image_budget_exceeded: 'the prompt images exceed the aggregate image byte budget',
  image_too_many: 'the prompt carries more images than the bridge allows',
  question_malformed: 'a question or answer does not have the shape this run requires',
  question_capability_missing:
    'this OMP session exposes no ask tool, so a question cannot be published',
  question_publish_failed: 'the durable question could not be published',
  question_cancel_unavailable: 'this question can no longer be withdrawn',
} as const;

type ErrorCode = keyof typeof ERROR_TEXT;

/** Native delivery modes; an omitted mode keeps OMP's own default semantics. */
const DELIVER_AS = {
  steer: 'steer',
  follow_up: 'followUp',
} as const;

/**
 * Company tools and the single role allowed to invoke each. `'*'` means every
 * role. The host enforces this before `rpcHandler` runs, because the extension
 * is a peer, not the authority: a forged role or an invented tool name is
 * refused without reaching the runtime.
 */
export const COMPANY_BRIDGE_TOOL_ROLES: Readonly<Record<string, string>> = Object.freeze({
  company_submit_contract: 'director',
  company_architecture_review: 'advisor',
  company_task_result: 'worker',
  company_qa_result: 'qa',
  company_verify: 'qa',
  company_judge_result: 'judge',
  company_report: 'judge',
  company_ask_user: '*',
});

/** True for a plain JSON object frame; arrays and primitives are not frames. */
function isFrameObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Non-empty string, the only shape accepted for ids and nonces. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Constant-time nonce compare that tolerates a length mismatch. */
function secretsMatch(expected: string, presented: unknown): boolean {
  if (!isNonEmptyString(presented)) return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const presentedBytes = Buffer.from(presented, 'utf8');
  if (expectedBytes.length !== presentedBytes.length) return false;
  return timingSafeEqual(expectedBytes, presentedBytes);
}

/** Read a string array field, or `undefined` when it is absent/malformed. */
function readStringArray(source: Record<string, unknown>, key: string): string[] | undefined {
  const value = source[key];
  if (!Array.isArray(value)) return undefined;
  return value.every((item): item is string => typeof item === 'string') ? [...value] : undefined;
}

/**
 * Validate one catalog answer arriving from the extension.
 *
 * The peer is a process, not an authority: every field is checked against the
 * shape a company decision may rely on, and one unusable row refuses the whole
 * answer. A partial catalog would be worse than none — it would present the
 * models that survived parsing as the models the runtime offers.
 */
function parseModelCatalog(value: unknown): OmpModelDescriptor[] | null {
  if (!isFrameObject(value)) return null;
  const models = value['models'];
  if (!Array.isArray(models) || models.length > OMP_BRIDGE_MAX_CATALOG_MODELS) return null;

  const parsed: OmpModelDescriptor[] = [];
  for (const row of models) {
    if (!isFrameObject(row)) return null;
    const id = row['id'];
    const provider = row['provider'];
    const model = row['model'];
    const input = readStringArray(row, 'input');
    const configured = row['configured'];
    const thinkingLevels = readStringArray(row, 'thinkingLevels');
    if (
      !isNonEmptyString(id) ||
      !isNonEmptyString(provider) ||
      !isNonEmptyString(model) ||
      input === undefined ||
      typeof configured !== 'boolean' ||
      (row['thinkingLevels'] !== undefined && thinkingLevels === undefined)
    ) {
      return null;
    }
    parsed.push({
      id,
      provider,
      model,
      input,
      ...(thinkingLevels === undefined ? {} : { thinkingLevels }),
      configured,
    });
  }
  return parsed;
}

/**
 * Decode one image's base64 exactly, or return null.
 *
 * `Buffer.from(value, 'base64')` cannot fail: it silently drops characters it
 * does not recognize and stops at the first padding, so a corrupt or truncated
 * payload would reach the provider as a shorter image that is then described to
 * the model as the whole attachment. Re-encoding is the only check that says
 * the string really is the base64 of exactly these bytes.
 */
function decodeImageBytes(data: string): Buffer | null {
  if (data.length === 0 || data.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length === 0) return null;
  return bytes.toString('base64') === data ? bytes : null;
}

/** The first `length` bytes read as latin1, for container signatures. */
function asciiPrefix(bytes: Buffer, length: number): string {
  return bytes.subarray(0, length).toString('latin1');
}

/**
 * Whether the bytes really are the container the media type claims.
 *
 * The declared type is the only thing OMP forwards to a provider, so an
 * attachment saved under an image name but holding something else would be
 * described to the model as a picture of content it never saw. Every accepted
 * type is checked, which is why the allowlist is exactly these four.
 */
function matchesImageSignature(mimeType: string, bytes: Buffer): boolean {
  if (mimeType === 'image/png') return asciiPrefix(bytes, 8) === '\x89PNG\r\n\x1a\n';
  if (mimeType === 'image/jpeg') return asciiPrefix(bytes, 3) === '\xff\xd8\xff';
  if (mimeType === 'image/gif') {
    const header = asciiPrefix(bytes, 6);
    return header === 'GIF87a' || header === 'GIF89a';
  }
  if (mimeType === 'image/webp') {
    return asciiPrefix(bytes, 4) === 'RIFF' && asciiPrefix(bytes, 12).slice(8) === 'WEBP';
  }
  return false;
}

/**
 * Validate every image on a prompt, or refuse the prompt whole.
 *
 * The refusal happens before a single byte is written, because a partly
 * delivered image is worse than none: the native session would tell the model
 * about an attachment the user attached intact. Each image must name a media
 * type the installed runtime accepts, carry canonical base64 whose bytes are
 * that type, and fit both the single-attachment budget intake already
 * enforced and this bridge's aggregate image budget.
 */
function validatePromptImages(images: readonly OmpBridgePromptImage[] | undefined): {
  readonly images: readonly OmpBridgePromptImage[];
  readonly totalBytes: number;
} {
  if (images === undefined || images.length === 0) return { images: [], totalBytes: 0 };
  if (images.length > OMP_BRIDGE_MAX_PROMPT_IMAGES) {
    throw new CompanyError('omp_bridge_image_too_many', ERROR_TEXT.image_too_many);
  }

  let totalBytes = 0;
  for (const image of images) {
    if (
      typeof image.mimeType !== 'string' ||
      !OMP_BRIDGE_IMAGE_MIME_TYPES.includes(image.mimeType)
    ) {
      throw new CompanyError(
        'omp_bridge_image_type_unsupported',
        ERROR_TEXT.image_type_unsupported,
      );
    }
    const bytes = decodeImageBytes(image.data);
    if (bytes === null) {
      throw new CompanyError('omp_bridge_image_data_malformed', ERROR_TEXT.image_data_malformed);
    }
    if (!matchesImageSignature(image.mimeType, bytes)) {
      throw new CompanyError('omp_bridge_image_mime_mismatch', ERROR_TEXT.image_mime_mismatch);
    }
    if (bytes.length > COMPANY_ATTACHMENT_MAX_BYTES) {
      throw new CompanyError('omp_bridge_image_too_large', ERROR_TEXT.image_too_large);
    }
    totalBytes += bytes.length;
  }
  if (totalBytes > OMP_BRIDGE_MAX_PROMPT_IMAGE_BYTES) {
    throw new CompanyError('omp_bridge_image_budget_exceeded', ERROR_TEXT.image_budget_exceeded);
  }
  return { images, totalBytes };
}

/** Bounds one ask call, so a peer cannot make the host persist a wall of text. */
export const OMP_BRIDGE_MAX_ASK_QUESTIONS = 8;
/** Characters of question text or option label one entry may carry. */
export const OMP_BRIDGE_MAX_ASK_TEXT = 2_000;
/** Options one question may offer. */
export const OMP_BRIDGE_MAX_ASK_OPTIONS = 32;

/**
 * Read the questions of a native `ask` call, or refuse the whole call.
 *
 * The peer is a process, not an authority: every field is bounded and typed
 * here, because these become a durable Question the user answers days later.
 * A partial read would present the user with fewer choices than the model
 * offered, which reads as "that was the only option".
 */
function parseAskQuestions(value: unknown): OmpBridgeAskQuestion[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.length > OMP_BRIDGE_MAX_ASK_QUESTIONS) return null;
  const questions: OmpBridgeAskQuestion[] = [];
  for (const entry of value) {
    if (!isFrameObject(entry)) return null;
    const id = entry['id'];
    const question = entry['question'];
    const rawOptions = entry['options'];
    if (
      !isNonEmptyString(id) ||
      !isNonEmptyString(question) ||
      question.length > OMP_BRIDGE_MAX_ASK_TEXT ||
      !Array.isArray(rawOptions) ||
      rawOptions.length === 0 ||
      rawOptions.length > OMP_BRIDGE_MAX_ASK_OPTIONS
    ) {
      return null;
    }
    const options: { label: string; description?: string }[] = [];
    for (const rawOption of rawOptions) {
      if (!isFrameObject(rawOption)) return null;
      const label = rawOption['label'];
      const description = rawOption['description'];
      if (
        !isNonEmptyString(label) ||
        label.length > OMP_BRIDGE_MAX_ASK_TEXT ||
        (description !== undefined && typeof description !== 'string')
      ) {
        return null;
      }
      options.push(description === undefined ? { label } : { label, description });
    }
    const header = entry['header'];
    const multi = entry['multi'];
    const recommended = entry['recommended'];
    if (
      (header !== undefined && typeof header !== 'string') ||
      (multi !== undefined && typeof multi !== 'boolean') ||
      (recommended !== undefined &&
        (typeof recommended !== 'number' || !Number.isInteger(recommended)))
    ) {
      return null;
    }
    questions.push({
      id,
      question,
      ...(typeof header === 'string' ? { header } : {}),
      options,
      ...(typeof multi === 'boolean' ? { multi } : {}),
      ...(typeof recommended === 'number' ? { recommended } : {}),
    });
  }
  return questions;
}

/**
 * Read one answer, or refuse it.
 *
 * An answer must select something or say something: an empty answer with no
 * custom text is not a decision, and storing it would let a cancelled dialog
 * be replayed later as if the user had answered.
 */
function parseAskAnswer(value: unknown): OmpBridgeAskAnswer | null {
  if (!isFrameObject(value)) return null;
  const selected = value['selectedOptions'];
  const customInput = value['customInput'];
  const multi = value['multi'];
  if (
    !Array.isArray(selected) ||
    !selected.every((option) => typeof option === 'string' && option.length > 0) ||
    selected.length > OMP_BRIDGE_MAX_ASK_OPTIONS ||
    typeof multi !== 'boolean' ||
    (customInput !== undefined && typeof customInput !== 'string')
  ) {
    return null;
  }
  if (selected.length === 0 && (customInput === undefined || customInput.length === 0)) {
    return null;
  }
  if (typeof customInput === 'string' && customInput.length > OMP_BRIDGE_MAX_ASK_TEXT) {
    return null;
  }
  return {
    selectedOptions: selected,
    ...(typeof customInput === 'string' ? { customInput } : {}),
    multi,
  };
}

/** Read the per-question answers of one board answer, or refuse the whole of it. */
function parseQuestionAnswers(value: unknown): OmpBridgeQuestionAnswer[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.length > OMP_BRIDGE_MAX_ASK_QUESTIONS) return null;
  const answers: OmpBridgeQuestionAnswer[] = [];
  for (const entry of value) {
    const answer = parseAskAnswer(entry);
    const id: unknown = isFrameObject(entry) ? entry['id'] : undefined;
    if (answer === null || !isNonEmptyString(id)) return null;
    answers.push({ id, ...answer });
  }
  return answers;
}

/**
 * Frame one prompt body as a chunk sequence the peer can verify end to end.
 *
 * `body` is delivered whole or not at all: the peer checks the length, the
 * digest and every chunk offset against what `begin` announced before it
 * delivers anything. `begin` carries the discriminator for a structured body,
 * so a plain long prompt keeps reassembling as raw text bytes.
 */
function chunkSequence(
  id: string,
  body: Buffer,
  deliverAs: string | undefined,
  begin?: { readonly mode: 'structured'; readonly imageCount: number },
): string {
  const frames: string[] = [
    `${JSON.stringify({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'prompt_begin',
      id,
      totalBytes: body.length,
      ...(begin ? { mode: begin.mode, imageCount: begin.imageCount } : {}),
      ...(deliverAs ? { deliverAs } : {}),
    })}\n`,
  ];
  for (let offset = 0; offset < body.length; offset += OMP_BRIDGE_CHUNK_BYTES) {
    const slice = body.subarray(offset, offset + OMP_BRIDGE_CHUNK_BYTES);
    frames.push(
      `${JSON.stringify({
        v: OMP_BRIDGE_PROTOCOL_VERSION,
        t: 'prompt_chunk',
        id,
        offset,
        data: slice.toString('base64'),
      })}\n`,
    );
  }
  frames.push(
    `${JSON.stringify({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'prompt_end',
      id,
      totalBytes: body.length,
      digest: createHash('sha256').update(body).digest('hex'),
    })}\n`,
  );
  return frames.join('');
}

/**
 * Split a byte stream into newline-delimited frames.
 *
 * A frame above the cap is dropped whole and the reader resynchronizes on the
 * next newline, so one oversized frame costs exactly one frame instead of the
 * channel.
 */
class FrameReader {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  /** True while discarding the tail of an oversized frame. */
  private discarding = false;

  constructor(
    private readonly onFrame: (frame: unknown) => void,
    private readonly onError: (code: ErrorCode) => void,
  ) {}

  push(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (this.discarding) {
        this.discarding = false;
        continue;
      }
      if (line.length === 0) continue;
      // A single write can carry a whole oversized frame, so the cap is charged
      // against the completed line as well as against a partial one.
      if (Buffer.byteLength(line, 'utf8') > OMP_BRIDGE_MAX_FRAME_BYTES) {
        this.onError('frame_too_large');
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.onError('malformed_frame');
        continue;
      }
      this.onFrame(parsed);
    }

    // No newline yet: charge the partial frame against the cap so an endless
    // line cannot grow without bound.
    if (Buffer.byteLength(this.buffer, 'utf8') > OMP_BRIDGE_MAX_FRAME_BYTES) {
      this.onError('frame_too_large');
      this.buffer = '';
      this.discarding = true;
    }
  }
}

interface PendingCall {
  readonly timer: NodeJS.Timeout;
}

interface PendingAbort {
  readonly id: string;
  readonly timer: NodeJS.Timeout;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

/** One outstanding catalog read, waiting for the authenticated extension. */
interface PendingCatalog {
  readonly timer: NodeJS.Timeout;
  readonly resolve: (catalog: OmpBridgeModelCatalog) => void;
  readonly reject: (error: Error) => void;
}

/** One outstanding describe read, waiting for the authenticated extension. */
interface PendingInfo {
  readonly timer: NodeJS.Timeout;
  readonly resolve: (description: OmpBridgeSessionDescription) => void;
  readonly reject: (error: Error) => void;
}

/** One prompt waiting for the extension to report whether OMP took it. */
interface PendingPrompt {
  readonly timer: NodeJS.Timeout;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

/** Narrow a text field to the bounded, non-empty string the describe answer promises. */
function isBoundedText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit;
}

/** Map a reported tool source onto the company's closed set, or refuse it. */
function toolSourceOf(value: unknown): AgentToolInfo['source'] | null {
  switch (value) {
    case 'builtin':
    case 'extension':
    case 'mcp':
    case 'sdk':
    case 'other':
      return value;
    default:
      return null;
  }
}

/**
 * Validate one describe answer. Every field is checked against the caps this
 * module publishes, and one bad field refuses the whole answer: a partly
 * trusted tool list would read as a complete one.
 */
function parseSessionDescription(value: unknown): OmpBridgeSessionDescription | null {
  if (!isFrameObject(value)) return null;
  const cwd = value['cwd'];
  const model = value['model'];
  const thinking = value['thinking'];
  const sessionFile = value['sessionFile'];
  if (!isBoundedText(cwd, OMP_BRIDGE_MAX_INFO_PATH)) return null;
  if (model !== undefined && !isBoundedText(model, OMP_BRIDGE_MAX_INFO_TEXT)) return null;
  if (thinking !== undefined && !isBoundedText(thinking, OMP_BRIDGE_MAX_INFO_TEXT)) return null;
  if (sessionFile !== undefined && !isBoundedText(sessionFile, OMP_BRIDGE_MAX_INFO_PATH)) {
    return null;
  }
  const tools = parseSessionTools(value['tools']);
  const skills = parseSessionSkills(value['skills']);
  if (tools === null || skills === null) return null;
  return {
    cwd,
    ...(typeof model === 'string' ? { model } : {}),
    ...(typeof thinking === 'string' ? { thinking } : {}),
    ...(typeof sessionFile === 'string' ? { sessionFile } : {}),
    tools,
    skills,
  };
}

function parseSessionTools(value: unknown): AgentToolInfo[] | null {
  if (!Array.isArray(value)) return null;
  const entries: readonly unknown[] = value;
  if (entries.length > OMP_BRIDGE_MAX_INFO_ITEMS) return null;
  const tools: AgentToolInfo[] = [];
  for (const entry of entries) {
    if (!isFrameObject(entry)) return null;
    const name = entry['name'];
    const source = toolSourceOf(entry['source']);
    const mcpServer = entry['mcpServer'];
    const active = entry['active'];
    if (!isBoundedText(name, OMP_BRIDGE_MAX_INFO_TEXT) || source === null) return null;
    if (typeof active !== 'boolean') return null;
    if (mcpServer !== undefined && !isBoundedText(mcpServer, OMP_BRIDGE_MAX_INFO_TEXT)) {
      return null;
    }
    tools.push({
      name,
      source,
      ...(typeof mcpServer === 'string' ? { mcpServer } : {}),
      active,
    });
  }
  return tools;
}

function parseSessionSkills(value: unknown): OmpBridgeSessionSkill[] | null {
  if (!Array.isArray(value)) return null;
  const entries: readonly unknown[] = value;
  if (entries.length > OMP_BRIDGE_MAX_INFO_ITEMS) return null;
  const skills: OmpBridgeSessionSkill[] = [];
  for (const entry of entries) {
    if (!isFrameObject(entry)) return null;
    const name = entry['name'];
    const description = entry['description'];
    if (!isBoundedText(name, OMP_BRIDGE_MAX_INFO_TEXT)) return null;
    if (description !== undefined && !isBoundedText(description, OMP_BRIDGE_MAX_INFO_TEXT)) {
      return null;
    }
    skills.push({ name, ...(typeof description === 'string' ? { description } : {}) });
  }
  return skills;
}

/**
 * Host endpoint for one managed session.
 *
 * The endpoint is a local pipe or socket, so the child environment carries a
 * path and a nonce and nothing else: no port, no capability URL, no token a
 * browser could replay. `ready` resolves only once the extension holding the
 * nonce has authenticated, which is the moment a prompt may be delivered.
 */
class OmpBridge implements OmpBridgeHandle {
  readonly endpoint: string;
  readonly nonce: string;
  readonly sessionId: string;
  readonly runEpoch: number;
  readonly role: string;
  readonly childEnv: Readonly<Record<string, string>>;
  readonly ready: Promise<void>;

  private readonly server: net.Server;
  private readonly rpcHandler: OmpBridgeRpcHandler;
  private readonly rpcTimeoutMs: number;
  private readonly readyGate = deferred<void>();
  private readonly handlers = new Set<OmpBridgeEventHandler>();
  private readonly pending = new Map<string, PendingCall>();
  private abortPending: PendingAbort | undefined;
  private abortCounter = 0;
  private readonly pendingCatalogs = new Map<string, PendingCatalog>();
  private readonly pendingPrompts = new Map<string, PendingPrompt>();
  private catalogCounter = 0;
  private readonly pendingInfos = new Map<string, PendingInfo>();
  private infoCounter = 0;
  private readonly handshakeTimer: NodeJS.Timeout;
  private socket: net.Socket | undefined;
  private authenticated = false;
  private disposed = false;

  constructor(options: OmpBridgeOptions) {
    this.sessionId = options.sessionId;
    this.runEpoch = options.runEpoch;
    this.role = options.role;
    this.rpcHandler = options.rpcHandler;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? OMP_BRIDGE_DEFAULT_RPC_TIMEOUT_MS;
    this.nonce = options.nonce ?? randomBytes(32).toString('hex');
    this.endpoint = resolveEndpoint(options, this.nonce);
    this.childEnv = Object.freeze({
      [OMP_BRIDGE_ENV.socket]: this.endpoint,
      [OMP_BRIDGE_ENV.token]: this.nonce,
      [OMP_BRIDGE_ENV.session]: this.sessionId,
      [OMP_BRIDGE_ENV.epoch]: String(this.runEpoch),
      [OMP_BRIDGE_ENV.role]: this.role,
      [OMP_BRIDGE_ENV.rpcTimeoutMs]: String(this.rpcTimeoutMs),
    });
    this.ready = this.readyGate.promise;
    // A bridge disposed before anyone awaits must not surface as an unhandled
    // rejection; callers awaiting `ready` still see the rejection.
    void this.ready.catch(() => undefined);

    this.handshakeTimer = setTimeout(() => {
      this.reportError('omp_bridge_handshake_timeout', ERROR_TEXT.handshake_timeout);
      void this.dispose();
    }, options.handshakeTimeoutMs ?? OMP_BRIDGE_DEFAULT_HANDSHAKE_TIMEOUT_MS);

    this.server = net.createServer((socket) => this.accept(socket));
    this.server.on('error', () => {
      this.reportError('omp_bridge_disconnected', ERROR_TEXT.disconnected);
    });
    this.server.listen(this.endpoint, () => {
      if (process.platform !== 'win32') restrictToOwner(this.endpoint);
    });
  }

  get pendingRpcs(): number {
    return this.pending.size;
  }

  async answerQuestion(input: OmpBridgeAnswerQuestion): Promise<void> {
    this.assertQuestionRun(input.questionId, input.runEpoch);
    const answers = parseQuestionAnswers(input.answers);
    if (answers === null) {
      throw new CompanyError('omp_bridge_question_malformed', ERROR_TEXT.question_malformed);
    }
    await this.writeQuestionFrame('question_result', {
      questionId: input.questionId,
      answers,
    });
  }

  async cancelQuestion(input: OmpBridgeCancelQuestion): Promise<void> {
    this.assertQuestionRun(input.questionId, input.runEpoch);
    if (!isNonEmptyString(input.code)) {
      throw new CompanyError('omp_bridge_question_malformed', ERROR_TEXT.question_malformed);
    }
    await this.writeQuestionFrame('question_cancel', {
      questionId: input.questionId,
      code: input.code,
    });
  }

  /**
   * An answer names the run it was accepted on. A restart mints a new epoch and
   * the native dialog that question belonged to is gone, so delivering it now
   * would answer a turn that no longer exists.
   */
  private assertQuestionRun(questionId: string, runEpoch: number | undefined): void {
    if (!isNonEmptyString(questionId)) {
      throw new CompanyError('omp_bridge_question_malformed', ERROR_TEXT.question_malformed);
    }
    if (runEpoch !== undefined && runEpoch !== this.runEpoch) {
      throw new CompanyError('omp_bridge_stale_run_identity', ERROR_TEXT.stale_run_identity);
    }
    this.liveSocket();
  }

  private async writeQuestionFrame(
    type: 'question_result' | 'question_cancel',
    fields: Record<string, unknown>,
  ): Promise<void> {
    const socket = this.liveSocket();
    await new Promise<void>((resolve, reject) => {
      socket.write(
        `${JSON.stringify({
          v: OMP_BRIDGE_PROTOCOL_VERSION,
          t: type,
          sessionId: this.sessionId,
          runEpoch: this.runEpoch,
          ...fields,
        })}\n`,
        (error) => {
          if (error) reject(new CompanyError('omp_bridge_disconnected', ERROR_TEXT.disconnected));
          else resolve();
        },
      );
    });
  }

  async abort(): Promise<void> {
    const socket = this.liveSocket();
    if (this.abortPending) {
      throw new CompanyError('omp_bridge_abort_pending', ERROR_TEXT.abort_pending);
    }

    const id = `abort-${++this.abortCounter}`;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectAbort(
          id,
          new CompanyError('omp_bridge_abort_timeout', ERROR_TEXT.abort_timeout),
        );
      }, OMP_BRIDGE_ABORT_TIMEOUT_MS);
      timer.unref?.();
      this.abortPending = { id, timer, resolve, reject };

      try {
        socket.write(
          `${JSON.stringify({
            v: OMP_BRIDGE_PROTOCOL_VERSION,
            t: 'abort',
            id,
            sessionId: this.sessionId,
            runEpoch: this.runEpoch,
          })}\n`,
          (error) => {
            if (error) {
              this.rejectAbort(
                id,
                new CompanyError('omp_bridge_disconnected', ERROR_TEXT.disconnected),
              );
            }
          },
        );
      } catch {
        this.rejectAbort(id, new CompanyError('omp_bridge_disconnected', ERROR_TEXT.disconnected));
      }
    });
  }

  async requestModelCatalog(): Promise<OmpBridgeModelCatalog> {
    // The bound is checked before the write so an over-subscribed caller learns
    // immediately instead of joining a queue that will not be drained.
    if (this.pendingCatalogs.size >= OMP_BRIDGE_MAX_PENDING_MODEL_REQUESTS) {
      throw new CompanyError('omp_model_catalog_busy', ERROR_TEXT.catalog_busy);
    }
    const socket = this.liveSocket();
    const id = `catalog-${++this.catalogCounter}`;
    return new Promise<OmpBridgeModelCatalog>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settleCatalogError(id, 'omp_model_catalog_timeout', ERROR_TEXT.catalog_timeout);
      }, OMP_BRIDGE_CATALOG_TIMEOUT_MS);
      timer.unref?.();
      this.pendingCatalogs.set(id, { timer, resolve, reject });
      try {
        socket.write(
          `${JSON.stringify({
            v: OMP_BRIDGE_PROTOCOL_VERSION,
            t: 'models_request',
            id,
            sessionId: this.sessionId,
            runEpoch: this.runEpoch,
          })}\n`,
        );
      } catch {
        this.settleCatalogError(id, 'omp_bridge_disconnected', ERROR_TEXT.disconnected);
      }
    });
  }

  /** Answer one catalog read from the authenticated extension. */
  private receiveModelsResult(frame: Record<string, unknown>): void {
    const id = frame['id'];
    if (!isNonEmptyString(id) || !this.pendingCatalogs.has(id)) return;
    // Identity is checked before the payload: an answer stamped for another run
    // is not this run's catalog, whatever it contains.
    if (frame['sessionId'] !== this.sessionId || frame['runEpoch'] !== this.runEpoch) {
      this.reportError('omp_bridge_stale_run_identity', ERROR_TEXT.stale_run_identity);
      this.settleCatalogError(id, 'omp_bridge_stale_run_identity', ERROR_TEXT.stale_run_identity);
      return;
    }
    if (frame['ok'] !== true) {
      const error = isFrameObject(frame['error']) ? frame['error'] : {};
      const code = isNonEmptyString(error['code'])
        ? error['code']
        : 'omp_model_catalog_unavailable';
      const message = isNonEmptyString(error['message'])
        ? error['message']
        : ERROR_TEXT.catalog_unavailable;
      this.settleCatalogError(id, code, message);
      return;
    }

    const models = parseModelCatalog(frame['catalog']);
    if (models === null) {
      this.reportError('omp_bridge_malformed_frame', ERROR_TEXT.catalog_malformed);
      this.settleCatalogError(id, 'omp_model_catalog_malformed', ERROR_TEXT.catalog_malformed);
      return;
    }
    const pending = this.pendingCatalogs.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingCatalogs.delete(id);
    pending.resolve({ sessionId: this.sessionId, runEpoch: this.runEpoch, models });
  }

  private settleCatalogError(id: string, code: string, message: string): void {
    const pending = this.pendingCatalogs.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingCatalogs.delete(id);
    pending.reject(new CompanyError(code, message));
  }

  /** Release every catalog read still waiting when the channel goes away. */
  private failPendingCatalogs(code: string, message: string): void {
    for (const id of [...this.pendingCatalogs.keys()]) {
      this.settleCatalogError(id, code, message);
    }
  }

  /**
   * Ask the live native session what it has loaded. Rejects rather than
   * answering empty: a missing registry, a malformed answer or another run's
   * answer must never read as "this session has no tools".
   */
  async requestSessionInfo(): Promise<OmpBridgeSessionDescription> {
    // The bound is checked before the write so an over-subscribed caller learns
    // immediately instead of joining a queue that will not be drained.
    if (this.pendingInfos.size >= OMP_BRIDGE_MAX_PENDING_INFO_REQUESTS) {
      throw new CompanyError('omp_session_info_busy', ERROR_TEXT.info_busy);
    }
    const socket = this.liveSocket();
    const id = `info-${++this.infoCounter}`;
    return new Promise<OmpBridgeSessionDescription>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settleInfoError(id, 'omp_session_info_timeout', ERROR_TEXT.info_timeout);
      }, OMP_BRIDGE_INFO_TIMEOUT_MS);
      timer.unref?.();
      this.pendingInfos.set(id, { timer, resolve, reject });
      try {
        socket.write(
          `${JSON.stringify({
            v: OMP_BRIDGE_PROTOCOL_VERSION,
            t: 'info_request',
            id,
            sessionId: this.sessionId,
            runEpoch: this.runEpoch,
          })}\n`,
        );
      } catch {
        this.settleInfoError(id, 'omp_bridge_disconnected', ERROR_TEXT.disconnected);
      }
    });
  }

  /** Answer one describe read from the authenticated extension. */
  private receiveInfoResult(frame: Record<string, unknown>): void {
    const id = frame['id'];
    if (!isNonEmptyString(id) || !this.pendingInfos.has(id)) return;
    // Identity is checked before the payload: an answer stamped for another run
    // is not this run's description, whatever it contains.
    if (frame['sessionId'] !== this.sessionId || frame['runEpoch'] !== this.runEpoch) {
      this.reportError('omp_bridge_stale_run_identity', ERROR_TEXT.stale_run_identity);
      this.settleInfoError(id, 'omp_bridge_stale_run_identity', ERROR_TEXT.stale_run_identity);
      return;
    }
    if (frame['ok'] !== true) {
      const error = isFrameObject(frame['error']) ? frame['error'] : {};
      const code = isNonEmptyString(error['code']) ? error['code'] : 'omp_session_info_unavailable';
      const message = isNonEmptyString(error['message'])
        ? error['message']
        : ERROR_TEXT.info_unavailable;
      this.settleInfoError(id, code, message);
      return;
    }
    const description = parseSessionDescription(frame['info']);
    if (description === null) {
      this.reportError('omp_bridge_malformed_frame', ERROR_TEXT.info_malformed);
      this.settleInfoError(id, 'omp_session_info_malformed', ERROR_TEXT.info_malformed);
      return;
    }
    const pending = this.pendingInfos.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingInfos.delete(id);
    pending.resolve(description);
  }

  private settleInfoError(id: string, code: string, message: string): void {
    const pending = this.pendingInfos.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingInfos.delete(id);
    pending.reject(new CompanyError(code, message));
  }

  /** Release every describe read still waiting when the channel goes away. */
  private failPendingInfos(code: string, message: string): void {
    for (const id of [...this.pendingInfos.keys()]) {
      this.settleInfoError(id, code, message);
    }
  }
  onEvent(handler: OmpBridgeEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Deliver one prompt — text, images, or both — and resolve only once the
   * native session has answered for it.
   *
   * The answer is the point. `sendUserMessage` is fire-and-forget inside OMP, so
   * a write that drained proves nothing: resolving there would report a prompt
   * the session refused as one it took, and the run would go on waiting for a
   * turn that never started. What it proves is what the other half can see:
   * the call reached the runtime and did not throw on the way in; a provider
   * failure afterwards arrives as session activity, not as this answer.
   */
  async sendPrompt(input: OmpBridgeSendPrompt): Promise<void> {
    if (!isNonEmptyString(input.requestId)) {
      throw new CompanyError('omp_bridge_bad_request_id', 'a prompt needs a request id');
    }
    // A restart mints a new epoch, so a prompt composed for the previous run
    // must not land in the session that replaced it.
    if (input.runEpoch !== undefined && input.runEpoch !== this.runEpoch) {
      throw new CompanyError('omp_bridge_stale_run_identity', ERROR_TEXT.stale_run_identity);
    }
    if (typeof input.text !== 'string') {
      throw new CompanyError('omp_bridge_prompt_not_text', ERROR_TEXT.prompt_not_text);
    }
    // Refused here, before the socket is touched at all: a partly delivered
    // image is the model describing an attachment the user attached intact.
    const { images } = validatePromptImages(input.images);
    if (this.pendingPrompts.size >= OMP_BRIDGE_MAX_PENDING_PROMPTS) {
      throw new CompanyError('omp_bridge_too_many_pending', ERROR_TEXT.too_many_pending);
    }
    if (this.pendingPrompts.has(input.requestId)) {
      throw new CompanyError('omp_bridge_duplicate_request_id', ERROR_TEXT.duplicate_request_id);
    }

    const socket = this.liveSocket();
    const deliverAs =
      input.delivery && input.delivery !== 'prompt' ? DELIVER_AS[input.delivery] : undefined;
    const textBytes = Buffer.from(input.text, 'utf8');
    // A small prompt with images travels in one frame; a large one travels as
    // the same chunk sequence a long prompt uses, carrying a structured body
    // the peer digests and verifies before it delivers anything.
    const single = `${JSON.stringify({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'prompt',
      id: input.requestId,
      text: input.text,
      ...(deliverAs ? { deliverAs } : {}),
      ...(images.length > 0 ? { images } : {}),
    })}\n`;

    let payload: string;
    if (Buffer.byteLength(single, 'utf8') <= OMP_BRIDGE_MAX_FRAME_BYTES) {
      payload = single;
    } else if (images.length === 0) {
      // A prompt may be as large as the intake limit, so it travels as a
      // contiguous chunk sequence the peer verifies before it delivers.
      payload = chunkSequence(input.requestId, textBytes, deliverAs);
    } else {
      // Base64 inflates every image by a third, so an attachment that fits the
      // attachment budget can still be several times the frame cap. The body
      // is the whole prompt as one JSON document: one digest covers the text
      // and every image together, so no field can arrive from another prompt.
      const body = Buffer.from(
        JSON.stringify({ v: OMP_BRIDGE_PROTOCOL_VERSION, text: input.text, images }),
        'utf8',
      );
      payload = chunkSequence(input.requestId, body, deliverAs, {
        mode: 'structured',
        imageCount: images.length,
      });
    }

    const id = input.requestId;
    const acked = deferred<void>();
    // A delivery refused before anyone awaits it is still a delivery refused;
    // the catch keeps Node from reading that as an unhandled rejection.
    void acked.promise.catch(() => undefined);
    const timer = setTimeout(() => {
      this.settlePromptError(id, 'omp_bridge_prompt_ack_timeout', ERROR_TEXT.prompt_ack_timeout);
    }, OMP_BRIDGE_PROMPT_ACK_TIMEOUT_MS);
    timer.unref?.();
    this.pendingPrompts.set(id, { timer, resolve: acked.resolve, reject: acked.reject });

    try {
      await new Promise<void>((resolve, reject) => {
        socket.write(payload, (error) => {
          if (error) reject(new CompanyError('omp_bridge_disconnected', ERROR_TEXT.disconnected));
          else resolve();
        });
      });
    } catch (error) {
      this.settlePromptError(id, 'omp_bridge_disconnected', ERROR_TEXT.disconnected);
      throw error;
    }
    await acked.promise;
  }

  /** Settle one prompt delivery from the authenticated extension. */
  private receivePromptResult(frame: Record<string, unknown>): void {
    const id = frame['id'];
    if (!isNonEmptyString(id) || !this.pendingPrompts.has(id)) return;
    // Identity first: an answer stamped for another run is not this run's
    // delivery, whatever it claims.
    if (frame['sessionId'] !== this.sessionId || frame['runEpoch'] !== this.runEpoch) {
      this.reportError('omp_bridge_stale_run_identity', ERROR_TEXT.stale_run_identity);
      this.settlePromptError(id, 'omp_bridge_stale_run_identity', ERROR_TEXT.stale_run_identity);
      return;
    }
    if (frame['ok'] === true) {
      const pending = this.pendingPrompts.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingPrompts.delete(id);
      pending.resolve();
      return;
    }
    const error = isFrameObject(frame['error']) ? frame['error'] : {};
    const code = isNonEmptyString(error['code'])
      ? error['code']
      : 'omp_bridge_prompt_delivery_failed';
    const message = isNonEmptyString(error['message'])
      ? error['message']
      : ERROR_TEXT.prompt_delivery_failed;
    this.settlePromptError(id, code, message);
  }

  private settlePromptError(id: string, code: string, message: string): void {
    const pending = this.pendingPrompts.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingPrompts.delete(id);
    pending.reject(new CompanyError(code, message));
  }

  /** Release every prompt still waiting when the channel goes away. */
  private failPendingPrompts(code: string, message: string): void {
    for (const id of [...this.pendingPrompts.keys()]) {
      this.settlePromptError(id, code, message);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.handshakeTimer);

    // Answer everything still in flight so the extension stops waiting for a
    // decision that can no longer arrive, then drop the channel.
    for (const [id, call] of [...this.pending]) {
      clearTimeout(call.timer);
      this.pending.delete(id);
      this.tryWrite({
        v: OMP_BRIDGE_PROTOCOL_VERSION,
        t: 'rpc_result',
        id,
        ok: false,
        error: { code: 'omp_bridge_disconnected', message: ERROR_TEXT.disconnected },
      });
    }
    if (this.abortPending) {
      this.rejectAbort(
        this.abortPending.id,
        new CompanyError('omp_bridge_disconnected', ERROR_TEXT.disconnected),
      );
    }
    this.failPendingCatalogs('omp_bridge_disconnected', ERROR_TEXT.disconnected);
    this.failPendingInfos('omp_bridge_disconnected', ERROR_TEXT.disconnected);
    this.failPendingPrompts('omp_bridge_disconnected', ERROR_TEXT.disconnected);

    if (!this.authenticated) {
      this.readyGate.reject(new CompanyError('omp_bridge_disposed', ERROR_TEXT.disposed));
    }
    this.authenticated = false;
    this.socket?.destroy();
    this.socket = undefined;
    this.handlers.clear();

    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    removeEndpoint(this.endpoint);
  }

  // ── Connection ────────────────────────────────────────────

  private accept(socket: net.Socket): void {
    if (this.disposed) {
      socket.destroy();
      return;
    }
    // A second connection cannot be the extension this run launched.
    if (this.socket) {
      this.reportError('omp_bridge_duplicate_client', ERROR_TEXT.duplicate_client);
      socket.destroy();
      return;
    }
    this.socket = socket;
    const reader = new FrameReader(
      (frame) => this.receive(frame),
      (code) => this.reportError(`omp_bridge_${code}`, ERROR_TEXT[code]),
    );
    // The socket is never put in string mode, so `data` is always a Buffer.
    socket.on('data', (chunk) => reader.push(chunk as Buffer));
    socket.on('error', () => this.drop());
    socket.on('close', () => this.drop());
  }

  private drop(): void {
    if (this.disposed) return;
    this.socket = undefined;
    this.authenticated = false;
    for (const [id, call] of [...this.pending]) {
      clearTimeout(call.timer);
      this.pending.delete(id);
    }
    if (this.abortPending) {
      this.rejectAbort(
        this.abortPending.id,
        new CompanyError('omp_bridge_disconnected', ERROR_TEXT.disconnected),
      );
    }
    this.failPendingCatalogs('omp_bridge_disconnected', ERROR_TEXT.disconnected);
    this.failPendingInfos('omp_bridge_disconnected', ERROR_TEXT.disconnected);
    this.failPendingPrompts('omp_bridge_disconnected', ERROR_TEXT.disconnected);
    this.reportError('omp_bridge_disconnected', ERROR_TEXT.disconnected);
  }

  private liveSocket(): net.Socket {
    const socket = this.socket;
    if (!socket || socket.destroyed || !this.authenticated) {
      throw new CompanyError('omp_bridge_disconnected', ERROR_TEXT.disconnected);
    }
    return socket;
  }

  // ── Receive ───────────────────────────────────────────────

  private receive(value: unknown): void {
    if (!isFrameObject(value) || value['v'] !== OMP_BRIDGE_PROTOCOL_VERSION) {
      this.reportError('omp_bridge_malformed_frame', ERROR_TEXT.malformed_frame);
      return;
    }
    const type = value['t'];
    if (!isNonEmptyString(type)) {
      this.reportError('omp_bridge_malformed_frame', ERROR_TEXT.malformed_frame);
      return;
    }
    if (type === 'hello') {
      this.receiveHello(value);
      return;
    }
    if (!this.authenticated) {
      this.reportError('omp_bridge_unauthenticated', ERROR_TEXT.unauthenticated);
      return;
    }
    if (type === 'rpc') {
      this.receiveRpc(value);
      return;
    }
    if (type === 'abort_result') {
      this.receiveAbortResult(value);
      return;
    }
    if (type === 'prompt_result') {
      this.receivePromptResult(value);
      return;
    }
    if (type === 'models_result') {
      this.receiveModelsResult(value);
      return;
    }
    if (type === 'info_result') {
      this.receiveInfoResult(value);
      return;
    }
    if (type === 'event') {
      this.receiveEvent(value['event']);
      return;
    }
    this.reportError('omp_bridge_unknown_frame', ERROR_TEXT.unknown_frame);
  }

  private receiveHello(frame: Record<string, unknown>): void {
    if (
      this.authenticated ||
      frame['sessionId'] !== this.sessionId ||
      frame['runEpoch'] !== this.runEpoch ||
      !secretsMatch(this.nonce, frame['nonce'])
    ) {
      this.reportError('omp_bridge_bad_handshake', ERROR_TEXT.bad_handshake);
      this.socket?.destroy();
      return;
    }
    this.authenticated = true;
    clearTimeout(this.handshakeTimer);
    this.tryWrite({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'ack',
      sessionId: this.sessionId,
      runEpoch: this.runEpoch,
    });
    this.readyGate.resolve();
  }

  private receiveAbortResult(frame: Record<string, unknown>): void {
    const pending = this.abortPending;
    if (!pending || frame['id'] !== pending.id) return;
    if (frame['sessionId'] !== this.sessionId || frame['runEpoch'] !== this.runEpoch) {
      this.reportError('omp_bridge_stale_run_identity', ERROR_TEXT.stale_run_identity);
      return;
    }

    clearTimeout(pending.timer);
    this.abortPending = undefined;
    if (frame['ok'] === true) {
      pending.resolve();
      return;
    }
    pending.reject(new CompanyError('omp_bridge_abort_failed', ERROR_TEXT.abort_failed));
  }

  private rejectAbort(id: string, error: Error): void {
    const pending = this.abortPending;
    if (!pending || pending.id !== id) return;
    clearTimeout(pending.timer);
    this.abortPending = undefined;
    pending.reject(error);
  }

  private receiveEvent(value: unknown): void {
    if (!isFrameObject(value) || !isNonEmptyString(value['k'])) {
      this.reportError('omp_bridge_malformed_frame', ERROR_TEXT.malformed_frame);
      return;
    }
    this.emit(value as unknown as OmpBridgeEvent);
  }

  private receiveRpc(frame: Record<string, unknown>): void {
    const id = frame['id'];
    const params = frame['params'];
    if (!isNonEmptyString(id) || id.length > 128 || !isFrameObject(params)) {
      this.reportError('omp_bridge_malformed_frame', ERROR_TEXT.malformed_frame);
      return;
    }
    if (params['sessionId'] !== this.sessionId || params['runEpoch'] !== this.runEpoch) {
      this.reportError('omp_bridge_stale_run_identity', ERROR_TEXT.stale_run_identity);
      return;
    }
    if (this.pending.has(id)) {
      this.answerError(id, 'omp_bridge_duplicate_request_id', ERROR_TEXT.duplicate_request_id);
      return;
    }
    if (this.pending.size >= OMP_BRIDGE_MAX_PENDING_RPCS) {
      this.answerError(id, 'omp_bridge_too_many_pending', ERROR_TEXT.too_many_pending);
      return;
    }

    const request = this.parseRpcRequest(id, frame['method'], params);
    if (!request) {
      this.reportError('omp_bridge_malformed_frame', ERROR_TEXT.malformed_frame);
      return;
    }
    if (request.method === 'company_tool') {
      // The peer is not the authority: the claimed role must be this run's
      // role, and the tool must belong to that role.
      if (request.role !== this.role) {
        this.answerError(id, 'omp_bridge_role_mismatch', ERROR_TEXT.role_mismatch);
        return;
      }
      const owner = COMPANY_BRIDGE_TOOL_ROLES[request.toolName];
      if (owner === undefined) {
        this.answerError(id, 'omp_bridge_unknown_tool', ERROR_TEXT.unknown_tool);
        return;
      }
      if (owner !== '*' && owner !== this.role) {
        this.answerError(id, 'omp_bridge_tool_role_forbidden', ERROR_TEXT.tool_role_forbidden);
        return;
      }
    }

    const timer = setTimeout(() => {
      this.pending.delete(id);
      this.answerError(id, 'omp_bridge_rpc_timeout', ERROR_TEXT.rpc_timeout);
    }, this.rpcTimeoutMs);
    this.pending.set(id, { timer });

    void (async () => {
      try {
        const result = await this.rpcHandler(request);
        this.answer(id, result);
      } catch (error) {
        // A Company refusal is already a precise, non-sensitive statement about
        // what the caller must fix. Collapsing it into "the host failed" told the
        // Director nothing it could act on, so both the code and the message are
        // passed through for a typed domain error. Anything else stays generic.
        const domain = error instanceof CompanyError;
        const code =
          error instanceof OmpBridgeRpcError
            ? error.code
            : domain
              ? error.code
              : 'omp_bridge_rpc_failed';
        const message =
          error instanceof OmpBridgeRpcError || domain ? error.message : ERROR_TEXT.rpc_failed;
        this.answerError(id, code, message);
        if (!(error instanceof OmpBridgeRpcError) && !domain) {
          // The model only ever learns "the host failed". Without this the
          // operator has no way to learn what actually broke either.
          console.error('[OmpBridge] Company RPC threw unexpectedly.', error);
        }
      }
    })();
  }

  /**
   * Build the typed request from the frame's own `method` and its `params`, or
   * return null when the frame is not one of ours. The method travels at the
   * frame level; `params` carries the run identity and the arguments.
   */
  private parseRpcRequest(
    id: string,
    method: unknown,
    params: Record<string, unknown>,
  ): OmpBridgeRpcRequest | null {
    const identity = { sessionId: this.sessionId, runEpoch: this.runEpoch, id };
    const toolCallId = params['toolCallId'];
    const toolName = params['toolName'];

    if (method === 'authorize_tool') {
      if (
        !isNonEmptyString(toolCallId) ||
        !isNonEmptyString(toolName) ||
        !isFrameObject(params['input'])
      ) {
        return null;
      }
      return {
        ...identity,
        method,
        toolCallId,
        toolName,
        input: params['input'],
        ...(isNonEmptyString(params['agentKind']) ? { agentKind: params['agentKind'] } : {}),
      };
    }
    if (method === 'company_tool') {
      if (
        !isNonEmptyString(toolCallId) ||
        !isNonEmptyString(toolName) ||
        !isNonEmptyString(params['role']) ||
        !isFrameObject(params['payload'])
      ) {
        return null;
      }
      return {
        ...identity,
        method,
        toolCallId,
        toolName,
        role: params['role'],
        payload: params['payload'],
      };
    }
    if (method === 'authorize_subagent') {
      const patterns = params['patterns'];
      if (
        !isNonEmptyString(params['agent']) ||
        (params['invocationKind'] !== 'task' && params['invocationKind'] !== 'eval') ||
        !Array.isArray(patterns) ||
        !patterns.every((pattern) => typeof pattern === 'string')
      ) {
        return null;
      }
      return {
        ...identity,
        method,
        agent: params['agent'],
        invocationKind: params['invocationKind'],
        patterns,
        ...(isNonEmptyString(params['modelRole']) ? { modelRole: params['modelRole'] } : {}),
        ...(isNonEmptyString(params['spawnKey']) ? { spawnKey: params['spawnKey'] } : {}),
      };
    }
    if (method === 'publish_question') {
      const questions = parseAskQuestions(params['questions']);
      if (!isNonEmptyString(toolCallId) || questions === null) return null;
      return { ...identity, method, toolCallId, questions };
    }
    if (method === 'answer_question') {
      const questionId = params['questionId'];
      const answer = parseAskAnswer(params['answer']);
      if (!isNonEmptyString(toolCallId) || !isNonEmptyString(questionId) || answer === null) {
        return null;
      }
      return { ...identity, method, toolCallId, questionId, answer };
    }
    if (method === 'cancel_question') {
      const questionId = params['questionId'];
      const code = params['code'];
      if (
        !isNonEmptyString(toolCallId) ||
        !isNonEmptyString(questionId) ||
        !isNonEmptyString(code)
      ) {
        return null;
      }
      return { ...identity, method, toolCallId, questionId, code };
    }
    return null;
  }

  // ── Send ──────────────────────────────────────────────────

  private answer(id: string, result: unknown): void {
    const call = this.pending.get(id);
    if (!call) return;
    clearTimeout(call.timer);
    this.pending.delete(id);
    this.tryWrite({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'rpc_result',
      id,
      ok: true,
      result: result ?? null,
    });
  }

  private answerError(id: string, code: string, message: string): void {
    this.tryWrite({
      v: OMP_BRIDGE_PROTOCOL_VERSION,
      t: 'rpc_result',
      id,
      ok: false,
      error: { code, message },
    });
  }

  private tryWrite(frame: unknown): void {
    const socket = this.socket;
    if (!socket || socket.destroyed) return;
    socket.write(`${JSON.stringify(frame)}\n`);
  }

  private emit(event: OmpBridgeEvent): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(event);
      } catch {
        // A subscriber must never be able to take the bridge down.
      }
    }
  }

  private reportError(code: string, message: string): void {
    this.emit({ k: 'error', code, message });
  }
}

/** Named pipe on Windows, owner-only socket file inside the namespace on POSIX. */
function resolveEndpoint(options: OmpBridgeOptions, nonce: string): string {
  if (options.endpoint) return options.endpoint;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\pixel-agents-company-${nonce.slice(0, 32)}`;
  }
  if (!options.socketDir) {
    throw new CompanyError(
      'omp_bridge_socket_dir_missing',
      'a POSIX company bridge needs a socketDir inside its namespace',
    );
  }
  return path.join(options.socketDir, `omp-bridge-${nonce.slice(0, 16)}.sock`);
}

/** POSIX only: the socket stays reachable by its owner and nobody else. */
function restrictToOwner(endpoint: string): void {
  try {
    fs.chmodSync(endpoint, 0o600);
  } catch {
    // A namespace already restricted to the owner needs no second lock.
  }
}

/** Remove the socket file a disposed bridge left behind; pipes need no cleanup. */
function removeEndpoint(endpoint: string): void {
  if (process.platform === 'win32') return;
  try {
    fs.unlinkSync(endpoint);
  } catch {
    // Already gone, or never created because the listen never happened.
  }
}

export function createOmpBridge(options: OmpBridgeOptions): OmpBridgeHandle {
  return new OmpBridge(options);
}
