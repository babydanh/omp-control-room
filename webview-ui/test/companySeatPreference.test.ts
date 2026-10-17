/**
 * A Company role must land at a desk in its own department.
 *
 * The seat picker has three stages — preferred areas, then unzoned seats, then
 * anything free — so the failure this file guards against is silent and looks
 * fine: the agent takes a desk, just one in the wrong room. These assertions
 * therefore pin WHICH zone a character ends up in, not merely that it got a seat.
 *
 * The third case is the one a feature like this usually breaks: a department
 * that has filled every desk in its own room must spill into another one rather
 * than leave the character standing in the aisle with nowhere to go.
 *
 * Unit rather than e2e: a Company role states its areas directly, as the
 * trailing `addAgent` argument the company flow fills in. No CLI session can
 * express that, so no e2e scenario can drive it — and the overflow case needs a
 * department with more roles than chairs in its area, which a fixture states
 * outright.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { beforeAll, test } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';
import {
  buildDynamicCatalog,
  type LoadedAssetData,
} from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout, PlacedFurniture, SpriteData } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

const COLS = 24;
const ROWS = 12;
const CHAIR = 'WOODEN_CHAIR_FRONT';

/**
 * Seats are derived from furniture through the furniture catalog, and that
 * catalog is a module global — `layoutToSeats` silently yields zero seats until
 * something calls `buildDynamicCatalog`, exactly as the webview does when the
 * extension delivers `furnitureAssetsLoaded`. Without this seed every assertion
 * below fails on `seatId === null` for a reason that has nothing to do with the
 * behaviour under test. Seeded once for the file; vitest gives each test file
 * its own module registry, so it cannot leak into a sibling.
 */
beforeAll(() => {
  const assets: LoadedAssetData = {
    catalog: [
      {
        id: CHAIR,
        label: 'Wooden Chair - Front',
        category: 'chairs',
        width: 1,
        height: 1,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
        orientation: 'front',
      },
    ],
    sprites: { [CHAIR]: [['']] as SpriteData },
  };
  assert.ok(buildDynamicCatalog(assets), 'the chair catalog seeded, so chairs become seats');
});

/** Left half is the meeting room, right half the desk area; a chair in each. */
function zonedLayout(): OfficeLayout {
  const tiles = new Array<TileType>(COLS * ROWS).fill(TileType.FLOOR_1);
  const areaTiles = new Array<string | null>(COLS * ROWS).fill(null);
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < 12; col++) areaTiles[row * COLS + col] = 'meeting';
  }
  for (let row = 0; row < ROWS; row++) {
    for (let col = 12; col < COLS; col++) areaTiles[row * COLS + col] = 'desk';
  }
  const furniture: PlacedFurniture[] = [
    { uid: 'c-meet', type: CHAIR, col: 3, row: 3 },
    { uid: 'c-desk', type: CHAIR, col: 18, row: 3 },
  ];
  return {
    version: 1,
    cols: COLS,
    rows: ROWS,
    tiles,
    furniture,
    // Colours come from the theme tokens, not literals: this repo forbids an
    // inline hex outside constants.ts, and a seat-preference test has no reason
    // to hardcode a palette anyway — the labels are what it asserts on.
    areas: [
      { label: 'meeting', color: 'var(--pixel-accent)' },
      { label: 'desk', color: 'var(--pixel-text)' },
    ],
    areaTiles,
  };
}

/** `addAgent`'s trailing parameters; spelled out so a future reorder is caught here. */
function addCompanyCharacter(office: OfficeState, id: number, areas: readonly string[]): void {
  office.addAgent(id, 0, 0, undefined, true, undefined, undefined, areas);
}

test('a role asking for an area is seated inside it', () => {
  const office = new OfficeState(zonedLayout());

  addCompanyCharacter(office, 1, ['meeting']);

  const worker = office.characters.get(1);
  assert.ok(worker?.seatId, 'the character took a seat');
  assert.equal(office.seatZone(worker.seatId), 'meeting');
});

test('two roles in different areas do not share a desk', () => {
  const office = new OfficeState(zonedLayout());

  addCompanyCharacter(office, 1, ['meeting']);
  addCompanyCharacter(office, 2, ['desk']);

  assert.equal(office.seatZone(office.characters.get(1)?.seatId ?? ''), 'meeting');
  assert.equal(office.seatZone(office.characters.get(2)?.seatId ?? ''), 'desk');
  assert.notEqual(office.characters.get(1)?.seatId, office.characters.get(2)?.seatId);
});

test('a full department spills into another room instead of leaving the character standing', () => {
  const office = new OfficeState(zonedLayout());

  // The meeting room holds exactly one chair, so the second one must overflow.
  addCompanyCharacter(office, 1, ['meeting']);
  addCompanyCharacter(office, 2, ['meeting']);

  const overflow = office.characters.get(2);
  assert.ok(overflow?.seatId, 'the overflow character still got a seat somewhere');
  assert.equal(office.seatZone(overflow.seatId), 'desk');
});

test('a character with no preference is unaffected by the area machinery', () => {
  const office = new OfficeState(zonedLayout());

  office.addAgent(7, 0, 0, undefined, true);

  assert.ok(office.characters.get(7)?.seatId, 'a legacy caller with no areas still gets a seat');
});
