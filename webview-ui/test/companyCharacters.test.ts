/**
 * Company characters and their bubbles: the consumer-visible edges.
 *
 * A company session becomes an office character without ever entering the
 * server's agent store, so the invariants worth pinning here are the ones the
 * office would silently get wrong otherwise: the id never collides with a real
 * Claude agent, a parked session stays standing while an archived or killed one
 * leaves, a re-sync of the same snapshot adds nothing, a click on one of these
 * characters resolves to the company session and never to `focusAgent`, and the
 * persisted seat payload stays free of ids the server will never send back.
 *
 * These are domain-model and transition edges, not pixels. What the office
 * actually looks like is Main's browser check.
 *
 * Run with: npm run test:webview
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { companyBubbleView } from '../src/company/companyBubble.js';
import { CompanyCharacterLayer, companyRoleLabel } from '../src/company/companyCharacters.js';
import { COMPANY_CHARACTER_ID_BASE } from '../src/company/constants.js';
import { resolveAgentClick } from '../src/company/selection.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';
import { question, session, stateFrom } from './companyFixtures.js';

/** All-floor layout, no furniture — every tile walkable, every tile free. */
function floorLayout(cols = 9, rows = 7): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
  };
}

function officeWithSeats(): OfficeState {
  const office = new OfficeState();
  office.rebuildFromLayout(floorLayout());
  return office;
}

test('a restored session gets a character in the company id range', () => {
  const office = officeWithSeats();
  const layer = new CompanyCharacterLayer();
  const worker = session({ code: 'PA-S0001', status: 'busy' });

  layer.sync(stateFrom({ sessions: [worker] }), office);

  const id = layer.characterId(worker.id);
  assert.ok(id !== null, 'the session resolved to a character');
  assert.ok(id <= COMPANY_CHARACTER_ID_BASE, `id ${id} is inside the company range`);
  assert.ok(office.characters.has(id), 'the office drew it');
  assert.equal(office.characters.get(id)?.companySessionId, worker.id);
  // A real Claude agent, added the way useExtensionMessages adds one.
  office.addAgent(1);
  assert.ok(!office.characters.has(1) || office.characters.get(1)?.companySessionId === undefined);
});

test('re-syncing the same snapshot adds nothing and keeps the ids', () => {
  const office = officeWithSeats();
  const layer = new CompanyCharacterLayer();
  const state = stateFrom({ sessions: [session({ status: 'busy' })] });

  const first = layer.sync(state, office);
  const before = layer.characterId(first.added[0]);
  const second = layer.sync(state, office);

  assert.deepEqual(first.added.length, 1);
  assert.deepEqual(second.added, [], 'nothing new was added');
  assert.deepEqual(second.removed, []);
  assert.equal(layer.characterId(first.added[0]), before, 'the same session kept its character');
});

test('a parked session stays standing; a killed or archived one leaves', () => {
  const office = officeWithSeats();
  const layer = new CompanyCharacterLayer();
  const parked = session({ code: 'PA-S0001', status: 'parked' });
  const killed = session({ code: 'PA-S0002', status: 'busy' });
  const archived = session({ code: 'PA-S0003', status: 'busy' });
  const crashed = session({ code: 'PA-S0004', status: 'crashed' });

  layer.sync(stateFrom({ sessions: [parked, killed, archived, crashed] }), office);
  assert.equal(layer.characterId(parked.id) !== null, true);
  assert.equal(layer.characterId(crashed.id) !== null, true, 'a crash must stay visible');

  const retired = layer.sync(
    stateFrom({
      sessions: [parked, { ...killed, status: 'stopped' }, { ...archived, status: 'archived' }, crashed],
    }),
    office,
  );

  assert.deepEqual(retired.removed.sort(), [killed.id, archived.id].sort());
  assert.equal(layer.characterId(killed.id), null);
  assert.equal(layer.characterId(archived.id), null);
  assert.equal(layer.characterId(parked.id) !== null, true);
});

test('working sessions type with their role tool, including a Director planning before any task', () => {
  const office = officeWithSeats();
  const layer = new CompanyCharacterLayer();
  const worker = session({ status: 'busy', activeTaskId: 'task-1', role: 'worker' });
  // A Director runs the model to plan a Contract long before a task exists.
  const director = session({ status: 'busy', role: 'director' });
  const booting = session({ status: 'starting', role: 'worker' });

  layer.sync(stateFrom({ sessions: [worker, director, booting] }), office);
  const workerId = layer.characterId(worker.id);
  const directorId = layer.characterId(director.id);
  const bootingId = layer.characterId(booting.id);
  assert.ok(workerId !== null && directorId !== null && bootingId !== null);

  // The role decides the animation, not a fabricated tool call: a worker edits.
  assert.equal(office.characters.get(workerId)?.isActive, true);
  assert.equal(office.characters.get(workerId)?.currentTool, 'Write');
  // Busy with no task is still real model work — the Director is planning.
  assert.equal(office.characters.get(directorId)?.isActive, true);
  assert.equal(office.characters.get(directorId)?.currentTool, 'Read');
  // Starting is not work yet: the session is still bootstrapping its process.
  assert.equal(office.characters.get(bootingId)?.isActive, false);
  assert.equal(office.characters.get(bootingId)?.currentTool, null);

  // Parked: idle at its desk, on a sync where the mapping never changed — the
  // transition a status-only change has to produce.
  const result = layer.sync(
    stateFrom({ sessions: [{ ...worker, status: 'parked' }, director, booting] }),
    office,
  );
  assert.deepEqual([result.added, result.removed], [[], []]);
  assert.equal(office.characters.get(workerId)?.isActive, false);
  assert.equal(office.characters.get(workerId)?.currentTool, null);
  assert.equal(office.characters.get(directorId)?.isActive, true);
});

test('a company character click resolves to the session, never to focusAgent', () => {
  const office = officeWithSeats();
  const layer = new CompanyCharacterLayer();
  const worker = session({ activeTaskId: 'task-1' });
  const state = stateFrom({ sessions: [worker] });
  layer.sync(state, office);
  office.addAgent(7);

  const companyId = layer.characterId(worker.id);
  assert.ok(companyId !== null);
  assert.deepEqual(resolveAgentClick(layer, state, companyId), {
    kind: 'company',
    selection: { sessionId: worker.id, taskId: 'task-1', tab: 'terminal' },
  });
  // A real agent still resolves the legacy way, which is the only thing that
  // may send focusAgent.
  assert.deepEqual(resolveAgentClick(layer, state, 7), { kind: 'office', agentId: 7 });
});

test('company characters stay out of the persisted seat payload', () => {
  const office = officeWithSeats();
  const layer = new CompanyCharacterLayer();
  const worker = session();
  layer.sync(stateFrom({ sessions: [worker] }), office);
  office.addAgent(3);
  const companyId = layer.characterId(worker.id);
  assert.ok(companyId !== null);

  const seats = office.getPersistableSeats();

  assert.ok(3 in seats, 'the Claude agent still persists its seat');
  assert.equal(
    Object.prototype.hasOwnProperty.call(seats, String(companyId)),
    false,
    'a company character must not be persisted as an agent seat',
  );
});

test('a blocked session shows its question and it does not fade with the text', () => {
  const worker = session({ status: 'waiting_input' });
  const pending = question({ sessionId: worker.id, kind: 'clarification', title: 'Which database?' });
  const stream = { sessionId: worker.id, runEpoch: 1, seq: 12, tail: 'raw', excerpt: 'raw' };

  // Text is live AND a question is open: the question wins, because a session
  // waiting on an answer must say so rather than the last thing it typed.
  const view = companyBubbleView(worker, stream, pending, true, false);
  assert.equal(view?.detail, 'Which database?');
  assert.equal(view?.tone, 'blocked');
  assert.equal(view?.tab, 'questions');

  // The text bubble is gone; the blocked bubble is not.
  const stillBlocked = companyBubbleView(worker, stream, pending, false, false);
  assert.equal(stillBlocked?.detail, 'Which database?');

  // An answered question is not a blocker any more: the text takes over.
  const resolved = companyBubbleView(worker, stream, { ...pending, status: 'answered' }, true, false);
  assert.equal(resolved?.detail, 'raw');
  assert.equal(resolved?.tab, 'terminal');
});

test('an approval reads as an approval, and an idle character shows no bubble', () => {
  const worker = session({ status: 'waiting_input' });
  const approval = question({
    sessionId: worker.id,
    kind: 'approval',
    title: 'Run npm install?',
    actionDigest: 'sha256:abc',
  });

  assert.equal(companyBubbleView(worker, undefined, approval, false, false)?.tone, 'approval');
  // Nothing said, nothing pending, not hovered: the office stays quiet.
  assert.equal(companyBubbleView(worker, undefined, null, false, false), null);
  // Selected (or hovered, or always-show) it becomes a panel, headed by the
  // company's own name for the role rather than the bare wire value.
  assert.equal(
    companyBubbleView(worker, undefined, null, false, true)?.label,
    companyRoleLabel('worker'),
  );
  assert.notEqual(companyRoleLabel('worker'), 'worker');
});