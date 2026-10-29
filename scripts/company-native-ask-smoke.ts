/**
 * Real-OMP smoke for the native Ask ↔ durable Company Question bridge.
 *
 * The unit suite proves the protocol against the extension module with a fake
 * `ExtensionAPI`. It cannot prove the two things that decide whether this works
 * at all in a user's session:
 *
 *  1. that the installed OMP loads the bridge, authenticates on the real pipe,
 *     and answers a catalog read from its own runtime model registry; and
 *  2. that `ctx.invokeTool` really reaches the UNWRAPPED native `ask`, which is
 *     what makes a terminal keystroke resolve the same durable question the
 *     board resolves.
 *
 * So this drives a real `omp` process over its RPC mode. In RPC mode OMP
 * renders the native ask dialog as an `extension_ui_request` of method `ask`
 * and blocks until the client answers — the same dialog the TUI shows, with the
 * same keyboard, minus the pixels. Answering it here IS the Arrow+Enter path.
 *
 * Opt-in by construction: it needs the built extension (`dist/company-omp-
 * bridge.mjs`, produced by `npm run compile`) and, for the ask round trip, a
 * working OMP credential. It never runs as part of `npm test`, and it prints
 * exactly which halves it exercised rather than claiming the ones it skipped.
 *
 *   npx tsx scripts/company-native-ask-smoke.ts
 *   npx tsx scripts/company-native-ask-smoke.ts --with-model   # adds the ask round trip
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { OmpBridgeRpcRequest } from '../server/src/company/ompBridge.js';
import { createOmpBridge } from '../server/src/company/ompBridge.js';

const BRIDGE_BUNDLE = path.resolve('dist/company-omp-bridge.mjs');
const SESSION_ID = 'smoke-session';
const RUN_EPOCH = 1;
const WITH_MODEL = process.argv.includes('--with-model');

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fail(message: string): never {
  process.stderr.write(`FAIL ${message}\n`);
  process.exit(1);
}

function ok(message: string): void {
  process.stdout.write(`ok   ${message}\n`);
}

function skipped(message: string): void {
  process.stdout.write(`skip ${message}\n`);
}

/** The question the smoke's runtime records, and the answers it has accepted. */
interface DurableQuestion {
  questionId: string;
  questions: { id: string; question: string; options: { label: string }[] }[];
  answer?: { selectedOptions: string[]; customInput?: string; multi: boolean };
}

async function main(): Promise<void> {
  if (!fs.existsSync(BRIDGE_BUNDLE)) {
    fail(`the bridge bundle is missing: run "npm run compile" first (${BRIDGE_BUNDLE})`);
  }

  const questions = new Map<string, DurableQuestion>();
  const published: Deferred<DurableQuestion> = deferred<DurableQuestion>();
  let publishedCount = 0;

  const bridge = createOmpBridge({
    sessionId: SESSION_ID,
    runEpoch: RUN_EPOCH,
    role: 'worker',
    socketDir: fs.mkdtempSync(path.join(os.tmpdir(), 'omp-ask-smoke-')),
    rpcHandler: async (request: OmpBridgeRpcRequest) => {
      if (request.method === 'publish_question') {
        publishedCount += 1;
        const questionId = `question-${publishedCount}`;
        const record: DurableQuestion = {
          questionId,
          questions: request.questions.map((question) => ({
            id: question.id,
            question: question.question,
            options: question.options.map((option) => ({ label: option.label })),
          })),
        };
        questions.set(questionId, record);
        if (publishedCount === 1) published.resolve(record);
        return { questionId };
      }
      if (request.method === 'answer_question') {
        const record = questions.get(request.questionId);
        if (!record) return { status: 'unknown_question' };
        // First answer wins, exactly as a real CAS store behaves.
        if (record.answer) return { status: 'already_resolved', answer: record.answer };
        record.answer = request.answer;
        return { status: 'recorded' };
      }
      if (request.method === 'cancel_question') {
        questions.delete(request.questionId);
        return { cancelled: true };
      }
      if (request.method === 'company_tool') return { accepted: true };
      return { allow: true };
    },
  });

  const child = spawn(
    'omp',
    [
      '--mode=rpc',
      // The bridge is an explicit `-e` path: discovery stays off so only OUR
      // extension is in the process, which is what makes the handshake proof.
      '--no-extensions',
      '--extension',
      BRIDGE_BUNDLE,
      '--no-session',
      '--no-lsp',
    ],
    {
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'omp-ask-smoke-cwd-')),
      env: { ...process.env, ...bridge.childEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    },
  );
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) if (line.trim()) process.stderr.write(`omp| ${line}\n`);
  });

  const lines: string[] = [];
  const waiting = new Set<{
    predicate: (frame: Record<string, unknown>) => boolean;
    deferred: Deferred<Record<string, unknown>>;
  }>();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line) continue;
      lines.push(line);
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof frame !== 'object' || frame === null) continue;
      const record = frame as Record<string, unknown>;
      for (const waiter of [...waiting]) {
        if (waiter.predicate(record)) {
          waiting.delete(waiter);
          waiter.deferred.resolve(record);
        }
      }
    }
  });

  function send(frame: Record<string, unknown>): void {
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  function waitFor(
    predicate: (frame: Record<string, unknown>) => boolean,
    what: string,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const existing = lines
        .map((line) => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return undefined;
          }
        })
        .find((frame) => typeof frame === 'object' && frame !== null && predicate(frame as never));
      if (existing) return Promise.resolve(existing as Record<string, unknown>);
      if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
      const waiter = deferred<Record<string, unknown>>();
      waiting.add({ predicate, deferred: waiter });
      return Promise.race([
        waiter.promise,
        new Promise<Record<string, unknown>>((_, reject) => {
          const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs);
          timer.unref?.();
        }),
      ]);
    }
  }

  try {
    // ── 1. The extension loaded and authenticated on the real channel ──
    await bridge.ready;
    ok('the installed OMP loaded the bridge and authenticated on the real pipe');

    // ── 2. The catalog is the runtime's own, not a host-side guess ──
    const catalog = await bridge.requestModelCatalog();
    if (catalog.models.length === 0) fail('the runtime answered a catalog with no models');
    const withImages = catalog.models.filter((model) => model.input.includes('image'));
    ok(
      `the runtime answered its own catalog (${catalog.models.length} models, ${withImages.length} accept images)`,
    );

    // ── 3. The native ask tool is delegated, not reimplemented ──
    send({ type: 'get_state' });
    await waitFor((frame) => frame['type'] === 'state', 'the session state');
    ok('the RPC session is live');

    if (!WITH_MODEL) {
      skipped(
        'the ask round trip needs a working OMP credential; rerun with --with-model to exercise it',
      );
      return;
    }

    // ── 4. A real model calls the real ask, and the client answers it ──
    send({
      type: 'prompt',
      message:
        'Use the ask tool exactly once with one question whose id is "q1", whose question is ' +
        '"Which database should the service use?", and whose options are labelled "PostgreSQL" ' +
        'and "SQLite". Do not do anything else.',
    });
    const dialog = await waitFor(
      (frame) => frame['type'] === 'extension_ui_request' && frame['method'] === 'ask',
      'the native ask dialog',
      120_000,
    );
    const dialogId = dialog['id'];
    const asked = Array.isArray(dialog['questions']) ? dialog['questions'] : [];
    if (asked.length !== 1) fail(`the dialog asked ${asked.length} questions, expected one`);
    ok('the model called ask and the native dialog is on screen, waiting for a keystroke');

    const durable = await Promise.race([
      published.promise,
      new Promise<DurableQuestion>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('no durable question was published')), 30_000);
        timer.unref?.();
      }),
    ]);
    if (durable.questions.length !== 1) fail('the durable question does not match the dialog');
    ok(`the same question is durable on the host (${durable.questionId})`);

    // Arrow+Enter: the second option, submitted the way a user submits it.
    send({
      type: 'extension_ui_response',
      id: dialogId,
      answers: [{ id: asked[0]['id'], selectedOptions: ['SQLite'] }],
    });
    await waitFor(
      () => durable.answer !== undefined || questions.size === 0,
      'the terminal answer to be recorded',
    );
    if (!durable.answer) fail('the terminal answer was never recorded durably');
    ok(`the terminal keystroke resolved the durable question (${durable.answer.selectedOptions})`);

    // ── 5. A board answer closes the dialog instead of racing it ──
    send({
      type: 'prompt',
      message:
        'Use the ask tool exactly once with one question whose id is "q2", whose question is ' +
        '"Which cache should we use?", and whose options are labelled "Redis" and "None". ' +
        'Do not do anything else.',
    });
    const secondDialog = await waitFor(
      (frame) =>
        frame['type'] === 'extension_ui_request' &&
        frame['method'] === 'ask' &&
        frame['id'] !== dialogId,
      'the second native ask dialog',
      120_000,
    );
    if (questions.size < 2) fail('the second question was not published durably');
    const secondQuestionId = [...questions.keys()].at(-1) ?? '';
    await bridge.answerQuestion({
      questionId: secondQuestionId,
      answer: { selectedOptions: ['Redis'], multi: false },
    });
    ok('the board answer was delivered over the authenticated channel');

    // The observable proof that the dialog lost the race rather than answering
    // twice: the tool result the model received is the board's answer, carrying
    // the board provenance the wrapper writes. A client answer at this point
    // would arrive after the tool finished, so cancelling it is bookkeeping.
    const modelSaw = await waitFor(
      (frame) => JSON.stringify(frame).includes('answered on the board'),
      'the board answer to reach the model',
      60_000,
    );
    if (!JSON.stringify(modelSaw).includes('Redis')) {
      fail('the model was told something other than the board answer');
    }
    ok('the native dialog lost to the board answer and the model read the board choice');
    send({ type: 'extension_ui_response', id: secondDialog['id'], cancelled: true });
  } finally {
    child.kill();
    await bridge.dispose();
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});