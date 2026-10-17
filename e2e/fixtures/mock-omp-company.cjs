#!/usr/bin/env node
'use strict';

/**
 * mock-omp-company: a complete, deterministic stand-in for the native OMP
 * process, driven entirely through the REAL company bridge.
 *
 * This is not a mock of the company runtime. It is a mock of the thing the
 * runtime launches: it speaks the same argv, reads the same bridge environment,
 * loads the same bundled `ompBridgeExtension` through `--extension`, and answers
 * only what that extension asks. Every state change the test observes is a
 * consequence of a real host answer crossing a real pipe — nothing here reaches
 * into the coordinator, the store or the browser.
 *
 * What it deliberately does NOT do: install OMP, open a network connection,
 * read a credential, or spend a token. The model catalog it advertises is
 * static metadata for the four default Company models, and every tool result is
 * a local file read/write or a fixed answer.
 *
 * Deterministic scenario, keyed on the bridge role and the turn the host sent:
 *
 *   director  -> parses the fragment table out of its planning turn, submits a
 *                 one-task Contract whose write scope is `result.txt`
 *   advisor   -> approves that Contract revision with no blocking issue
 *   worker    -> writes `result.txt` into the workspace for real, then reports
 *                 the change through company_task_result
 *   qa        -> runs `test:verify` through company_verify, then reports the
 *                 verdict the host actually returned
 *   judge     -> passes when the evidence it can see is passing, then publishes
 *                 the report with company_report
 *
 * Anything it cannot parse is reported as text and NOT guessed at, so a
 * mismatched packet shows up as a missing step rather than a fabricated success.
 */

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PROTOCOL_VERSION = 1;

/**
 * The default Company profiles, advertised as configured for catalog reads.
 *
 * Shaped like a real OMP `Model` row, because the extension reads exactly
 * these fields: `id` is the BARE model id (the provider is prefixed by the
 * extension), and a reasoning model's efforts live under `thinking.efforts`.
 */
const CATALOG_MODELS = [
  { id: 'gpt-6.1-sol', provider: 'openai-codex', input: ['text'], reasoning: true, thinking: { efforts: ['high', 'xhigh', 'max'] } },
  { id: 'claude-sonnet-5-5', provider: 'anthropic', input: ['text', 'image'], reasoning: true, thinking: { efforts: ['high', 'xhigh', 'max'] } },
  { id: 'gpt-6-luna', provider: 'openai-codex', input: ['text'], reasoning: true, thinking: { efforts: ['high', 'xhigh', 'max'] } },
  { id: 'stealth/space-bunny-alpha', provider: 'openrouter', input: ['text', 'image'], reasoning: false },
];

/** The file the Worker's approved write scope covers. */
const WORKER_OUTPUT = 'result.txt';

/** The command discovery publishes for the workspace `test` script. */
const VERIFY_COMMAND_ID = 'test:test';
/** The profile discovery publishes for that same script. */
const VERIFY_PROFILE_ID = 'test';


// ── argv ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const parsed = { extension: '', model: '', thinking: '', sessionDir: '', resume: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1] ?? '';
    if (flag === '--extension') { parsed.extension = value; index += 1; }
    else if (flag === '--model') { parsed.model = value; index += 1; }
    else if (flag === '--thinking') { parsed.thinking = value; index += 1; }
    else if (flag === '--session-dir') { parsed.sessionDir = value; index += 1; }
    else if (flag === '--resume') { parsed.resume = value; index += 1; }
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
// The host asks its model roles once when a board opens, using the same argv it
// would use to launch a run, so answering it is part of this process's declared
// contract ("speaks the same argv"). Without this branch the `--extension`
// guard below simply exits non-zero, the host read falls back to its
// transcribe-free default, and the real read path never gets exercised by e2e.
//
// The efforts MUST match the host's real `modelRoles`, because these values
// REPLACE the fallback rather than merely enabling the branch: answering with
// `high` would launch every run at a different effort than production uses.
const argvRest = process.argv.slice(2);
if (argvRest[0] === 'config' && argvRest[1] === 'get' && argvRest[2] === 'modelRoles') {
  const roleFor = (id, effort) => {
    const model = CATALOG_MODELS.find((candidate) => candidate.id === id);
    if (!model?.thinking?.efforts?.includes(effort)) {
      throw new Error(`mock-omp-company: ${id} does not accept effort "${effort}"`);
    }
    return `${model.provider}/${model.id}:${effort}`;
  };
  process.stdout.write(
    `${JSON.stringify({
      key: 'modelRoles',
      type: 'record',
      value: { plan: roleFor('gpt-6.1-sol', 'max'), default: roleFor('gpt-6-luna', 'xhigh') },
    })}\n`,
  );
  process.exit(0);
}
const role = process.env.PIXEL_AGENTS_OMP_BRIDGE_ROLE ?? '';
const sessionId = process.env.PIXEL_AGENTS_OMP_BRIDGE_SESSION ?? 'unknown';
const runEpoch = Number(process.env.PIXEL_AGENTS_OMP_BRIDGE_EPOCH ?? '0');

/**
 * Whether this Director has already raised its clarification. The first turn
 * asks one real question through the host, so the durable ask -> answer ->
 * resume path is exercised instead of being short-circuited.
 */
let askedClarification = false;
/** The prompt the Director was asked to plan, remembered across turns. */
let plannedPromptId = '';
let plannedFragments = [];

if (args.extension === '') {
  process.stderr.write('mock-omp-company: --extension <path> is required.\n');
  process.exit(2);
}

fs.mkdirSync(args.sessionDir || path.join(process.cwd(), '.mock-company'), { recursive: true });

// ── Deterministic packet readers ─────────────────────────────────────────

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const FRAGMENT_ROW = /^- fragment (\S+) \(chars (\d+)-(\d+)\): (.*)$/gm;

/** Every fragment row the Director's planning turn listed, in order. */
function readFragments(turn) {
  const rows = [];
  for (const match of turn.matchAll(FRAGMENT_ROW)) {
    rows.push({ id: match[1], start: Number(match[2]), end: Number(match[3]), text: match[4] });
  }
  return rows;
}

/** The prompt id the runtime stamped on the planning turn. */
function readPromptId(turn) {
  const match = /prompt ([0-9a-f-]{36})\b/.exec(turn);
  return match ? match[1] : '';
}

/**
 * The task and attempt ids, read from the packet's explicit labels.
 *
 * Taking the first two ids after a heading picks up whatever the role brief
 * mentions first — the contract id or the prompt id — which is a different
 * entity, and an unparseable pair silently ends the role's turn.
 */
function readTaskAndAttempt(turn) {
  const taskId = /task id ([0-9a-f-]{36})\b/.exec(turn)?.[1] ?? '';
  const attemptId = /attempt id ([0-9a-f-]{36})\b/.exec(turn)?.[1] ?? '';
  return { taskId, attemptId };
}

/** The contract id and revision named by a reviewer or report turn. */
function readContract(turn) {
  const heading = turn.search(/\bContract\b/);
  const region = heading < 0 ? turn : turn.slice(heading);
  const id = (region.match(UUID) ?? [])[0] ?? (turn.match(UUID) ?? [])[0] ?? '';
  const revision = Number(/revision\D{0,4}(\d+)/i.exec(turn)?.[1] ?? '0');
  return { contractId: id, revision };
}

/** Acceptance criterion ids, read from the packet's own `Criteria:` section. */
function readCriterionIds(turn) {
  const heading = turn.search(/\bCriteria\b/i);
  if (heading < 0) return [];
  return [...new Set(turn.slice(heading).match(UUID) ?? [])];
}

/**
 * Evidence ids, read from the LAST `Evidence:` section, bounded by `Criteria:`.
 *
 * The role packet and the durable handoff both carry an `Evidence:` heading
 * before the dispatch body does, so taking the FIRST one captured a Contract id
 * and submitted it as evidence — refused as `unknown_evidence`. The dispatch
 * body repeats the section later, so the last one is the authoritative one, and
 * the `Criteria:` that follows bounds it so criterion ids cannot leak into it.
 */
function readEvidenceIds(turn) {
  const heading = turn.lastIndexOf('Evidence:');
  if (heading < 0) return [];
  const rest = turn.slice(heading + 'Evidence:'.length);
  const next = rest.search(/\bCriteria\b/i);
  return [
    ...new Set((next < 0 ? rest : rest.slice(0, next)).match(UUID) ?? []),
  ];
}

// ── The fake OMP surface ────────────────────────────────────────────────

const tools = new Map();
const handlers = new Map();
let sessionAnnounced = false;
let turnCounter = 0;

/** Chainable no-op schema builder: the extension only calls `.describe()`. */
function schema() {
  const builder = {
    describe() { return builder; },
    optional() { return builder; },
    nullable() { return builder; },
    default() { return builder; },
    min() { return builder; },
    max() { return builder; },
  };
  return new Proxy(builder, {
    get(target, property) {
      if (property in target) return target[property];
      return () => schema();
    },
  });
}

const pi = {
  zod: new Proxy(
    {},
    {
      get(_target, property) {
        return () => schema();
      },
    },
  ),
  registerTool(tool) {
    tools.set(tool.name, tool);
  },
  on(event, handler) {
    handlers.set(event, handler);
  },
  sendUserMessage(content, options) {
    const turn = typeof content === 'string' ? content : extractText(content);
    void handleTurn(turn, options);
  },
};

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('\n');
}

/** The context OMP hands a handler: the only session capabilities exist here. */
function context() {
  return {
    agent: { kind: 'main' },
    isIdle: () => true,
    hasPendingMessages: () => false,
    getAsyncJobSnapshot: () => ({ running: [] }),
    sessionManager: {
      getSessionId: () => `mock-native-${role}-${sessionId.slice(0, 8)}`,
      getSessionFile: () => path.join(args.sessionDir, 'session.jsonl'),
    },
    models: { list: () => CATALOG_MODELS },
    modelRegistry: { hasConfiguredAuth: () => true },
    hasUI: false,
    abort() {
      aborted = true;
    },
  };
}

let aborted = false;

function fire(event, payload, ctx = context()) {
  const handler = handlers.get(event);
  if (typeof handler === 'function') handler(payload, ctx);
}

/** Stream public assistant text the way OMP streams it. */
function say(text) {
  const ctx = context();
  fire('agent_start', {}, ctx);
  for (const line of text.split('\n')) {
    fire('message_update', { assistantMessageEvent: { type: 'text_delta', delta: `${line}\n` } }, ctx);
  }
  turnCounter += 1;
  fire(
    'message_end',
    {
      message: {
        model: args.model,
        provider: args.model.split('/')[0] ?? 'mock',
        responseId: `mock-response-${turnCounter}`,
        usage: {
          input: 120 + turnCounter * 8,
          output: 64,
          cacheRead: 512,
          cacheWrite: 0,
          totalTokens: 704,
          contextTokens: 4096,
          cost: { total: 0 },
        },
      },
    },
    ctx,
  );
  fire('agent_end', {}, ctx);
}

/** Announce the native session once the bridge has authenticated. */
function announceSession() {
  if (sessionAnnounced) return;
  const ctx = context();
  fire('session_start', { type: 'session_start' }, ctx);
  sessionAnnounced = true;
}

/** Report one tool's public execution metadata, exactly as OMP would. */
function reportTool(name, phase, isError) {
  const callId = `mock-tool-${turnCounter}-${name}`;
  const payload = phase === 'start' ? { type: 'tool_execution_start', toolCallId: callId, toolName: name }
    : { type: 'tool_execution_end', toolCallId: callId, toolName: name, isError: isError === true };
  fire(payload.type, payload, context());
  return callId;
}

/** Call a company tool the extension registered and return its host answer. */
async function callTool(name, payload) {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`mock-omp-company: ${name} is not registered`);
  reportTool(name, 'start');
  try {
    const result = await tool.execute(`mock-tool-${turnCounter}-${name}`, payload, context());
    const text = result.content.map((part) => part.text).join('');
    if (result.isError === true) throw new Error(text);
    reportTool(name, 'end');
    return text;
  } catch (error) {
    reportTool(name, 'end', true);
    throw error;
  }
}

// ── Role scenarios ──────────────────────────────────────────────────────

async function handleTurn(turn, options) {
  announceSession();
  turnCounter += 1;
  try {
    await runScenario(turn);
  } catch (error) {
    say(`mock-omp-company (${role}): ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  void options;
}

async function runScenario(turn) {
  if (role === 'director') return directorTurn(turn);
  if (role === 'advisor') return advisorTurn(turn);
  if (role === 'worker') return workerTurn(turn);
  if (role === 'qa') return qaTurn(turn);
  if (role === 'judge') return judgeTurn(turn);
  say(`mock-omp-company: role ${role || '(none)'} has no scripted turn.`);
}

async function directorTurn(turn) {
  // A real OMP session keeps its transcript, so a follow-up turn still knows the
  // prompt it was asked to plan. This fixture sees one turn at a time, so the
  // planning facts are remembered here instead of re-read from a packet that a
  // follow-up does not carry.
  if (readPromptId(turn) !== '') plannedPromptId = readPromptId(turn);
  if (readFragments(turn).length > 0) plannedFragments = readFragments(turn);
  const promptId = plannedPromptId;
  const fragments = plannedFragments;
  if (!askedClarification) {
    say('mock-omp-company (director): one clarification is needed before planning.');
    const answer = await callTool('company_ask_user', {
      title: 'Create the result file?',
      questions: [
        {
          id: 'confirm',
          question: 'Create the result file?',
          options: [
            { label: 'proceed', description: 'Write result.txt inside an approved scope.' },
            { label: 'cancel', description: 'Do not plan any work.' },
          ],
        },
      ],
    });
    askedClarification = true;
    say(`mock-omp-company (director): ${answer}`);
    return;
  }
  if (promptId === '' || fragments.length === 0) {
    say('mock-omp-company (director): the planning turn carried no prompt id or fragments, so no Contract was proposed.');
    return;
  }
  // Every proposed id must be a UUID: the coordinator assigns its own codes but
  // requires stable entity identity, so a draft keyed `R1`/`P1`/`AC-1` is refused.
  const requirementIds = fragments.map(() => randomUUID());
  const phaseId = randomUUID();
  const criterionId = randomUUID();
  const requirements = fragments.map((fragment, index) => ({
    id: requirementIds[index],
    promptId,
    fragmentIds: [fragment.id],
    text: fragment.text,
    kind: 'goal',
    status: 'open',
  }));
  const proposal = {
    title: 'Produce the result file',
    summary: 'One task that writes result.txt inside an approved write scope.',
    requirements,
    // taskIds/acceptanceIds are assigned by the coordinator, but the shape must
    // be present: a phase without them is a malformed draft.
    phases: [
      { id: phaseId, title: 'Implementation', ordinal: 0, taskIds: [], acceptanceIds: [criterionId] },
    ],
    tasks: [
      {
        id: randomUUID(),
        phaseId,
        title: `Write ${WORKER_OUTPUT}`,
        requirementIds,
        dependsOn: [],
        workstreamId: 'ws-company-e2e',
        readScopes: [],
        writeScopes: [{ path: WORKER_OUTPUT, kind: 'file', operations: ['create', 'modify'] }],
        sharedResources: [],
        acceptance: [criterionId],
        executionMode: 'session',
        routeReason: 'the only deliverable',
      },
    ],
    assumptions: [],
    decisions: ['The result file is the only deliverable.'],
    risks: [],
    acceptance: [
      {
        id: criterionId,
        requirementIds,
        description: `${WORKER_OUTPUT} exists in the workspace`,
        kind: 'command',
        required: true,
      },
    ],
    relatedFiles: [],
    // A `command` criterion has to name the profile that proves it. This is a
    // BINDING to a profile the workspace already has; the coordinator takes the
    // executable and argv from discovery, so no command is authored here.
    verificationProfiles: {
      [criterionId]: { profileId: VERIFY_PROFILE_ID },
    },
  };
  const answer = await callTool('company_submit_contract', { contract: proposal });
  say(`mock-omp-company (director): ${answer}`);
}

async function advisorTurn(turn) {
  const contract = readContract(turn);
  say(`mock-omp-company (advisor): reviewing ${contract.contractId} revision ${contract.revision}.`);
  if (contract.contractId === '') {
    say('mock-omp-company (advisor): no Contract id was present, so no review was submitted.');
    return;
  }
  const answer = await callTool('company_architecture_review', {
    contractId: contract.contractId,
    revision: contract.revision,
    verdict: 'approve',
    issues: [],
    advisorNotes: ['The write scope is narrow and the acceptance criterion is checkable.'],
  });
  say(`mock-omp-company (advisor): ${answer}`);
}

async function workerTurn(turn) {
  const { taskId, attemptId } = readTaskAndAttempt(turn);
  say(`mock-omp-company (worker): starting ${taskId}.`);
  if (taskId === '' || attemptId === '') {
    say('mock-omp-company (worker): the packet named no task and attempt, so nothing was written.');
    return;
  }
  const target = path.join(process.cwd(), WORKER_OUTPUT);
  reportTool('write', 'start');
  fs.writeFileSync(target, 'mock-omp-company wrote this file for the E2E scenario.\n', 'utf8');
  reportTool('write', 'end');
  say(`mock-omp-company (worker): wrote ${WORKER_OUTPUT}.`);
  try {
    const answer = await callTool('company_task_result', {
      taskId,
      attemptId,
      summary: `Wrote ${WORKER_OUTPUT}.`,
      changes: [{ path: WORKER_OUTPUT, kind: 'create', summary: `Wrote ${WORKER_OUTPUT}.` }],
    });
    say(`mock-omp-company (worker): ${answer}`);
  } catch (error) {
    // A refused result ends the turn silently otherwise, and the task is left
    // running with the file on disk and no evidence.
    say(
      `mock-omp-company (worker): company_task_result refused: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function qaTurn(turn) {
  const { taskId, attemptId } = readTaskAndAttempt(turn);
  if (taskId === '' || attemptId === '') {
    say('mock-omp-company (qa): the packet named no task and attempt, so no verdict was reported.');
    return;
  }
  let verdict = 'fail';
  let notes = [];
  let evidenceIds = [];
  let criterionIds = readCriterionIds(turn);
  try {
    const raw = await callTool('company_verify', {
      taskId,
      attemptId,
      commandId: VERIFY_COMMAND_ID,
    });
    const outcome = JSON.parse(raw);
    say(`mock-omp-company (qa): ${VERIFY_COMMAND_ID} reported ${outcome.status}.`);
    if (outcome.status === 'passed') {
      verdict = 'pass';
      evidenceIds = [outcome.evidenceId];
      criterionIds = outcome.criterionIds ?? criterionIds;
    } else {
      notes = [`${VERIFY_COMMAND_ID} ${outcome.status}: ${outcome.reason}`];
    }
  } catch (error) {
    notes = [`${VERIFY_COMMAND_ID} could not run: ${error instanceof Error ? error.message : String(error)}`];
    say(`mock-omp-company (qa): ${notes[0]}`);
  }
  const answer = await callTool('company_qa_result', {
    taskId,
    attemptId,
    verdict,
    criterionIds,
    evidenceIds,
    notes,
  });
  say(`mock-omp-company (qa): ${answer}`);
}

async function judgeTurn(turn) {
  const { taskId, attemptId } = readTaskAndAttempt(turn);
  if (taskId === '' || attemptId === '') {
    say('mock-omp-company (judge): the packet named no task and attempt, so no verdict was reported.');
    return;
  }
  const contract = readContract(turn);
  const criterionIds = readCriterionIds(turn);
  const evidenceIds = readEvidenceIds(turn);
  const answer = await callTool('company_judge_result', {
    taskId,
    attemptId,
    verdict: 'pass',
    criterionIds,
    evidenceIds,
    notes: [`Reviewed ${criterionIds.length} criterion/criteria against ${evidenceIds.length} evidence record(s).`],
  });
  say(`mock-omp-company (judge): ${answer}`);
  if (!answer.includes('accepted')) return;
  if (contract.contractId === '') {
    say('mock-omp-company (judge): no Contract id was present, so no report was published.');
    return;
  }
  const report = await callTool('company_report', { contractId: contract.contractId });
  say(`mock-omp-company (judge): ${report}`);
}

// ── Launch ──────────────────────────────────────────────────────────────

async function main() {
  const module = await import(pathToFileURL(args.extension).href);
  const register = module.default;
  if (typeof register !== 'function') {
    process.stderr.write('mock-omp-company: the extension module has no default export.\n');
    process.exit(2);
  }
  register(pi);
  // Real OMP announces its session as the process starts, and the extension
  // captures the model-query facade from that context. The runtime reads the
  // catalog to answer a settings read, which can happen before any turn, so
  // deferring this until the first prompt would make the catalog unreadable.
  announceSession();
  process.stdout.write(
    `mock-omp-company ready role=${role || 'none'} model=${args.model} epoch=${runEpoch} protocol=${PROTOCOL_VERSION}\n`,
  );
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main().catch((error) => {
  process.stderr.write(`mock-omp-company failed: ${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
