import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Builds the bundled default office: a 36x24 plan with six real rooms.
 *
 * The plan is deliberately TIGHT. Every room is sized to what it holds and its
 * furniture is clustered around that function, leaving one or two tiles of
 * circulation rather than a field of empty floor. Run it, read the density line
 * in the report, and treat a big jump in empty tiles per item as a regression.
 *
 *  - Floor item. Every tile it covers must be built floor, never void and never
 *    wall. It may overlap one other item only when it is surface-placeable and
 *    the thing underneath is a desk — that is the PC-on-desk case, and it is
 *    granted by checking both flags, never by ignoring collisions.
 *  - Wall item. Its BOTTOM row must sit on wall tiles and the rest hangs above,
 *    matching `getWallPlacementRow` / `canPlaceFurniture`.
 *  - Every emitted `type` must be a leaf id in the flattened catalog, because
 *    `layoutToFurnitureInstances` silently skips anything it cannot resolve.
 *
 * Leaf choice prefers the OFF or stateless member so the auto-state machinery can
 * still switch a monitor on; an `on` frame would bake a powered-on sprite into
 * the saved layout.
 */

const COLS = 36;
const ROWS = 24;
const WALL = 0;
const FLOOR_WOOD = 1;
const FLOOR_STONE = 4;
const FLOOR_CARPET = 7;
const VOID = 255;

const furnitureDir = path.resolve('webview-ui/public/assets/furniture');

const leaves = new Map();
const groups = new Map();

function addLeaf(leafId, meta) {
  const { w, h } = meta;
  if (typeof w !== 'number' || typeof h !== 'number' || w <= 0 || h <= 0) return;
  leaves.set(leafId, meta);
  const bucket = groups.get(meta.groupId) ?? [];
  bucket.push(leafId);
  groups.set(meta.groupId, bucket);
}

function readMembers(members, inherited) {
  for (const member of members ?? []) {
    if (member.type === 'group') {
      readMembers(member.members, { ...inherited, ...pickFlags(member) });
      continue;
    }
    addLeaf(member.id, {
      ...inherited,
      ...pickFlags(member),
      w: member.footprintW,
      h: member.footprintH,
    });
  }
}

function pickFlags(node) {
  const out = {};
  for (const key of ['orientation', 'state', 'animationGroup']) {
    if (node[key] !== undefined) out[key] = node[key];
  }
  if (node.frame !== undefined) out.frame = node.frame;
  if (node.canPlaceOnWalls !== undefined) out.canPlaceOnWalls = node.canPlaceOnWalls === true;
  if (node.canPlaceOnSurfaces !== undefined) out.canPlaceOnSurfaces = node.canPlaceOnSurfaces === true;
  if (node.category !== undefined) out.category = node.category;
  return out;
}

for (const dir of fs.readdirSync(furnitureDir, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const manifestPath = path.join(furnitureDir, dir.name, 'manifest.json');
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.type === 'asset') {
    addLeaf(manifest.id, {
      ...pickFlags(manifest),
      groupId: manifest.id,
      isDesk: manifest.category === 'desks',
      w: manifest.footprintW,
      h: manifest.footprintH,
    });
  } else {
    readMembers(manifest.members, { ...pickFlags(manifest), groupId: manifest.id, isDesk: manifest.category === 'desks' });
  }
}

/** OFF, then stateless, then the first frame — never a later animation frame. */
function leafFor(baseId, preferredOrientation) {
  const ids = groups.get(baseId);
  if (!ids?.length) throw new Error(`no catalog leaves for "${baseId}"`);
  const rank = (id) => {
    const l = leaves.get(id);
    if (l.state === 'off') return 0;
    if (l.state === undefined) return 1;
    if (l.state === 'on' && (l.frame ?? 0) === 0) return 2;
    return 3;
  };
  const candidates = ids.filter((id) => rank(id) <= 2);
  if (candidates.length === 0) throw new Error(`"${baseId}" has no off/stateless/first leaf`);
  const pool = preferredOrientation
    ? candidates.filter((id) => leaves.get(id).orientation === preferredOrientation)
    : [];
  const searchable = pool.length > 0 ? pool : candidates;
  // Orientation narrows FIRST, state rank SECOND. Taking the first `front` leaf
  // regardless of rank handed back `PC_FRONT_ON_1` and baked a powered-on
  // monitor into the saved layout, which is exactly what the OFF rule forbids.
  const fronts = searchable.filter((id) => leaves.get(id).orientation === 'front');
  return (fronts.length > 0 ? fronts : searchable).sort((a, b) => rank(a) - rank(b))[0];
}

const tiles = new Array(COLS * ROWS).fill(VOID);
const areaTiles = new Array(COLS * ROWS).fill(null);
const placed = [];
const at = (c, r) => r * COLS + c;

function fillRect(c0, r0, c1, r1, tile, label) {
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      tiles[at(c, r)] = tile;
      areaTiles[at(c, r)] = label ?? null;
    }
  }
}

function wallRing(c0, r0, c1, r1) {
  for (let c = c0; c <= c1; c++) {
    tiles[at(c, r0)] = WALL;
    tiles[at(c, r1)] = WALL;
  }
  for (let r = r0; r <= r1; r++) {
    tiles[at(c0, r)] = WALL;
    tiles[at(c1, r)] = WALL;
  }
}

function hits(col, row, w, h) {
  return placed.filter((p) => col < p.col + p.w && col + w > p.col && row < p.row + p.h && row + h > p.row);
}

/** A floor item. Never on void, never on wall; overlaps only a desk it may sit on. */
function placeFloor(leafId, col, row) {
  const fp = leaves.get(leafId);
  if (!fp) throw new Error(`"${leafId}" is not in the flattened catalog`);
  const { w, h } = fp;
  for (let r = row; r < row + h; r++) {
    for (let c = col; c < col + w; c++) {
      if (c < 1 || r < 1 || c > COLS - 2 || r > ROWS - 2) {
        throw new Error(`${leafId} ${w}x${h} at (${col},${row}) runs into the outer wall`);
      }
      if (tiles[at(c, r)] === VOID) throw new Error(`${leafId} at (${col},${row}) lands on unbuilt floor`);
      if (tiles[at(c, r)] === WALL) throw new Error(`${leafId} at (${col},${row}) lands on a wall tile`);
    }
  }
  for (const other of hits(col, row, w, h)) {
    const under = leaves.get(other.type);
    if (fp.canPlaceOnSurfaces && under?.isDesk) continue;
    throw new Error(
      `${leafId} ${w}x${h} at (${col},${row}) overlaps ${other.type} at (${other.col},${other.row})`,
    );
  }
  placed.push({ uid: `f${placed.length + 1}`, type: leafId, col, row, w, h, group: fp.groupId });
}

/** A wall item: bottom row on wall tiles, body hanging above. */
function placeWall(leafId, col, bottomRow) {
  const fp = leaves.get(leafId);
  if (!fp) throw new Error(`"${leafId}" is not in the flattened catalog`);
  if (!fp.canPlaceOnWalls) throw new Error(`${leafId} cannot be placed on a wall`);
  const { w, h } = fp;
  const top = bottomRow - h + 1;
  for (let c = col; c < col + w; c++) {
    if (c < 1 || c > COLS - 2) throw new Error(`${leafId} at col ${col} runs into the side wall`);
    if (tiles[at(c, bottomRow)] !== WALL) {
      throw new Error(`${leafId} bottom row at (${c},${bottomRow}) is not a wall tile`);
    }
    for (let r = top; r < bottomRow; r++) {
      if (r < 0) throw new Error(`${leafId} ${w}x${h} hangs off the top of the plan`);
      if (tiles[at(c, r)] === VOID || tiles[at(c, r)] === WALL) {
        throw new Error(`${leafId} body at (${c},${r}) is not clear room`);
      }
    }
  }
  for (const other of hits(col, top, w, h)) {
    if (other.wall) continue;
    throw new Error(
      `${leafId} at (${col},${bottomRow}) overlaps ${other.type} at (${other.col},${other.row})`,
    );
  }
  placed.push({ uid: `f${placed.length + 1}`, type: leafId, col, row: top, w, h, group: fp.groupId, wall: true });
}

const put = (baseId, col, row, orientation) => placeFloor(leafFor(baseId, orientation), col, row);
const hang = (baseId, col, bottomRow) => placeWall(leafFor(baseId), col, bottomRow);

fillRect(0, 0, COLS - 1, ROWS - 1, FLOOR_WOOD, null);
wallRing(0, 0, COLS - 1, ROWS - 1);

// The partition spine: a horizontal wall at row 12 splits the plan into a top
// band (meeting + desk floor) and a bottom band (library, lounge, lunch,
// storage). Upstairs the meeting room is walled off at col 13 so the desk floor
// gets the width it needs; downstairs col 17 splits lounge from lunch, with short
// dividers at cols 9 and 27. Door gaps are at least four tiles apart, and the
// gap on col 17 at row 12 turns the spine into a north-south link instead of a
// dead end.
const H1 = 12;
const V_MEETING = 13;
const V_BOTTOM = 17;
for (let c = 1; c <= COLS - 2; c++) if (c !== H1) tiles[at(c, H1)] = WALL;
for (let r = 1; r < H1; r++) if (r !== 6) tiles[at(V_MEETING, r)] = WALL;
for (let r = H1 + 1; r <= ROWS - 2; r++) tiles[at(V_BOTTOM, r)] = WALL;
for (const c of [4, 12, 17, 22, 31]) tiles[at(c, H1)] = FLOOR_WOOD;
for (const c of [9, 27]) for (let r = H1 + 1; r <= ROWS - 2; r++) tiles[at(c, r)] = WALL;

// Room extents are sized to their contents, not split evenly: the meeting room
// is only as wide as its table plus the chairs ringed around it, the desk floor
// is wide enough for four desk columns, and the utility rooms are just wide
// enough for their furniture plus the lane that reaches it.
const ROOMS = {
  meeting: { c0: 1, r0: 1, c1: 12, r1: 11, tile: FLOOR_CARPET, color: '#4f7cff' },
  desk: { c0: 14, r0: 1, c1: 34, r1: 11, tile: FLOOR_WOOD, color: '#3fb950' },
  library: { c0: 1, r0: 13, c1: 8, r1: 22, tile: FLOOR_WOOD, color: '#d29922' },
  lounge: { c0: 10, r0: 13, c1: 16, r1: 22, tile: FLOOR_CARPET, color: '#a371f7' },
  lunch: { c0: 18, r0: 13, c1: 26, r1: 22, tile: FLOOR_STONE, color: '#f0883e' },
  storage: { c0: 28, r0: 13, c1: 34, r1: 22, tile: FLOOR_STONE, color: '#8b949e' },
};

for (const [label, room] of Object.entries(ROOMS)) {
  fillRect(room.c0, room.r0, room.c1, room.r1, room.tile, label);
}
// Meeting room — a table ringed by eight chairs, four a side, so Director,
// Advisor and two reviewers share one table. Nothing else is seated here: an
// earlier pass ringed that with extra chairs and benches pressed against the
// walls purely to raise the density number, which read as a second meeting
// room rather than a full one.
put('TABLE_FRONT', 5, 3);
for (const row of [3, 4, 5, 6]) {
  put('CUSHIONED_CHAIR', 4, row);
  put('CUSHIONED_CHAIR', 8, row);
}
put('SMALL_TABLE', 10, 8);
put('COFFEE', 10, 8);
put('LARGE_PLANT', 1, 1);
put('LARGE_PLANT', 10, 1);
put('PLANT', 5, 10);
put('PLANT', 9, 10);
put('BIN', 11, 10);

// Open desk area — two banks of four pods. Each pod is a desk with its PC on the
// desktop and the chair tucked against it; the two-tile gaps between the desk
// columns are the walkways, so the pods never spread out across the floor.
for (const row of [3, 8]) {
  for (const col of [15, 20, 25, 30]) {
    put('DESK', col, row);
    put('PC', col, row);
    put('CUSHIONED_CHAIR', col + 1, row + 2);
  }
}
put('COFFEE', 17, 3);
put('PLANT', 14, 1);
put('POT', 14, 6);
put('PLANT', 14, 10);
put('PLANT', 33, 1);
put('CACTUS', 34, 4);
put('LARGE_PLANT', 33, 7);
put('BIN', 33, 11);

// Library — shelves down the left wall, a reading table, chairs and a bench.
for (const row of [13, 16, 19]) put('DOUBLE_BOOKSHELF', 1, row);
put('SMALL_TABLE', 4, 18);
put('CUSHIONED_CHAIR', 3, 20);
put('CUSHIONED_CHAIR', 5, 15);
put('CUSHIONED_BENCH', 6, 15);
put('WOODEN_CHAIR', 4, 13);
put('WOODEN_CHAIR', 7, 15);
put('LARGE_PLANT', 6, 20);
put('PLANT', 8, 21);
put('POT', 7, 13);

// Lounge — two sofas facing a coffee table, chairs either side, plants behind.
put('SOFA', 11, 14);
put('SOFA', 14, 14);
put('COFFEE_TABLE', 12, 17);
put('CUSHIONED_CHAIR', 11, 20);
put('CUSHIONED_CHAIR', 14, 20);
put('WOODEN_CHAIR', 10, 16);
put('PLANT_2', 10, 13);
put('PLANT_2', 10, 19);
put('LARGE_PLANT', 15, 18);
put('BIN', 16, 13);

// Lunch — two tables with benches around them and a second pair down the room.
put('SMALL_TABLE', 20, 15);
put('SMALL_TABLE', 23, 15);
put('COFFEE', 20, 15);
for (const c of [19, 21, 23, 25]) put('WOODEN_BENCH', c, 18);
put('SMALL_TABLE', 23, 20);
for (const c of [22, 25]) put('WOODEN_BENCH', c, 22);
put('PLANT', 19, 13);
put('PLANT', 18, 14);
put('PLANT_2', 18, 20);
put('CACTUS', 25, 13);
put('CACTUS', 26, 17);
put('BIN', 26, 13);

// Storage — shelving down the left wall, worktable, bins and plants behind.
for (const row of [13, 16, 19]) put('DOUBLE_BOOKSHELF', 28, row);
put('BOOKSHELF', 28, 21);
put('SMALL_TABLE', 31, 18);
put('BIN', 30, 14);
put('BIN', 32, 14);
put('BIN', 30, 17);
put('PLANT', 33, 17);
put('WOODEN_BENCH', 33, 21);
put('POT', 33, 13);
put('POT', 34, 16);

// Wall art goes on the OUTER ring only. Hung on the mid-plan partitions it drew
// pale bands straight across the middle of the floor plan, which read as slices
// through the rooms rather than as decoration.
hang('LARGE_PAINTING', 1, ROWS - 1);
hang('SMALL_PAINTING', 4, ROWS - 1);
hang('HANGING_PLANT', 10, ROWS - 1);
hang('WHITEBOARD', 12, ROWS - 1);
hang('SMALL_PAINTING', 20, ROWS - 1);
hang('SMALL_PAINTING_2', 24, ROWS - 1);
hang('CLOCK', 32, ROWS - 1);

const unknown = placed.filter((p) => !leaves.has(p.type));
if (unknown.length > 0) {
  throw new Error(`not in the flattened catalog: ${unknown.map((p) => p.type).join(', ')}`);
}

const layout = {
  version: 1,
  cols: COLS,
  rows: ROWS,
  tiles,
  furniture: placed.map(({ w, h, group, wall, ...item }) => item),
  areas: Object.entries(ROOMS).map(([label, room]) => ({ label, color: room.color })),
  areaTiles,
  layoutRevision: 3,
};

// Revision 3, not 2: `loadLayout` only resets a saved plan when the bundled
// revision is strictly newer, so re-using 2 would leave every existing install
// on the old 52x34 board forever. Both asset loaders pick the highest N.
const outFile = path.resolve('webview-ui/public/assets/default-layout-3.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(layout));

const seats = {};
for (const item of placed) {
  if (!/CHAIR|BENCH|SOFA/.test(item.group)) continue;
  const label = areaTiles[at(item.col, item.row)] ?? 'none';
  seats[label] = (seats[label] ?? 0) + item.w * item.h;
}
console.log(`wrote ${path.relative('.', outFile)}`);
console.log(`${COLS}x${ROWS} = ${tiles.length} tiles · ${placed.length} items`);
console.log(`floor ${placed.filter((p) => !p.wall).length} · wall ${placed.filter((p) => p.wall).length}`);
console.log('seats per area:', JSON.stringify(seats));

const occupied = new Uint8Array(tiles.length);
for (const item of placed) {
  for (let r = item.row; r < item.row + item.h; r++) {
    for (let c = item.col; c < item.col + item.w; c++) occupied[at(c, r)] = 1;
  }
}
const built = tiles.reduce((n, t) => (t !== VOID && t !== WALL ? n + 1 : n), 0);
const circulation = built - occupied.reduce((n, v) => n + v, 0);
console.log(
  `built floor ${built} · circulation ${circulation} · ${(tiles.length / placed.length).toFixed(1)} tiles per item`,
);
