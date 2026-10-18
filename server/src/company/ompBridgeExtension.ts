/**
 * ompBridgeExtension: the extension half of the in-process OMP bridge.
 *
 * OMP loads this module through `--extension dist/company/omp-bridge.mjs` and
 * hands the factory the injected `ExtensionAPI`. The extension does five jobs
 * and nothing else:
 *
 *  1. **Authenticate.** Read the endpoint and nonce from the environment the
 *     host put in the child env, then present `hello` with the session id and
 *     run epoch. The host's `ready` promise is the gate: nothing is delivered
 *     to a session that has not authenticated.
 *  2. **Ask the host for every effectful decision.** `tool_call` is refused
 *     unless the host allows it, with the exact tool name, raw input and tool
 *     call id; `before_subagent_spawn` is refused unless the host allows that
 *     spawn. A disconnect, a timeout, or an answer the host never made all
 *     resolve to "blocked" — the extension never decides an effect itself and
 *     never falls back to allowing it.
 *  3. **Offer the company tools.** Five role-scoped tools whose execution is a
 *     host RPC; the host validates the payload and applies the state change.
 *     A role cannot invoke another role's tool, and a native subagent cannot
 *     invoke any of them.
 *  4. **Report what the session is doing.** Ordered, bounded stream/tool/session
 *     and raw usage events. Text deltas are coalesced on a short flush and split
 *     into byte-bounded frames instead of being forwarded per token.
 *  5. **Answer the host's model catalog request.** Only a process inside OMP
 *     can read the runtime's own credential-filtered model set, so
 *     `ctx.models.list()` is queried here and projected down to the five facts
 *     a company decision needs: which models exist, what each takes as input,
 *     which thinking efforts it declares, and whether its provider has a
 *     credential. Base urls, prices and headers never leave this process.
 *
 * Constraints that shape the code:
 *
 *  - **Node built-ins and the injected API only.** This file is bundled
 *    standalone, so it may not import the OMP package, the host bridge, or
 *    anything else. It imports `node:net` and `node:crypto` and otherwise uses
 *    only `pi` — including `pi.zod` for tool parameter schemas, so no schema
 *    package is pulled in either.
 *  - **A disconnect never crashes the user's OMP process.** Every socket
 *    callback and every event handler is wrapped; a send failure is reported
 *    once and the session continues without a host. There is no silent
 *    reconnect to another endpoint and no local fallback that would perform an
 *    effect the host did not approve.
 *
 * Handler and tool shapes come from the installed OMP 18.4.9 `ExtensionAPI`:
 * `ToolCallEventResult` (`block`/`reason`/`input`), `BeforeSubagentSpawnEventResult`
 * (`block`/`reason`), `ExtensionAgentIdentity.kind`, `SendUserMessageOptions.deliverAs`
 * (`steer` | `followUp` | `aside`) and `ToolDefinition.execute`.
 *
 *  6. **Answer every prompt delivery.** `pi.sendUserMessage` is
 *     fire-and-forget in 18.4.9, so a prompt the session refused would leave
 *     the host believing a turn started. Each prompt id gets exactly one
 *     `prompt_result`: `ok` after the native call, a static refusal code when
 *     the frames were unusable or the native call threw. Image bytes are
 *     handed over as `ImageContent` blocks — the only shape the session
 *     forwards to a provider — never as a path, a link or a data url.
 */

import { createHash } from 'node:crypto';
import * as net from 'node:net';

const PROTOCOL_VERSION = 1;
const DEFAULT_RPC_TIMEOUT_MS = 120_000;
const DEFAULT_CONNECT_ATTEMPTS = 40;
const DEFAULT_CONNECT_RETRY_MS = 50;
/** Largest single text frame, in bytes; larger deltas become several frames. */
const TEXT_FRAME_BYTES = 16 * 1024;
/** Coalescing window for streamed deltas; keeps token churn off the pipe. */
const TEXT_FLUSH_MS = 80;
/** How often a finished turn is re-checked until OMP's prompt has unwound. */
const IDLE_RECHECK_MS = 50;
/** Wire frames larger than this are not bridge frames and are not buffered. */
const MAX_INBOUND_FRAME_BYTES = 1024 * 1024;

// ── Injected OMP surface (structural only; erased at build time) ──

/** The subset of OMP's `ExtensionContext` the bridge reads. */
interface OmpContext {
  agent?: { kind?: string };
  abort?: () => void;
  isIdle?: () => boolean;
  hasPendingMessages?: () => boolean;
  getAsyncJobSnapshot?: () => { running?: unknown[] } | null;
  sessionManager?: {
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
  };
  /**
   * Installed 18.4.9 `ExtensionContext.models` (`ExtensionModelQuery`). `list()`
   * is the only credential-filtered model set OMP exposes to an extension: it
   * is `modelRegistry.getAvailable()`, the same set `--model` selection sees.
   */
  models?: { list?: () => unknown };
  /**
   * Installed 18.4.9 `ExtensionContext.modelRegistry`. `hasConfiguredAuth` is
   * the side-effect-free credential probe (no key resolution, no command run,
   * no OAuth refresh) an extension is meant to pre-flight a model with.
   */
  modelRegistry?: { hasConfiguredAuth?: (model: unknown) => boolean };
  /**
   * Installed 18.4.9 `ExtensionContext.invokeTool`. Present only on a tool
   * that re-registers a built-in of the SAME name — the SDK binds it to this
   * tool's name so it reaches the unwrapped native `execute`, inheriting the
   * caller's granted approval instead of re-running the gate. The bridge's
   * `ask` wrapper depends on exactly this: without it there is no native ask to
   * delegate to, and the call fails closed rather than inventing a dialog.
   */
  invokeTool?: (
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal; onUpdate?: (update: unknown) => void },
  ) => Promise<OmpNativeToolResult>;
  /** Whether an interactive surface exists; a headless run has no dialog. */
  hasUI?: boolean;
  /** Current model (`ExtensionContext.model`); undefined until one is selected. */
  model?: { id?: unknown; provider?: unknown };
}

// ── Native model catalog ──────────────────────────────────────
/**
 * Model rows one catalog answer may carry. Mirrors `OMP_BRIDGE_MAX_CATALOG_MODELS`
 * in the host half, which is the exported constant the host enforces on the
 * answer; this side refuses to build anything larger so an oversized catalog is
 * a reported refusal instead of a dropped frame.
 */
const CATALOG_MAX_MODELS = 2048;
/** Serialized ceiling for one answer; below the 256 KiB bridge frame cap. */
const CATALOG_MAX_BYTES = 192 * 1024;

/**
 * The Contract a Director submits, written for the model that has to author it.
 * It mirrors what `normalizeContractProposal` and the contract validator in the
 * host check, so a first submission can be right instead of found by refusal.
 */
const CONTRACT_PROPOSAL_SHAPE = [
  'A JSON OBJECT (not a string). Every id you create is a fresh UUID; reference ids exactly.',
  '{"title":string,"summary":string,',
  '"requirements":[{"id":uuid,"promptId":<prompt id from your instruction>,"fragmentIds":[<fragment ids>],"text":string,"kind":"goal"|"constraint"|"context","status":"open"}],',
  "  every fragment listed in your instruction must appear in exactly one requirement's fragmentIds;",
  '"phases":[{"id":uuid,"title":string,"ordinal":0,"taskIds":[],"acceptanceIds":[<criterion ids>]}],',
  '"tasks":[{"id":uuid,"phaseId":<phase id>,"title":string,"requirementIds":[...],"dependsOn":[<task ids>],"workstreamId":string,',
  '  "readScopes":[{"path":string,"kind":"file"|"directory","operations":["read"|"list"|"search"]}],',
  '  "writeScopes":[{"path":<workspace-relative>,"kind":"file"|"directory","operations":["create"|"modify"]}],',
  '  "sharedResources":[],"acceptance":[<criterion ids>],"executionMode":"session"|"inline"|"subagent","routeReason":string}],',
  '"acceptance":[{"id":uuid,"requirementIds":[...],"description":string,"kind":"command"|"surface"|"review","required":boolean}],',
  '  "done" is earned only from a command that exited 0: every task needs at least one required "command" criterion bound to a profile;',
  '  "review"/"surface" criteria are notes for reviewers and must be required:false;',
  '"verificationProfiles":{<criterion id>:{"profileId":<a profile id listed in your instruction>}},',
  '  with no profile listed nothing can be proven: ask the user with company_ask_user to add a check (e.g. a package.json "test" script) instead of submitting;',
  '"assumptions":[string],"decisions":[string],"risks":[string]}',
].join('\n');

/**
 * The subset of an OMP `Model` the catalog projects. Everything else on the
 * row — `baseUrl`, `cost`, `headers`, `resolveHeaders`, every account id —
 * stays inside the OMP process: the host learns which models exist and what
 * they can take, never how to reach them or what they are billed.
 */
interface OmpCatalogModel {
  id: string;
  provider: string;
  model: string;
  input: string[];
  thinkingLevels?: string[];
  configured: boolean;
}

/** Read a string array field, or `undefined` when it is absent/malformed. */
function readStringArray(source: Record<string, unknown>, key: string): string[] | undefined {
  const value = source[key];
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item): item is string => typeof item === 'string')) return undefined;
  return value;
}

/**
 * Project one runtime `Model` row, or `null` when it is not a usable row.
 *
 * `id` and `provider` are required because they are the company selector
 * (`provider/model`) a role profile requests; a row without them cannot be
 * named, let alone selected. `input` is required for the same reason the image
 * gate is not a guess: an absent modality list is not a text-only claim.
 *
 * Thinking levels are OMP's `getSupportedEfforts` read from baked fields:
 * a non-reasoning model, or a reasoning one whose `thinking` config is absent,
 * offers no effort — never an invented default.
 */
function projectCatalogModel(row: unknown, ctx: OmpContext): OmpCatalogModel | null {
  if (!isFrameObject(row)) return null;
  const id = readString(row, 'id');
  const provider = readString(row, 'provider');
  const input = readStringArray(row, 'input');
  if (!id || !provider || input === undefined) return null;

  const hasConfiguredAuth = ctx.modelRegistry?.hasConfiguredAuth;
  const projected: OmpCatalogModel = {
    id: `${provider}/${id}`,
    provider,
    model: id,
    input,
    // `list()` is already the credential-filtered set, so presence in it is
    // the runtime's own availability statement. The registry probe refines it
    // where the runtime exposes one and is never consulted otherwise.
    configured:
      typeof hasConfiguredAuth === 'function'
        ? hasConfiguredAuth.call(ctx.modelRegistry, row) === true
        : true,
  };

  const efforts =
    row['reasoning'] === true
      ? readStringArray(readObject(row, 'thinking') ?? {}, 'efforts')
      : undefined;
  if (efforts && efforts.length > 0) projected.thinkingLevels = efforts;
  return projected;
}

/** A catalog refusal: a static code and a static sentence, like every other. */
interface CatalogRefusal {
  readonly code: string;
  readonly message: string;
}

const CATALOG_REFUSAL = {
  capability_missing:
    'this OMP session exposes no model query, so the runtime catalog cannot be read',
  malformed: 'the runtime model list did not have the shape the catalog requires',
  unavailable: 'the runtime model registry could not be read',
  too_large: 'the runtime model list does not fit one catalog answer',
} as const;

/**
 * Build the catalog answer for a `models_request`, or refuse.
 *
 * Every failure here is a refusal: a context without the model facade, a
 * registry that throws, a list that is not an array, a row that cannot be
 * named, and a list too large for one frame all stop the answer instead of
 * degrading into a shorter — or empty — catalog the host would present as
 * what the runtime offers.
 */
function buildCatalogAnswer(
  ctx: OmpContext | undefined,
): { models: OmpCatalogModel[] } | CatalogRefusal {
  if (!ctx || typeof ctx.models?.list !== 'function') {
    return { code: 'omp_model_capability_missing', message: CATALOG_REFUSAL.capability_missing };
  }

  let listed: unknown;
  try {
    listed = ctx.models.list();
  } catch {
    return { code: 'omp_model_catalog_unavailable', message: CATALOG_REFUSAL.unavailable };
  }
  if (!Array.isArray(listed)) {
    return { code: 'omp_model_catalog_malformed', message: CATALOG_REFUSAL.malformed };
  }
  if (listed.length > CATALOG_MAX_MODELS) {
    return { code: 'omp_model_catalog_too_large', message: CATALOG_REFUSAL.too_large };
  }

  const models: OmpCatalogModel[] = [];
  for (const row of listed) {
    const projected = projectCatalogModel(row, ctx);
    if (!projected) {
      return { code: 'omp_model_catalog_malformed', message: CATALOG_REFUSAL.malformed };
    }
    models.push(projected);
  }
  if (Buffer.byteLength(JSON.stringify(models), 'utf8') > CATALOG_MAX_BYTES) {
    return { code: 'omp_model_catalog_too_large', message: CATALOG_REFUSAL.too_large };
  }
  return { models };
}

/** The subset of OMP's `ToolCallEventResult` the bridge returns. */
interface OmpToolGateResult {
  block?: boolean;
  reason?: string;
  input?: Record<string, unknown>;
}

/** The subset of OMP's `BeforeSubagentSpawnEventResult` the bridge returns. */
interface OmpSpawnGateResult {
  block?: boolean;
  reason?: string;
}

interface OmpToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  /** Structured tool output OMP renders and the runtime may read. */
  details?: Record<string, unknown>;
}

/**
 * What a delegated native `ask` returns. `details` is the native tool's own
 * `AskToolDetails`: one entry per question with the options it offered and the
 * labels the user chose. Reading it is reading a structure the native tool
 * built — never scraping the rendered text it displays.
 */
interface OmpNativeToolResult {
  content?: { type: 'text'; text: string }[];
  details?: {
    results?: {
      id?: string;
      question?: string;
      options?: string[];
      multi?: boolean;
      selectedOptions?: string[];
      customInput?: string;
      note?: string;
      timedOut?: boolean;
    }[];
    cancelled?: boolean;
  };
}

interface OmpToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  /**
   * OMP 18.11 presents extension tools as `xd://` devices by default
   * ("discoverable"), reached through the built-in `write` tool. The tool gate
   * then sees `write`, not the company tool, and refuses it as an effect.
   * `"essential"` keeps a tool a top-level call the gate can name.
   */
  loadMode?: 'essential' | 'discoverable';
  /**
   * OMP's own approval tier; omitted means `"exec"`. Company runs pass
   * `--approval-mode write`, so an `"exec"` tool stops on an approval dialog in
   * a terminal nobody is watching. Company tools only record company state and
   * every call still passes the host's tool gate, so they declare `"write"`.
   */
  approval?: 'read' | 'write' | 'exec';
  execute(
    toolCallId: string,
    params: unknown,
    ...rest: unknown[]
  ): Promise<OmpToolResult> | OmpToolResult;
}

/** The `pi-ai` content blocks an extension may hand the session. */
interface OmpTextContent {
  type: 'text';
  text: string;
}

interface OmpImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

/**
 * The Zod-like builder OMP injects as `pi.zod`: an ArkType-backed schema with
 * the zod-v4 fluent surface (`optional`, `describe`, `min`), which is what a
 * registered tool's `parameters` must be.
 */
interface OmpSchema {
  describe(description: string): OmpSchema;
  optional(): OmpSchema;
  min(bound: number): OmpSchema;
}

interface OmpZod {
  record(value: unknown): OmpSchema;
  unknown(): OmpSchema;
  string(): OmpSchema;
  number(): OmpSchema;
  boolean(): OmpSchema;
  array(element: OmpSchema): OmpSchema;
  object(shape: Record<string, OmpSchema>): OmpSchema;
}

interface OmpApi {
  zod: OmpZod;
  logger: {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  registerTool(tool: OmpToolDefinition): void;
  on(event: string, handler: (event: unknown, ctx: OmpContext) => unknown): void;
  sendUserMessage(
    content: string | (OmpTextContent | OmpImageContent)[],
    options?: { deliverAs?: string },
  ): void;
  /** Names of the tools OMP exposes to the model right now. */
  getActiveTools?(): unknown;
  /** Every registered tool with its `sourceInfo`, as OMP's `getAllTools()` returns them. */
  getAllTools?(): unknown;
  /** Slash commands, including one `source: 'skill'` entry per loaded skill. */
  getCommands?(): unknown;
  /** Current thinking level, when one is set. */
  getThinkingLevel?(): unknown;
}

// ── Frame readers (host frames are external input) ──────────────

function isFrameObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStrings(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function readObject(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = source[key];
  return isFrameObject(value) ? value : undefined;
}

/** Longest name, model or description text one describe answer carries. */
const DESCRIBE_TEXT_LIMIT = 300;
/** Tools and skills one describe answer carries; the host enforces the same cap. */
const DESCRIBE_ITEM_LIMIT = 500;
const SKILL_URL_PREFIX = 'skill://';
const SKILL_COMMAND_PREFIX = 'skill:';
const MCP_TOOL_PREFIX = 'mcp__';

/** One tool the native session has registered, as the host reports it. */
interface DescribedTool {
  name: string;
  source: 'builtin' | 'extension' | 'mcp' | 'sdk' | 'other';
  mcpServer?: string;
  active: boolean;
}

/** One loaded skill. */
interface DescribedSkill {
  name: string;
  description?: string;
}

/** Everything the describe answer carries about one native session. */
interface SessionDescription {
  cwd: string;
  model?: string;
  thinking?: string;
  sessionFile?: string;
  tools: DescribedTool[];
  skills: DescribedSkill[];
}

function asList(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function clampText(value: string): string {
  return value.slice(0, DESCRIBE_TEXT_LIMIT);
}

/** Source class of one registered tool; a tool with no metadata named `mcp__…` is MCP. */
function describedSource(tool: Record<string, unknown>, name: string): DescribedTool['source'] {
  const sourceInfo = readObject(tool, 'sourceInfo');
  const declared = sourceInfo === undefined ? undefined : readString(sourceInfo, 'source');
  if (declared === undefined) return name.startsWith(MCP_TOOL_PREFIX) ? 'mcp' : 'other';
  switch (declared) {
    case 'builtin':
    case 'extension':
    case 'mcp':
    case 'sdk':
      return declared;
    default:
      return 'other';
  }
}

/**
 * MCP server of one tool. Metadata wins when OMP supplies it; otherwise the
 * server comes from the canonical `mcp__<server>_<tool>` name. OMP sanitizes the
 * server into that prefix, so a server whose name holds `-` or `_` is only
 * recovered up to its first separator.
 */
function describedMcpServer(tool: Record<string, unknown>, name: string): string | undefined {
  const declared = readString(tool, 'mcpServerName');
  if (declared !== undefined && declared.length > 0) return clampText(declared);
  if (!name.startsWith(MCP_TOOL_PREFIX)) return undefined;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const cut = rest.indexOf('_');
  return cut > 0 ? clampText(rest.slice(0, cut)) : undefined;
}

/** Skill a `read` of a `skill://` URL addresses; undefined for every other read. */
function skillReadName(toolName: string, args: unknown): string | undefined {
  if (toolName !== 'read' || !isFrameObject(args)) return undefined;
  const target = readString(args, 'path');
  if (target === undefined || !target.startsWith(SKILL_URL_PREFIX)) return undefined;
  // The name ends at the first separator or selector: `skill://name/file`, `skill://name:10-20`.
  const name = target.slice(SKILL_URL_PREFIX.length).split(/[/:?]/, 1)[0] ?? '';
  return name.length > 0 && name.length <= DESCRIBE_TEXT_LIMIT ? name : undefined;
}

/** Reads the `{allow, reason, input}` shape a host authorization answers with. */
function readAuthorization(value: unknown): {
  allow: boolean;
  reason?: string;
  input?: Record<string, unknown>;
} {
  if (!isFrameObject(value) || value['allow'] !== true) {
    return isFrameObject(value) && typeof value['reason'] === 'string'
      ? { allow: false, reason: value['reason'] }
      : { allow: false };
  }
  const input = value['input'];
  return isFrameObject(input) ? { allow: true, input } : { allow: true };
}

function readUsageRecord(value: unknown): Record<string, unknown> | null {
  if (!isFrameObject(value)) return null;
  const usage = value['usage'];
  if (!isFrameObject(usage)) return null;
  return {
    k: 'usage',
    model: readString(value, 'model'),
    provider: readString(value, 'provider'),
    responseId: readString(value, 'responseId'),
    input: readNumber(usage, 'input') ?? 0,
    output: readNumber(usage, 'output') ?? 0,
    cacheRead: readNumber(usage, 'cacheRead') ?? 0,
    cacheWrite: readNumber(usage, 'cacheWrite') ?? 0,
    totalTokens: readNumber(usage, 'totalTokens'),
    contextTokens: readNumber(usage, 'contextTokens'),
    costUsd: readNumber(readObject(usage, 'cost') ?? {}, 'total'),
  };
}

/** Reads the `{type:'text_delta', delta}` shape of a streamed assistant event. */
function readTextDelta(value: unknown): string | null {
  if (!isFrameObject(value)) return null;
  if (value['type'] !== 'text_delta') return null;
  const delta = value['delta'];
  return typeof delta === 'string' ? delta : null;
}

/**
 * A refusal the host returned. `message` is the host's own sentence — the
 * reason a permission or a role check produced — and is what the model reads;
 * `code` is the stable identifier a caller can branch on.
 */
class BridgeFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string | undefined) {
    super(message ? `${code}: ${message}` : code);
    this.name = 'BridgeFailure';
    this.code = code;
  }
}

export default function ompBridgeExtension(pi: OmpApi): void {
  const endpoint = process.env['PIXEL_AGENTS_OMP_BRIDGE_SOCKET'];
  const nonce = process.env['PIXEL_AGENTS_OMP_BRIDGE_TOKEN'];
  const sessionId = process.env['PIXEL_AGENTS_OMP_BRIDGE_SESSION'];
  const runEpoch = Number(process.env['PIXEL_AGENTS_OMP_BRIDGE_EPOCH']);
  const role = process.env['PIXEL_AGENTS_OMP_BRIDGE_ROLE'] ?? '';
  // Chat is the one role the user drives like plain omp: no company tools, no
  // ask wrapper, and no authorization round trip for its native tools or subagents.
  const userDriven = role === 'chat';
  const rpcTimeoutMs = positiveNumber(
    process.env['PIXEL_AGENTS_OMP_BRIDGE_RPC_TIMEOUT_MS'],
    DEFAULT_RPC_TIMEOUT_MS,
  );
  let connectAttempts = positiveNumber(
    process.env['PIXEL_AGENTS_OMP_BRIDGE_CONNECT_ATTEMPTS'],
    DEFAULT_CONNECT_ATTEMPTS,
  );
  let connectRetryMs = positiveNumber(
    process.env['PIXEL_AGENTS_OMP_BRIDGE_CONNECT_RETRY_MS'],
    DEFAULT_CONNECT_RETRY_MS,
  );

  interface PendingRpc {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }

  const pendingRpcs = new Map<string, PendingRpc>();
  let socket: net.Socket | undefined;
  let authenticated = false;
  let dropped = false;
  let rpcCounter = 0;
  let textSeq = 0;
  let textBuffer = '';
  let flushTimer: NodeJS.Timeout | undefined;
  let nativeSessionId: string | undefined;
  let activeContext: OmpContext | undefined;
  /**
   * The session-scoped context, captured at `session_start`. The model query
   * facade lives here, and unlike `activeContext` it survives the gaps between
   * turns — a catalog request must be answerable while the session is idle.
   */
  let sessionContext: OmpContext | undefined;
  /**
   * Host requests that arrived before `session_start`, replayed in order once
   * it fires. The bridge connects while OMP is still loading extensions; OMP
   * binds the extension runtime (`sendUserMessage` throws
   * ExtensionRuntimeNotInitializedError until then) and only afterwards emits
   * `session_start`. The host's first prompt and catalog read can land in that
   * gap, so they are held, not refused: the host bounds each with its own
   * deadline.
   */
  const heldUntilSessionStart: (() => void)[] = [];

  // ── Reporting ─────────────────────────────────────────────

  function report(level: 'warn' | 'error', message: string): void {
    try {
      pi.logger[level](`[pixel-agents/company-bridge] ${message}`);
    } catch {
      // Logging must never be the reason a user's session fails.
    }
  }

  function blocked(reason: string): OmpToolGateResult & OmpSpawnGateResult {
    return { block: true, reason };
  }

  // ── Transport ─────────────────────────────────────────────

  function connected(): boolean {
    return authenticated && socket !== undefined && !socket.destroyed && !dropped;
  }

  function send(frame: unknown): void {
    if (!connected()) return;
    try {
      socket?.write(`${JSON.stringify(frame)}\n`);
    } catch (error) {
      report('error', `bridge write failed: ${describe(error)}`);
      drop('the bridge write failed');
    }
  }

  function sendEvent(event: Record<string, unknown>): void {
    send({ v: PROTOCOL_VERSION, t: 'event', event });
  }

  /**
   * Tear the link down. `expected` marks the paths that are not failures (a
   * session shutting down, an attempt that never authenticated); an
   * authenticated link that drops for any other reason is reported, because
   * from that point every gate fails closed and the user needs to know why.
   */
  function drop(reason: string, expected = false): void {
    const wasAuthenticated = authenticated;
    dropped = true;
    authenticated = false;
    // `end` flushes what was already written (the final shutdown event) before
    // closing; `destroy` would discard it.
    socket?.end();
    socket = undefined;
    if (wasAuthenticated && !expected) {
      report('error', `${reason}; every tool call is refused from here on`);
    }
    for (const [id, pending] of [...pendingRpcs]) {
      clearTimeout(pending.timer);
      pendingRpcs.delete(id);
      pending.reject(new Error('omp_bridge_disconnected'));
    }
    // A half-collected body can never be completed once the link is gone, and
    // the host is about to be told its prompt failed.
    pendingPrompts.clear();
    // An open question can never be answered once the link is gone. Settling it
    // ends the waiting tool call instead of hanging it: a lost channel is a
    // withdrawn question, never an unanswered one the model may assume.
    for (const settle of [...pendingAsks.values()]) settle({ kind: 'withdrawn' });
    pendingAsks.clear();
  }

  /** Ask the host for one decision; every failure mode is a refusal upstream. */
  function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!connected()) return Promise.reject(new Error('omp_bridge_disconnected'));
    const id = `${method}-${++rpcCounter}`;
    const frame = {
      v: PROTOCOL_VERSION,
      t: 'rpc',
      id,
      method,
      params: { sessionId, runEpoch, ...params },
    };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRpcs.delete(id);
        reject(new Error('omp_bridge_rpc_timeout'));
      }, rpcTimeoutMs);
      pendingRpcs.set(id, { resolve, reject, timer });
      if (!connected()) {
        clearTimeout(timer);
        pendingRpcs.delete(id);
        reject(new Error('omp_bridge_disconnected'));
        return;
      }
      try {
        socket?.write(`${JSON.stringify(frame)}\n`);
      } catch (error) {
        clearTimeout(timer);
        pendingRpcs.delete(id);
        reject(new Error('omp_bridge_disconnected'));
        report('error', `bridge request failed: ${describe(error)}`);
      }
    });
  }

  // ── Streamed text ─────────────────────────────────────────

  function queueText(delta: string): void {
    textBuffer += delta;
    if (Buffer.byteLength(textBuffer, 'utf8') >= TEXT_FRAME_BYTES) {
      flushText();
      return;
    }
    if (!flushTimer) {
      flushTimer = setTimeout(flushText, TEXT_FLUSH_MS);
      flushTimer.unref?.();
    }
  }

  function flushText(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    const text = textBuffer;
    if (!text) return;
    textBuffer = '';
    for (const piece of splitByBytes(text, TEXT_FRAME_BYTES)) {
      sendEvent({ k: 'text', seq: ++textSeq, text: piece });
    }
  }

  /** Split text into byte-bounded pieces without cutting a UTF-8 sequence. */
  function splitByBytes(text: string, maxBytes: number): string[] {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length <= maxBytes) return [text];
    const pieces: string[] = [];
    let start = 0;
    while (start < bytes.length) {
      let end = Math.min(start + maxBytes, bytes.length);
      // A continuation byte is 10xxxxxx; step back to the sequence start.
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
      pieces.push(bytes.subarray(start, end).toString('utf8'));
      start = end;
    }
    return pieces;
  }

  // ── Inbound frames ────────────────────────────────────────

  function handleFrame(value: unknown): void {
    if (!isFrameObject(value) || value['v'] !== PROTOCOL_VERSION) {
      report('warn', 'host sent a frame that is not a bridge frame');
      return;
    }
    const type = value['t'];
    switch (type) {
      case 'ack':
        // Only this run's own acknowledgement proves the host is the process
        // that holds the matching nonce; anything else stays unauthenticated.
        if (value['sessionId'] !== sessionId || value['runEpoch'] !== runEpoch) {
          report('warn', 'host acknowledged a different run');
          drop('the host acknowledged a different run', true);
          return;
        }
        authenticated = true;
        return;
      case 'abort':
        abortActiveGeneration(value);
        return;
      case 'models_request':
        answerModelCatalog(value);
        return;
      case 'info_request':
        answerSessionInfo(value);
        return;
      case 'rpc_result':
        settleRpc(value);
        return;
      case 'prompt':
        receivePromptFrame(value);
        return;
      case 'prompt_begin':
        beginPrompt(value);
        return;
      case 'prompt_chunk':
        pushPromptChunk(value);
        return;
      case 'prompt_end':
        endPrompt(value);
        return;
      case 'question_result':
        settlePendingAsk(value, 'board');
        return;
      case 'question_cancel':
        settlePendingAsk(value, 'withdrawn');
        return;
      default:
        // Forward-only host frames are not this extension's concern.
        return;
    }
  }

  function abortActiveGeneration(frame: Record<string, unknown>): void {
    const id = readString(frame, 'id');
    if (!id || frame['sessionId'] !== sessionId || frame['runEpoch'] !== runEpoch) {
      report('warn', 'host abort request named another run');
      return;
    }
    if (!connected() || !activeContext?.abort) {
      sendAbortResult(id, false);
      return;
    }
    try {
      activeContext.abort();
      sendAbortResult(id, true);
    } catch {
      sendAbortResult(id, false);
    }
  }

  function sendAbortResult(id: string, ok: boolean): void {
    send({ v: PROTOCOL_VERSION, t: 'abort_result', id, sessionId, runEpoch, ok });
  }

  /**
   * Answer a host catalog request from the runtime model query facade.
   *
   * A request naming another run is ignored outright: the catalog is bound to
   * the session and epoch that authenticated, so a foreign request must not
   * learn which models this session can reach. Everything else answers — a
   * refusal is still an answer, so the host reports an exact reason instead of
   * waiting out its deadline on a request nobody will ever complete.
   */
  function answerModelCatalog(frame: Record<string, unknown>): void {
    const id = readString(frame, 'id');
    if (!id || frame['sessionId'] !== sessionId || frame['runEpoch'] !== runEpoch) {
      report('warn', 'host model catalog request named another run');
      return;
    }
    if (!connected()) {
      send({
        v: PROTOCOL_VERSION,
        t: 'models_result',
        id,
        sessionId,
        runEpoch,
        ok: false,
        error: { code: 'omp_bridge_disconnected', message: 'the company bridge is closed' },
      });
      return;
    }
    if (sessionContext === undefined) {
      heldUntilSessionStart.push(() => answerModelCatalog(frame));
      return;
    }
    const answer = buildCatalogAnswer(sessionContext);
    if ('code' in answer) {
      send({
        v: PROTOCOL_VERSION,
        t: 'models_result',
        id,
        sessionId,
        runEpoch,
        ok: false,
        error: { code: answer.code, message: answer.message },
      });
      return;
    }
    send({
      v: PROTOCOL_VERSION,
      t: 'models_result',
      id,
      sessionId,
      runEpoch,
      ok: true,
      catalog: { models: answer.models },
    });
  }

  // ── Session description ───────────────────────────────────

  /**
   * Answer one describe request with what this native session has loaded. It is
   * read-only and answered like a model catalog: the registry is read at call
   * time, and a request that arrives before the session starts waits for it.
   */
  function answerSessionInfo(frame: Record<string, unknown>): void {
    const id = readString(frame, 'id');
    if (!id || frame['sessionId'] !== sessionId || frame['runEpoch'] !== runEpoch) {
      report('warn', 'host session info request named another run');
      return;
    }
    if (!connected()) {
      send({
        v: PROTOCOL_VERSION,
        t: 'info_result',
        id,
        sessionId,
        runEpoch,
        ok: false,
        error: { code: 'omp_bridge_disconnected', message: 'the company bridge is closed' },
      });
      return;
    }
    if (sessionContext === undefined) {
      heldUntilSessionStart.push(() => answerSessionInfo(frame));
      return;
    }
    const answer = buildSessionDescription(sessionContext);
    if ('code' in answer) {
      send({
        v: PROTOCOL_VERSION,
        t: 'info_result',
        id,
        sessionId,
        runEpoch,
        ok: false,
        error: { code: answer.code, message: answer.message },
      });
      return;
    }
    send({
      v: PROTOCOL_VERSION,
      t: 'info_result',
      id,
      sessionId,
      runEpoch,
      ok: true,
      info: answer,
    });
  }

  function buildSessionDescription(
    ctx: OmpContext,
  ): SessionDescription | { code: string; message: string } {
    const unavailable = {
      code: 'omp_session_info_unavailable',
      message: 'this OMP build does not expose its tool and command registry',
    };
    if (
      typeof pi.getActiveTools !== 'function' ||
      typeof pi.getAllTools !== 'function' ||
      typeof pi.getCommands !== 'function'
    ) {
      return unavailable;
    }
    const registered = asList(pi.getAllTools());
    const commands = asList(pi.getCommands());
    if (registered === undefined || commands === undefined) return unavailable;
    const activeNames = new Set(
      (asList(pi.getActiveTools()) ?? []).filter(
        (name): name is string => typeof name === 'string',
      ),
    );

    const tools: DescribedTool[] = [];
    for (const entry of registered) {
      if (tools.length >= DESCRIBE_ITEM_LIMIT) break;
      if (!isFrameObject(entry)) continue;
      const name = readString(entry, 'name');
      if (name === undefined || name.length === 0) continue;
      const mcpServer = describedMcpServer(entry, name);
      tools.push({
        name: clampText(name),
        source: describedSource(entry, name),
        ...(mcpServer === undefined ? {} : { mcpServer }),
        active: activeNames.has(name),
      });
    }

    const skills: DescribedSkill[] = [];
    for (const entry of commands) {
      if (skills.length >= DESCRIBE_ITEM_LIMIT) break;
      if (!isFrameObject(entry) || readString(entry, 'source') !== 'skill') continue;
      const raw = readString(entry, 'name');
      if (raw === undefined) continue;
      const name = raw.startsWith(SKILL_COMMAND_PREFIX)
        ? raw.slice(SKILL_COMMAND_PREFIX.length)
        : raw;
      if (name.length === 0) continue;
      const description = readString(entry, 'description');
      skills.push({
        name: clampText(name),
        ...(description === undefined || description.length === 0
          ? {}
          : { description: clampText(description) }),
      });
    }

    const modelId = ctx.model?.id;
    const provider = ctx.model?.provider;
    const model =
      typeof modelId === 'string' && modelId.length > 0
        ? clampText(
            typeof provider === 'string' && provider.length > 0
              ? `${provider}/${modelId}`
              : modelId,
          )
        : undefined;
    const thinking = pi.getThinkingLevel?.();
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    return {
      cwd: process.cwd(),
      ...(model === undefined ? {} : { model }),
      ...(typeof thinking === 'string' && thinking.length > 0
        ? { thinking: clampText(thinking) }
        : {}),
      ...(sessionFile === undefined || sessionFile.length === 0 ? {} : { sessionFile }),
      tools,
      skills,
    };
  }

  function settleRpc(frame: Record<string, unknown>): void {
    const id = readString(frame, 'id');
    if (!id) return;
    const pending = pendingRpcs.get(id);
    if (!pending) return;
    pendingRpcs.delete(id);
    clearTimeout(pending.timer);
    if (frame['ok'] === true) {
      pending.resolve(frame['result']);
      return;
    }
    // The host's own sentence is what the model and the user must read, so the
    // code travels alongside it rather than replacing it.
    const error = readObject(frame, 'error') ?? {};
    const code = readString(error, 'code') ?? 'omp_bridge_rpc_failed';
    const message = readString(error, 'message');
    pending.reject(new BridgeFailure(code, message));
  }

  // ── Prompt reassembly ─────────────────────────────────────

  /**
   * A prompt the host refused to deliver. Every sentence is static and every
   * code is stable: the host branches on it, the model reads it, and no part of
   * the prompt or its image bytes appears in either.
   */
  const PROMPT_REFUSAL = {
    malformed: 'the host sent a prompt this session cannot reassemble',
    image_type_unsupported: 'a prompt image is not a media type the runtime accepts',
    image_data_malformed: 'a prompt image is not canonical base64 image data',
    image_mime_mismatch: 'a prompt image does not carry the bytes its media type declares',
    image_budget_exceeded: 'the prompt images exceed the image budget',
    image_too_many: 'the prompt carries more images than the bridge allows',
    delivery_failed: 'the session refused the prompt',
  } as const;

  /** Mirrors the host allowlist: the union `pi-ai` declares for base64 images. */
  const IMAGE_MIME_TYPES: readonly string[] = [
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp',
  ];
  /** Mirrors `OMP_BRIDGE_MAX_PROMPT_IMAGES`; this side refuses no later. */
  const MAX_PROMPT_IMAGES = 8;
  /** Mirrors `OMP_BRIDGE_MAX_PROMPT_IMAGE_BYTES`. */
  const MAX_PROMPT_IMAGE_BYTES = 16 * 1024 * 1024;
  /** Reassemblies held at once; past this the host is not draining its promises. */
  const MAX_PENDING_PROMPTS = 4;

  /**
   * Whether these bytes really are the container the media type claims.
   *
   * The declared type is all a provider receives, so bytes that are something
   * else would be described to the model as a picture of content it never saw.
   * This mirrors the host's own check over the same four types the allowlist
   * names, which is what keeps the two from drifting apart.
   */
  function carriesImageSignature(mimeType: string, bytes: Buffer): boolean {
    if (mimeType === 'image/png') {
      return bytes.subarray(0, 8).toString('latin1') === '\x89PNG\r\n\x1a\n';
    }
    if (mimeType === 'image/jpeg') {
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    }
    if (mimeType === 'image/gif') {
      const header = bytes.subarray(0, 6).toString('latin1');
      return header === 'GIF87a' || header === 'GIF89a';
    }
    return (
      bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
      bytes.subarray(8, 12).toString('latin1') === 'WEBP'
    );
  }

  interface PendingPrompt {
    readonly chunks: Buffer[];
    received: number;
    readonly totalBytes: number;
    readonly deliverAs?: string;
    /** A structured body is the whole prompt as one JSON document. */
    readonly structured: boolean;
    /** Images the host announced, checked against what the body actually holds. */
    readonly imageCount?: number;
  }

  const pendingPrompts = new Map<string, PendingPrompt>();

  /**
   * Read the image blocks of a host frame, or refuse the prompt.
   *
   * The host is the authority on what an image is — it validated the type, the
   * bytes and the budgets against the artifact on disk — but this process is
   * the one feeding a live model, so a frame that does not hold the shape it
   * promised is refused instead of being delivered half-understood. Byte
   * counts are recomputed here rather than trusted from `begin`, and the
   * container signature is re-read rather than taken on the host's word: a
   * model told a PNG is a picture cannot tell that it is not one.
   */
  function parsePromptImages(
    value: unknown,
  ): { readonly images: OmpImageContent[] } | { readonly code: string; readonly message: string } {
    if (value === undefined) return { images: [] };
    if (!Array.isArray(value)) {
      return { code: 'omp_bridge_prompt_malformed', message: PROMPT_REFUSAL.malformed };
    }
    if (value.length > MAX_PROMPT_IMAGES) {
      return { code: 'omp_bridge_image_too_many', message: PROMPT_REFUSAL.image_too_many };
    }
    const images: OmpImageContent[] = [];
    let totalBytes = 0;
    for (const entry of value) {
      if (!isFrameObject(entry)) {
        return { code: 'omp_bridge_prompt_malformed', message: PROMPT_REFUSAL.malformed };
      }
      const mimeType = readString(entry, 'mimeType');
      const data = readString(entry, 'data');
      if (!mimeType || !IMAGE_MIME_TYPES.includes(mimeType)) {
        return {
          code: 'omp_bridge_image_type_unsupported',
          message: PROMPT_REFUSAL.image_type_unsupported,
        };
      }
      if (data === undefined || data.length === 0 || data.length % 4 !== 0) {
        return {
          code: 'omp_bridge_image_data_malformed',
          message: PROMPT_REFUSAL.image_data_malformed,
        };
      }
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length === 0 || bytes.toString('base64') !== data) {
        return {
          code: 'omp_bridge_image_data_malformed',
          message: PROMPT_REFUSAL.image_data_malformed,
        };
      }
      if (!carriesImageSignature(mimeType, bytes)) {
        return {
          code: 'omp_bridge_image_mime_mismatch',
          message: PROMPT_REFUSAL.image_mime_mismatch,
        };
      }
      totalBytes += bytes.length;
      if (totalBytes > MAX_PROMPT_IMAGE_BYTES) {
        return {
          code: 'omp_bridge_image_budget_exceeded',
          message: PROMPT_REFUSAL.image_budget_exceeded,
        };
      }
      images.push({ type: 'image', mimeType, data });
    }
    return { images };
  }

  /**
   * Answer one prompt id. The host waits on exactly one of these per prompt, so
   * a refusal here is what turns a delivery that did not happen into a failure
   * the caller can see.
   */
  function sendPromptResult(id: string, ok: boolean, code?: string, message?: string): void {
    send({
      v: PROTOCOL_VERSION,
      t: 'prompt_result',
      id,
      sessionId,
      runEpoch,
      ok,
      ...(ok || !code || !message ? {} : { error: { code, message } }),
    });
  }

  /** Report a static refusal to the host, whose prompt id this answers. */
  function refusePrompt(id: string, code: string, message: string): void {
    report('error', message);
    sendPromptResult(id, false, code, message);
  }

  /** Take one single-frame prompt: its text, then any images it carries. */
  function receivePromptFrame(frame: Record<string, unknown>): void {
    const id = readString(frame, 'id');
    if (!id) return;
    const text = readString(frame, 'text');
    if (text === undefined) {
      refusePrompt(id, 'omp_bridge_prompt_malformed', PROMPT_REFUSAL.malformed);
      return;
    }
    const parsed = parsePromptImages(frame['images']);
    if ('code' in parsed) {
      refusePrompt(id, parsed.code, parsed.message);
      return;
    }
    deliverPrompt(id, text, parsed.images, readString(frame, 'deliverAs'));
  }

  function beginPrompt(frame: Record<string, unknown>): void {
    const id = readString(frame, 'id');
    const totalBytes = readNumber(frame, 'totalBytes');
    if (!id || totalBytes === undefined) return;
    if (!pendingPrompts.has(id) && pendingPrompts.size >= MAX_PENDING_PROMPTS) {
      refusePrompt(id, 'omp_bridge_too_many_pending', 'the host is not draining its prompts');
      return;
    }
    const mode = readString(frame, 'mode');
    const imageCount = readNumber(frame, 'imageCount');
    pendingPrompts.set(id, {
      chunks: [],
      received: 0,
      totalBytes,
      deliverAs: readString(frame, 'deliverAs'),
      structured: mode === 'structured',
      ...(mode === 'structured' && imageCount !== undefined ? { imageCount } : {}),
    });
  }

  function pushPromptChunk(frame: Record<string, unknown>): void {
    const id = readString(frame, 'id');
    const offset = readNumber(frame, 'offset');
    const data = readString(frame, 'data');
    if (!id || offset === undefined || data === undefined) return;
    const pending = pendingPrompts.get(id);
    if (!pending) return;
    const bytes = Buffer.from(data, 'base64');
    // Strict partial state: a gap, an overlap, or a body running past what
    // `begin` announced means the bytes after this point cannot be placed, so
    // the whole reassembly is dropped rather than spliced.
    if (offset !== pending.received || pending.received + bytes.length > pending.totalBytes) {
      pendingPrompts.delete(id);
      report('error', 'host sent a prompt chunk that does not continue the body it began');
      return;
    }
    pending.chunks.push(bytes);
    pending.received += bytes.length;
  }

  function endPrompt(frame: Record<string, unknown>): void {
    const id = readString(frame, 'id');
    if (!id) return;
    const pending = pendingPrompts.get(id);
    if (!pending) return;
    pendingPrompts.delete(id);
    const body = Buffer.concat(pending.chunks);
    if (body.length !== pending.totalBytes) {
      report('error', 'host sent an incomplete prompt');
      return;
    }
    const digest = readString(frame, 'digest');
    if (digest && digest !== createHash('sha256').update(body).digest('hex')) {
      report('error', 'host sent a prompt whose digest does not match its bytes');
      return;
    }
    if (!pending.structured) {
      deliverPrompt(id, body.toString('utf8'), [], pending.deliverAs);
      return;
    }
    deliverStructuredPrompt(id, body, pending);
  }

  /**
   * Deliver a reassembled structured body: the prompt as one JSON document.
   *
   * The digest already proved these bytes are the ones the host sent, so what
   * is left is reading the document it declared: the text, then exactly the
   * images `begin` announced. A body that parses to anything else is refused
   * whole — never delivered as a note about a missing attachment.
   */
  function deliverStructuredPrompt(id: string, body: Buffer, pending: PendingPrompt): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      refusePrompt(id, 'omp_bridge_prompt_malformed', PROMPT_REFUSAL.malformed);
      return;
    }
    if (!isFrameObject(parsed)) {
      refusePrompt(id, 'omp_bridge_prompt_malformed', PROMPT_REFUSAL.malformed);
      return;
    }
    const text = readString(parsed, 'text');
    if (text === undefined) {
      refusePrompt(id, 'omp_bridge_prompt_malformed', PROMPT_REFUSAL.malformed);
      return;
    }
    const images = parsePromptImages(parsed['images']);
    if ('code' in images) {
      refusePrompt(id, images.code, images.message);
      return;
    }
    if (pending.imageCount !== undefined && images.images.length !== pending.imageCount) {
      refusePrompt(id, 'omp_bridge_prompt_malformed', PROMPT_REFUSAL.malformed);
      return;
    }
    deliverPrompt(id, text, images.images, pending.deliverAs);
  }

  /**
   * Hand one prompt to the session, and report what happened.
   *
   * A text-only prompt stays a bare string, which is what `sendUserMessage`
   * treats as one user turn; with images it becomes one text block plus the
   * image blocks, which is the shape a provider receives.
   *
   * What the answer proves is what this half can see: the call reached
   * `sendUserMessage` and did not throw on the way in. OMP 18.4.9 catches its
   * own asynchronous failure inside that call and shows it in the session, so a
   * provider error afterwards arrives as missing activity, not as this frame —
   * which is exactly why a throw on the way in is reported as a refusal rather
   * than swallowed: the host is holding a promise that a turn started.
   */
  function deliverPrompt(
    id: string,
    text: string,
    images: readonly OmpImageContent[],
    deliverAs: string | undefined,
  ): void {
    if (sessionContext === undefined) {
      heldUntilSessionStart.push(() => deliverPrompt(id, text, images, deliverAs));
      return;
    }
    const content =
      images.length === 0 ? text : [{ type: 'text', text } satisfies OmpTextContent, ...images];
    // OMP 18.11 queues an explicit `steer`/`followUp` WITHOUT starting a turn,
    // even when the session is idle; only an omitted `deliverAs` starts one. A
    // follow-up to an idle session (an answered question, Advisor findings sent
    // back to the Director) would otherwise sit in the queue unread.
    const idle = sessionContext.isIdle?.() === true;
    const options = deliverAs && !idle ? { deliverAs } : undefined;
    try {
      pi.sendUserMessage(content, options);
    } catch (error) {
      // The error name only: a native message may quote the content it choked
      // on, and prompt text and image bytes stay in the pipe.
      report(
        'error',
        `the session refused a prompt (${error instanceof Error ? error.name : 'unknown'})`,
      );
      sendPromptResult(
        id,
        false,
        'omp_bridge_prompt_delivery_failed',
        PROMPT_REFUSAL.delivery_failed,
      );
      return;
    }
    sendPromptResult(id, true);
  }

  // ── Connection ────────────────────────────────────────────

  function connect(): void {
    if (!endpoint || !nonce || !sessionId || !Number.isFinite(runEpoch)) {
      report('error', 'bridge is not configured in this environment');
      return;
    }
    const candidate = net.createConnection(endpoint);
    candidate.setEncoding('utf8');
    let inbound = '';

    candidate.once('connect', () => {
      socket = candidate;
      dropped = false;
      authenticated = false;
      candidate.write(
        `${JSON.stringify({ v: PROTOCOL_VERSION, t: 'hello', sessionId, runEpoch, nonce })}\n`,
      );
    });
    candidate.on('data', (chunk) => {
      inbound += chunk;
      for (let newline = inbound.indexOf('\n'); newline >= 0; newline = inbound.indexOf('\n')) {
        const line = inbound.slice(0, newline);
        inbound = inbound.slice(newline + 1);
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          report('warn', `host sent an unreadable frame: ${describe(error)}`);
          continue;
        }
        try {
          handleFrame(parsed);
        } catch (error) {
          report('error', `host frame handling failed: ${describe(error)}`);
        }
      }
      // Host frames are small and newline delimited; an unbounded tail is not
      // one, so it is dropped rather than buffered.
      if (inbound.length > MAX_INBOUND_FRAME_BYTES) inbound = '';
    });
    candidate.on('error', (error) => {
      report('error', `bridge connection failed: ${describe(error)}`);
    });
    candidate.on('close', () => {
      // A child that starts before the host finished `listen` never becomes
      // the live socket at all, so the retry decision is made from this
      // attempt's own state rather than from `socket` alone.
      const wasAuthenticated = authenticated;
      if (socket === candidate) {
        drop(
          wasAuthenticated
            ? 'the host closed the bridge'
            : 'the first connection closed before it authenticated',
        );
      }
      // The child may start before the host finishes `listen`, so the first
      // connection is retried a bounded number of times. Once the host has
      // acknowledged this run the link is never re-established: a bridge that
      // dropped mid-run stays dropped, and every gate fails closed.
      if (!wasAuthenticated && connectAttempts > 0) {
        connectAttempts -= 1;
        const timer = setTimeout(connect, connectRetryMs);
        timer.unref?.();
      }
    });
  }

  // ── Company tools ─────────────────────────────────────────

  interface CompanyToolSpec {
    readonly name: string;
    readonly label: string;
    /** Role allowed to call it, or `'*'` for every role. */
    readonly role: string;
    readonly description: string;
    /**
     * The payload the runtime handler accepts, so the model sees the fields it
     * must send. Nested records stay open (`record(unknown)`) and are described
     * in prose: the runtime validates them, and a schema that strips an unknown
     * nested key would hide the mistake the runtime reports.
     */
    readonly parameters: (z: OmpZod) => OmpSchema;
  }

  const reviewerResult = (z: OmpZod): OmpSchema =>
    z.object({
      taskId: z.string().describe('The task id named in your instruction.'),
      attemptId: z.string().describe('The attempt id named in your instruction.'),
      verdict: z.string().describe('"pass" or "fail".'),
      criterionIds: z.array(z.string()).optional().describe('Acceptance criterion ids judged.'),
      evidenceIds: z.array(z.string()).optional().describe('Evidence record ids relied on.'),
      notes: z.array(z.string()).optional().describe('Short findings, one per entry.'),
    });

  const COMPANY_TOOLS: readonly CompanyToolSpec[] = [
    {
      name: 'company_submit_contract',
      label: 'Submit contract',
      role: 'director',
      description:
        'Submit a Contract draft for user approval. Director only; the runtime validates it and answers with the exact field to fix.',
      parameters: (z) =>
        z.object({ contract: z.record(z.unknown()).describe(CONTRACT_PROPOSAL_SHAPE) }),
    },
    {
      name: 'company_architecture_review',
      label: 'Submit architecture review',
      role: 'advisor',
      description:
        'Return an architecture verdict for a Contract draft. Advisor only; runtime validated.',
      parameters: (z) =>
        z.object({
          contractId: z.string(),
          revision: z.number().describe('The Contract revision you reviewed.'),
          verdict: z.string().describe('"approve" or "changes_requested".'),
          issues: z
            .array(z.record(z.unknown()))
            .optional()
            .describe(
              'Each: {"severity":"P0"|"P1"|"P2"|"P3","message":string,"requirementIds":[string],"evidence":[string]}.',
            ),
          advisorNotes: z.array(z.string()).optional(),
        }),
    },
    {
      name: 'company_task_result',
      label: 'Report task result',
      role: 'worker',
      description: 'Report the outcome of an assigned task. Worker only; runtime validated.',
      parameters: (z) =>
        z.object({
          taskId: z.string().describe('The task id named in your instruction.'),
          attemptId: z.string().describe('The attempt id named in your instruction.'),
          summary: z.string().optional().describe('What you did, in one or two sentences.'),
          changes: z
            .array(z.record(z.unknown()))
            .optional()
            .describe(
              'Each file you touched: {"path":string,"kind":"create"|"modify"|"delete","summary":string}.',
            ),
        }),
    },
    {
      name: 'company_qa_result',
      label: 'Report QA result',
      role: 'qa',
      description: 'Report a QA verdict with evidence. QA only; runtime validated.',
      parameters: reviewerResult,
    },
    {
      name: 'company_verify',
      label: 'Run verification command',
      role: 'qa',
      description:
        'Run one command from the approved Contract verification profile and record its evidence. QA only; the runtime refuses anything not approved.',
      parameters: (z) =>
        z.object({
          taskId: z.string(),
          attemptId: z.string(),
          commandId: z.string().describe('A command id listed in your instruction.'),
        }),
    },
    {
      name: 'company_judge_result',
      label: 'Report judge result',
      role: 'judge',
      description: 'Report a judge verdict. Judge only; runtime validated.',
      parameters: reviewerResult,
    },
    {
      name: 'company_report',
      label: 'Publish company report',
      role: 'judge',
      description:
        'Publish the final CompanyReport for a completed Contract. Judge only; runtime validated.',
      parameters: (z) => z.object({ contractId: z.string() }),
    },
    {
      name: 'company_ask_user',
      label: 'Ask the user',
      role: '*',
      description: 'Ask the user a question that blocks progress. Any role; runtime validated.',
      parameters: (z) =>
        z.object({
          title: z.string().describe('One line naming what is blocked.'),
          questions: z
            .array(z.record(z.unknown()))
            .describe(
              'Each: {"id":string,"question":string,"options":[{"label":string,"description":string}]} with at least one option.',
            ),
        }),
    },
  ];

  const TOOL_ROLES: Record<string, string> = {};
  for (const spec of COMPANY_TOOLS) TOOL_ROLES[spec.name] = spec.role;
  const COMPANY_TOOL_NAMES: Record<string, true> = {};
  for (const spec of COMPANY_TOOLS) COMPANY_TOOL_NAMES[spec.name] = true;

  function textResult(text: string, isError = false): OmpToolResult {
    return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
  }

  function renderHostResult(value: unknown): string {
    if (value === null || value === undefined) return 'accepted';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function registerCompanyTool(spec: CompanyToolSpec): void {
    const parameters = spec.parameters(pi.zod);

    pi.registerTool({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters,
      loadMode: 'essential',
      approval: 'write',
      async execute(toolCallId, params, ...rest): Promise<OmpToolResult> {
        // OMP's declared signature ends with the context; a bundled example
        // names the third slot differently, so the context is taken from
        // whichever trailing argument actually carries the agent identity.
        const ctx = rest.map(asContext).find((candidate) => candidate !== undefined);
        if (ctx?.agent?.kind === 'sub') {
          return textResult(
            `${spec.name} is not available to a native subagent; the session main agent must call it.`,
            true,
          );
        }
        if (spec.role !== '*' && role !== spec.role) {
          return textResult(
            `${spec.name} belongs to the ${spec.role} role and is not available to ${
              role || 'this unassigned session'
            }.`,
            true,
          );
        }
        // The schema is a record, so the arguments arrive as the payload
        // itself; a `{payload: {...}}` envelope is unwrapped when a caller
        // sends one, and anything else reaches the host as an empty payload.
        const payload: Record<string, unknown> = isFrameObject(params)
          ? isFrameObject(params['payload'])
            ? params['payload']
            : params
          : {};
        try {
          const result = await rpc('company_tool', {
            toolCallId,
            toolName: spec.name,
            role,
            payload,
          });
          return textResult(renderHostResult(result));
        } catch (error) {
          return textResult(`${spec.name} was refused: ${describe(error)}`, true);
        }
      },
    });
  }

  function asContext(value: unknown): OmpContext | undefined {
    return isFrameObject(value) && 'agent' in value ? (value as unknown as OmpContext) : undefined;
  }

  // ── Native ask → durable Company Question ────────────────────

  /**
   * Why the wrapper exists at all.
   *
   * A model calling the built-in `ask` opens a terminal dialog and, on its own,
   * nothing about that survives the process: no record, no board card, no way
   * to answer from the browser. This wrapper re-registers `ask` under its own
   * name — which the SDK treats as replacing the registry entry while keeping
   * the unwrapped native reachable through `ctx.invokeTool` — so every ask
   * becomes a durable Question first, and the native dialog then competes with
   * the board for the answer.
   *
   * What it never does is reimplement the dialog. Keyboard navigation, multi
   * select, custom text and the result text all come from the native tool, so
   * what the user sees in the terminal is what OMP itself produced.
   */

  /** Questions held open at once; past this the host is not draining them. */
  const MAX_PENDING_ASKS = 4;

  interface AskOption {
    label: string;
    description?: string;
  }

  interface AskQuestion {
    id: string;
    question: string;
    header?: string;
    options: AskOption[];
    multi: boolean;
    recommended?: number;
  }

  interface AskAnswer {
    selectedOptions: string[];
    customInput?: string;
    multi: boolean;
  }

  type AskOutcome =
    | { readonly kind: 'board'; readonly answer: AskAnswer }
    | { readonly kind: 'withdrawn' }
    | { readonly kind: 'native'; readonly result: OmpNativeToolResult }
    | { readonly kind: 'failed'; readonly reason: string };

  /** Board answers waiting to reach the ask that is still open. */
  const pendingAsks = new Map<string, (outcome: AskOutcome) => void>();

  /** Minimal deferred: this half needs exactly one resolver. */
  function askDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  /**
   * Read the questions of an `ask` call, or refuse it.
   *
   * The schema already validated the shape; this reads it into the typed form
   * the durable record and the board need. A question with no options has no
   * answer the user can give, so the whole call is refused rather than stored
   * as a question the board could only fail.
   */
  function readAskQuestions(params: unknown): AskQuestion[] | null {
    const raw = isFrameObject(params) ? params['questions'] : undefined;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const questions: AskQuestion[] = [];
    for (const entry of raw) {
      if (!isFrameObject(entry)) return null;
      const id = readString(entry, 'id');
      const question = readString(entry, 'question');
      const rawOptions = entry['options'];
      if (!id || !question || !Array.isArray(rawOptions) || rawOptions.length === 0) return null;
      const options: AskOption[] = [];
      for (const rawOption of rawOptions) {
        if (!isFrameObject(rawOption)) return null;
        const label = readString(rawOption, 'label');
        if (!label) return null;
        const description = readString(rawOption, 'description');
        options.push(description === undefined ? { label } : { label, description });
      }
      const header = readString(entry, 'header');
      const recommended = readNumber(entry, 'recommended');
      questions.push({
        id,
        question,
        ...(header === undefined ? {} : { header }),
        options,
        multi: entry['multi'] === true,
        ...(recommended === undefined ? {} : { recommended }),
      });
    }
    return questions;
  }

  /** One answer, in the shape the durable record stores. */
  function readAskAnswer(value: unknown): AskAnswer | null {
    if (!isFrameObject(value)) return null;
    const selected = value['selectedOptions'];
    const customInput = readString(value, 'customInput');
    if (!Array.isArray(selected)) return null;
    const selectedOptions = selected.filter(
      (option): option is string => typeof option === 'string' && option.length > 0,
    );
    if (selectedOptions.length === 0 && customInput === undefined) return null;
    return {
      selectedOptions,
      ...(customInput === undefined ? {} : { customInput }),
      multi: value['multi'] === true,
    };
  }

  /** The answer the native dialog produced, read from its structured output. */
  function answerFromNative(
    result: OmpNativeToolResult,
    questions: AskQuestion[],
  ): AskAnswer | null {
    const first = result.details?.results?.[0];
    if (!first || result.details?.cancelled === true) return null;
    const selectedOptions = (first.selectedOptions ?? []).filter(
      (option): option is string => typeof option === 'string' && option.length > 0,
    );
    const customInput = typeof first.customInput === 'string' ? first.customInput : undefined;
    if (selectedOptions.length === 0 && !customInput) return null;
    return {
      selectedOptions,
      ...(customInput === undefined ? {} : { customInput }),
      multi: (first.multi ?? questions[0]?.multi) === true,
    };
  }

  /**
   * Render an answer the model reads.
   *
   * Every line comes from the structured answer — the question, the labels
   * chosen, any custom text — with the surface named, so a later reader can
   * tell a terminal keystroke from a board click.
   */
  function renderAskOutcome(
    questions: AskQuestion[],
    answer: AskAnswer,
    source: 'terminal' | 'board',
  ): OmpToolResult {
    const lines = questions.map((question) => {
      const chosen =
        answer.selectedOptions.length > 0
          ? answer.selectedOptions.join(', ')
          : '(no option selected)';
      const custom = answer.customInput ? `\nCustom answer: ${answer.customInput}` : '';
      return `${question.question}\n${chosen}${custom}`;
    });
    return {
      content: [{ type: 'text', text: `${lines.join('\n\n')}\n\n(answered on the ${source})` }],
      details: {
        results: questions.map((question) => ({
          id: question.id,
          question: question.question,
          options: question.options.map((option) => option.label),
          multi: answer.multi,
          selectedOptions: answer.selectedOptions,
          ...(answer.customInput === undefined ? {} : { customInput: answer.customInput }),
        })),
        source,
      },
    };
  }

  /**
   * Tell the host a question died, so its board card dies with it. A failed
   * withdrawal is reported once and never retried into a loop: the durable
   * record has its own cancellation path.
   */
  async function withdrawQuestion(questionId: string, code: string): Promise<void> {
    try {
      await rpc('cancel_question', { toolCallId: `ask-${questionId}`, questionId, code });
    } catch (error) {
      report('warn', `a withdrawn question could not be withdrawn again: ${describe(error)}`);
    }
  }

  /**
   * Record the terminal answer against the durable question.
   *
   * The host is the only writer, so its answer decides which surface won:
   * `recorded` means this one is now the durable answer; `board` means the
   * board got there first and its answer is what the model must act on.
   */
  async function recordNativeAnswer(
    questionId: string,
    toolCallId: string,
    answer: AskAnswer,
  ): Promise<
    { kind: 'recorded' } | { kind: 'board'; answer: AskAnswer } | { kind: 'failed'; reason: string }
  > {
    try {
      const result = await rpc('answer_question', { toolCallId, questionId, answer });
      const status = isFrameObject(result) ? readString(result, 'status') : undefined;
      if (status === 'recorded') return { kind: 'recorded' };
      if (status === 'already_resolved') {
        const existing = isFrameObject(result) ? readAskAnswer(result['answer']) : null;
        // A host that claims the board won without returning its answer leaves
        // nothing to act on; reading that as a failure is the honest outcome.
        if (!existing) return { kind: 'failed', reason: 'the recorded answer was unreadable' };
        return { kind: 'board', answer: existing };
      }
      return { kind: 'failed', reason: 'the runtime did not record the answer' };
    } catch (error) {
      return { kind: 'failed', reason: describe(error) };
    }
  }

  /** A board answer or a withdrawal, delivered for one still-open question. */
  function settlePendingAsk(frame: Record<string, unknown>, kind: 'board' | 'withdrawn'): void {
    if (frame['sessionId'] !== sessionId || frame['runEpoch'] !== runEpoch) {
      report('warn', 'host question frame named another run');
      return;
    }
    // `questionId` is the correlation key: the host names the record, not a
    // request, because a board answer is not a reply to anything this side sent.
    const questionId = readString(frame, 'questionId');
    if (!questionId) return;
    const settle = pendingAsks.get(questionId);
    if (!settle) return;
    if (kind === 'withdrawn') {
      settle({ kind: 'withdrawn' });
      return;
    }
    const answer = readAskAnswer(frame['answer']);
    if (!answer) {
      report('warn', 'host sent a board answer this session cannot read');
      return;
    }
    settle({ kind: 'board', answer });
  }

  /**
   * The wrapper the SDK installs as `ask`.
   *
   * The order is the design: publish the durable Question FIRST, so a board
   * answer has something to attach to; then open the native dialog; then race
   * them. A board answer closes the dialog through the delegated call's own
   * signal without closing the tool call the model is still waiting on, and a
   * terminal answer is recorded against that same record — so the two surfaces
   * can never answer two different questions.
   */
  function registerAskWrapper(): void {
    // The schema has to state the native tool's parameters exactly, or OMP
    // rejects the model's own ask calls. A runtime whose schema builder cannot
    // express that shape gets no wrapper at all: the native ask stays exactly
    // as it was, working, rather than replaced by one that misdescribes it.
    const zod = pi.zod as Partial<OmpZod>;
    if (
      typeof zod.string !== 'function' ||
      typeof zod.number !== 'function' ||
      typeof zod.boolean !== 'function' ||
      typeof zod.array !== 'function' ||
      typeof zod.object !== 'function'
    ) {
      report(
        'warn',
        'this OMP session cannot describe the ask tool schema; the native ask is left untouched',
      );
      return;
    }
    const parameters = pi.zod
      .object({
        questions: pi.zod
          .array(
            pi.zod.object({
              id: pi.zod.string(),
              question: pi.zod.string(),
              header: pi.zod.string().optional(),
              options: pi.zod
                .array(
                  pi.zod.object({
                    label: pi.zod.string(),
                    description: pi.zod.string().optional(),
                  }),
                )
                .min(1),
              multi: pi.zod.boolean().optional(),
              recommended: pi.zod.number().optional(),
            }),
          )
          .min(1),
      })
      .describe('One or more questions for the user, each with the options they may choose.');

    pi.registerTool({
      name: 'ask',
      label: 'Ask the user',
      description:
        'Ask the user a question during execution and wait for their answer. Each question needs at least one option; the user may pick one, pick several when multi is set, or type their own answer.',
      parameters,
      loadMode: 'essential',
      approval: 'read',
      async execute(toolCallId, params, ...rest): Promise<OmpToolResult> {
        const ctx = rest.map(asContext).find((candidate) => candidate !== undefined);
        if (ctx?.agent?.kind === 'sub') {
          return textResult(
            'ask is not available to a native subagent; the session main agent must ask.',
            true,
          );
        }
        const questions = readAskQuestions(params);
        if (questions === null) {
          return textResult(
            'ask needs at least one question, each with one or more options.',
            true,
          );
        }
        // With no native ask behind this name there is no real dialog to show,
        // and drawing one here would be a fake keyboard. Refuse, and say why.
        if (typeof ctx?.invokeTool !== 'function') {
          return textResult(
            'this OMP session exposes no native ask tool, so the question cannot be asked here',
            true,
          );
        }
        if (pendingAsks.size >= MAX_PENDING_ASKS) {
          return textResult('too many questions are already waiting on an answer', true);
        }

        let questionId: string | undefined;
        try {
          const published = await rpc('publish_question', {
            toolCallId,
            questions: questions.map((question) => ({
              id: question.id,
              question: question.question,
              ...(question.header === undefined ? {} : { header: question.header }),
              options: question.options,
              ...(question.multi ? { multi: true } : {}),
              ...(question.recommended === undefined ? {} : { recommended: question.recommended }),
            })),
          });
          questionId = isFrameObject(published) ? readString(published, 'questionId') : undefined;
        } catch (error) {
          return textResult(`the question was refused: ${describe(error)}`, true);
        }
        if (!questionId) {
          return textResult('the question could not be published as a company question', true);
        }

        const dialog = new AbortController();
        const outerSignal = rest.find(
          (value): value is AbortSignal => value instanceof AbortSignal,
        );
        const onOuterAbort = (): void => dialog.abort();
        outerSignal?.addEventListener('abort', onOuterAbort);
        const gate = askDeferred<AskOutcome>();
        pendingAsks.set(questionId, gate.resolve);

        const nativeCall = ctx.invokeTool(params as Record<string, unknown>, {
          signal: dialog.signal,
        });
        nativeCall.catch(() => undefined);

        try {
          const outcome = await Promise.race([
            gate.promise,
            nativeCall.then(
              (result): AskOutcome => ({ kind: 'native', result }),
              (error): AskOutcome => ({ kind: 'failed', reason: describe(error) }),
            ),
          ]);

          if (outcome.kind === 'board') {
            dialog.abort();
            return renderAskOutcome(questions, outcome.answer, 'board');
          }
          if (outcome.kind === 'withdrawn') {
            dialog.abort();
            return textResult('the question was withdrawn; there is no answer to act on', true);
          }
          if (outcome.kind === 'failed') {
            await withdrawQuestion(questionId, 'omp_native_ask_failed');
            return textResult(`the question could not be asked: ${outcome.reason}`, true);
          }

          const answer = answerFromNative(outcome.result, questions);
          if (answer === null) {
            // A cancelled or unanswered dialog is not a yes: the question is
            // withdrawn and the model is told there is nothing to act on.
            await withdrawQuestion(questionId, 'omp_native_ask_cancelled');
            return textResult(
              'the user cancelled the question; there is no answer to act on',
              true,
            );
          }
          const recorded = await recordNativeAnswer(questionId, toolCallId, answer);
          if (recorded.kind === 'board') {
            return renderAskOutcome(questions, recorded.answer, 'board');
          }
          if (recorded.kind === 'failed') {
            return textResult(`the answer could not be recorded: ${recorded.reason}`, true);
          }
          // The native tool wrote the text the model is meant to read, so it is
          // passed through untouched.
          const nativeContent = outcome.result.content;
          const nativeDetails = outcome.result.details;
          return nativeContent === undefined
            ? renderAskOutcome(questions, answer, 'terminal')
            : {
                content: nativeContent,
                ...(nativeDetails === undefined
                  ? {}
                  : { details: nativeDetails as Record<string, unknown> }),
              };
        } finally {
          pendingAsks.delete(questionId);
          outerSignal?.removeEventListener('abort', onOuterAbort);
        }
      },
    });
  }

  // ── Gates ─────────────────────────────────────────────────

  function gateToolCall(event: unknown, ctx: OmpContext): Promise<OmpToolGateResult | undefined> {
    activeContext = ctx;
    if (userDriven) return Promise.resolve(undefined);
    const payload = isFrameObject(event) ? event : {};
    const toolName = readString(payload, 'toolName') ?? '';
    // A company tool already asks the host for its effect; a second
    // authorization round trip would only duplicate the decision.
    if (COMPANY_TOOL_NAMES[toolName]) return Promise.resolve(undefined);
    if (!connected()) {
      return Promise.resolve(blocked(`company bridge is not connected; ${toolName} refused`));
    }
    const input = readObject(payload, 'input') ?? {};
    return rpc('authorize_tool', {
      toolCallId: readString(payload, 'toolCallId') ?? '',
      toolName,
      input,
      agentKind: ctx.agent?.kind ?? 'main',
    })
      .then((result) => {
        const decision = readAuthorization(result);
        if (!decision.allow) {
          return blocked(`${toolName} refused: ${decision.reason ?? 'refused by host'}`);
        }
        return decision.input ? { input: decision.input } : undefined;
      })
      .catch((error) => blocked(`${toolName} refused (fail closed): ${describe(error)}`));
  }

  function gateSubagentSpawn(event: unknown): Promise<OmpSpawnGateResult | undefined> {
    if (userDriven) return Promise.resolve(undefined);
    if (!connected()) {
      return Promise.resolve(blocked('company bridge is not connected; native spawn refused'));
    }
    const payload = isFrameObject(event) ? event : {};
    const invocationKind = readString(payload, 'invocationKind');
    return rpc('authorize_subagent', {
      agent: readString(payload, 'agent') ?? '',
      invocationKind: invocationKind === 'eval' ? 'eval' : 'task',
      modelRole: readString(payload, 'modelRole'),
      patterns: readStrings(payload, 'patterns'),
      spawnKey: readString(payload, 'spawnKey'),
    })
      .then((result) => {
        const decision = readAuthorization(result);
        return decision.allow
          ? undefined
          : blocked(`native subagent refused: ${decision.reason ?? 'refused by host'}`);
      })
      .catch((error) => blocked(`native subagent refused (fail closed): ${describe(error)}`));
  }

  /** True only when idle, nothing queued, and no native async job running. */
  function quiescent(ctx: OmpContext): boolean {
    if (ctx.isIdle && !ctx.isIdle()) return false;
    if (ctx.hasPendingMessages && ctx.hasPendingMessages()) return false;
    const running = ctx.getAsyncJobSnapshot?.()?.running;
    return !running || running.length === 0;
  }

  let idleRecheck: NodeJS.Timeout | undefined;

  function stopIdleRecheck(): void {
    clearTimeout(idleRecheck);
    idleRecheck = undefined;
  }

  /**
   * Report whether the session is quiescent once its turn has really ended.
   * OMP hands `agent_end` to extensions while the prompt that ran the turn is
   * still unwinding (agent-session.ts `#promptInFlightCount`), so `isIdle()` is
   * still false at that moment. Reporting then said "busy" for every finished
   * turn: no session ever went idle, none could be parked, and a queued Judge
   * waited forever behind four "busy" slots. Look again until the prompt has
   * unwound; a new turn or a shutdown cancels the wait.
   */
  function reportQuiescence(ctx: OmpContext): void {
    stopIdleRecheck();
    const unwinding =
      ctx.isIdle !== undefined &&
      !ctx.isIdle() &&
      !(ctx.hasPendingMessages !== undefined && ctx.hasPendingMessages());
    if (unwinding) {
      idleRecheck = setTimeout(() => reportQuiescence(ctx), IDLE_RECHECK_MS);
      idleRecheck.unref?.();
      return;
    }
    sendEvent({ k: 'quiescent', idle: quiescent(ctx) });
  }

  // ── Handlers ──────────────────────────────────────────────

  function registerHandlers(): void {
    pi.on('agent_start', (_event, ctx) => {
      stopIdleRecheck();
      activeContext = ctx;
    });
    pi.on('tool_call', (event, ctx) => gateToolCall(event, ctx));
    pi.on('before_subagent_spawn', (event) => gateSubagentSpawn(event));
    pi.on('session_start', (_event, ctx) => {
      // The model query facade is session-scoped, so the context carrying it is
      // kept for the whole session instead of being cleared between turns.
      sessionContext = ctx;
      nativeSessionId = ctx.sessionManager?.getSessionId?.();
      sendEvent({
        k: 'session',
        phase: 'started',
        nativeSessionId,
        nativeSessionPath: ctx.sessionManager?.getSessionFile?.(),
      });
      for (const replay of heldUntilSessionStart.splice(0)) replay();
    });
    pi.on('session_shutdown', () => {
      stopIdleRecheck();
      activeContext = undefined;
      sessionContext = undefined;
      // The disconnect below fails these on the host; nothing is left to answer.
      heldUntilSessionStart.length = 0;
      flushText();
      sendEvent({ k: 'session', phase: 'shutdown' });
      drop('the session shut down', true);
    });
    pi.on('message_update', (event, ctx) => {
      activeContext = ctx;
      const delta = readTextDelta(isFrameObject(event) ? event['assistantMessageEvent'] : null);
      if (delta !== null) queueText(delta);
    });
    pi.on('message_end', (event) => {
      flushText();
      const usage = readUsageRecord(isFrameObject(event) ? event['message'] : null);
      if (usage) sendEvent({ ...usage, nativeSessionId });
    });
    pi.on('tool_execution_start', (event) => {
      const payload: Record<string, unknown> = isFrameObject(event) ? event : {};
      const toolName = readString(payload, 'toolName') ?? '';
      const skill = skillReadName(toolName, payload['args']);
      sendEvent({
        k: 'tool',
        phase: 'start',
        toolCallId: readString(payload, 'toolCallId') ?? '',
        toolName,
        ...(skill === undefined ? {} : { skill }),
      });
    });
    pi.on('tool_execution_end', (event) => {
      const payload = isFrameObject(event) ? event : {};
      sendEvent({
        k: 'tool',
        phase: 'end',
        toolCallId: readString(payload, 'toolCallId') ?? '',
        toolName: readString(payload, 'toolName') ?? '',
        isError: payload['isError'] === true,
      });
    });
    pi.on('agent_end', (_event, ctx) => {
      flushText();
      reportQuiescence(ctx);
      activeContext = undefined;
    });
  }

  // ── Load ──────────────────────────────────────────────────

  if (!userDriven) {
    for (const spec of COMPANY_TOOLS) registerCompanyTool(spec);
    registerAskWrapper();
  }
  registerHandlers();
  connect();
}

/** Finite, positive environment number, or the supplied default. */
function positiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Message of a thrown value, without a stack: diagnostics stay contentless. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
