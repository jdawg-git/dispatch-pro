// Seeded maze generation with twistiness bias.
//
// Maze model: a 2D array of cells indexed [row][col], where each cell is
// { n, s, e, w } booleans indicating whether a passage is open in that direction.
// Coordinates: (col, row) with (0,0) at top-left. Up = -row, Down = +row.

export const DIRS = [
  { name: 'n', dx:  0, dy: -1, opp: 's' },
  { name: 's', dx:  0, dy:  1, opp: 'n' },
  { name: 'e', dx:  1, dy:  0, opp: 'w' },
  { name: 'w', dx: -1, dy:  0, opp: 'e' },
];

const DIFFICULTY_P_STRAIGHT = {
  easy:   0.85,
  medium: 0.55,
  hard:   0.20,
};

// Traffic-light cycle, shared by every lit intersection. Tick advances once
// per cell the car enters and once per `wait` action. Each light has its own
// `offset` baked into the seed so they're out of phase.
//
// Cycle: RED → GREEN → YELLOW (warning — about to turn red) → RED → ...
// Phases are 4 red / 4 green / 2 yellow = 10 ticks total.
export const LIGHT_PATTERN = ['R', 'R', 'R', 'R', 'G', 'G', 'G', 'G', 'Y', 'Y'];
export const LIGHT_PERIOD = LIGHT_PATTERN.length;

export function lightColorAt(light, tick) {
  const t = ((tick + light.offset) % LIGHT_PERIOD + LIGHT_PERIOD) % LIGHT_PERIOD;
  return LIGHT_PATTERN[t];
}


export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed() {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return arr[0] >>> 0;
  }
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

// Recursive backtracker with a "keep going straight" bias.
// twistiness: 'easy' | 'medium' | 'hard' OR a number in [0,1] for pStraight.
export function generateMaze(cols, rows, seed, twistiness = 'medium') {
  const rand = mulberry32(seed);
  const pStraight = typeof twistiness === 'number'
    ? clamp01(twistiness)
    : (DIFFICULTY_P_STRAIGHT[twistiness] ?? DIFFICULTY_P_STRAIGHT.medium);

  // Initialise grid: all walls closed.
  const grid = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ n: false, s: false, e: false, w: false }))
  );
  const visited = Array.from({ length: rows }, () => new Array(cols).fill(false));

  // Iterative DFS so we don't blow the stack on big grids.
  // Stack entries: { c, r, lastDir }
  const stack = [{ c: 0, r: 0, lastDir: null }];
  visited[0][0] = true;

  while (stack.length) {
    const top = stack[stack.length - 1];
    const { c, r, lastDir } = top;

    // Find unvisited neighbours.
    const candidates = [];
    for (const d of DIRS) {
      const nc = c + d.dx;
      const nr = r + d.dy;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      if (visited[nr][nc]) continue;
      candidates.push(d);
    }

    if (candidates.length === 0) {
      stack.pop();
      continue;
    }

    // Twistiness bias: with probability pStraight, prefer the straight direction
    // if it is among candidates; otherwise pick any candidate uniformly.
    let chosen;
    const straight = lastDir && candidates.find(d => d.name === lastDir);
    if (straight && rand() < pStraight) {
      chosen = straight;
    } else {
      chosen = candidates[Math.floor(rand() * candidates.length)];
    }

    // Carve passage between (c,r) and (c+dx, r+dy).
    grid[r][c][chosen.name] = true;
    const nc = c + chosen.dx;
    const nr = r + chosen.dy;
    grid[nr][nc][chosen.opp] = true;
    visited[nr][nc] = true;
    stack.push({ c: nc, r: nr, lastDir: chosen.name });
  }

  const maze = { cols, rows, grid, seed, twistiness };
  maze.dest = farthestCellFromStart(maze);
  // Precompute the canonical path BEFORE lights so chooseLitIntersections can
  // target on-path intersections (guarantees the route always has lights to
  // contend with at medium+ difficulty).
  const path = solutionPath(maze);
  maze.lights = chooseLitIntersections(maze, twistiness, path);
  const startHeading = startHeadingDir(maze);
  const compiled = compileSolution(path, startHeading, maze);
  maze.solution = {
    path,
    actions: compiled.actions,
    english: compiled.english,
    startHeading,
  };
  return maze;
}

// BFS from (0,0) over open passages, recording each cell's parent, then walks
// parents back from maze.dest to reconstruct the path. Returns [{col,row}, ...]
// inclusive of both endpoints.
export function solutionPath(maze) {
  const { cols, rows, grid, dest } = maze;
  const parent = Array.from({ length: rows }, () => new Array(cols).fill(null));
  const seen = Array.from({ length: rows }, () => new Array(cols).fill(false));
  const queue = [[0, 0]];
  seen[0][0] = true;
  let head = 0;
  while (head < queue.length) {
    const [c, r] = queue[head++];
    if (c === dest.col && r === dest.row) break;
    const cell = grid[r][c];
    for (const dir of DIRS) {
      if (!cell[dir.name]) continue;
      const nc = c + dir.dx, nr = r + dir.dy;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      if (seen[nr][nc]) continue;
      seen[nr][nc] = true;
      parent[nr][nc] = [c, r];
      queue.push([nc, nr]);
    }
  }
  // Walk back from dest to start.
  const out = [];
  let cur = [dest.col, dest.row];
  while (cur) {
    out.push({ col: cur[0], row: cur[1] });
    const p = parent[cur[1]][cur[0]];
    cur = p ? p : (cur[0] === 0 && cur[1] === 0 ? null : null);
  }
  out.reverse();
  return out;
}

// Direction tables (mirrored from renderer.js but kept local so maze.js stays
// dependency-free).
const LEFT_OF  = { n: 'w', w: 's', s: 'e', e: 'n' };
const RIGHT_OF = { n: 'e', e: 's', s: 'w', w: 'n' };
const REV_OF   = { n: 's', s: 'n', e: 'w', w: 'e' };

function startHeadingDir(maze) {
  const cell = maze.grid[0][0];
  if (cell.e) return 'e';
  if (cell.s) return 's';
  if (cell.w) return 'w';
  if (cell.n) return 'n';
  return 'e';
}

function stepDir(a, b) {
  if (b.col === a.col + 1) return 'e';
  if (b.col === a.col - 1) return 'w';
  if (b.row === a.row + 1) return 's';
  if (b.row === a.row - 1) return 'n';
  return null;
}

function relativeTurn(from, to) {
  if (from === to) return null;
  if (LEFT_OF[from] === to) return 'left';
  if (RIGHT_OF[from] === to) return 'right';
  if (REV_OF[from] === to) return 'around';
  return null;
}

// Landmark-aware solution compiler. Walks the canonical path and emits the
// most natural-feeling action for each stretch:
//   - follow_road between real choice points (cells with 3+ open passages)
//   - move 1 + turn at intersections where the path turns
//   - move N when the run is a single short segment (no real choices)
// The English mirror is built in lockstep so the textarea description and the
// engine playback always agree.
function compileSolution(path, startHeading, maze) {
  if (!path || path.length < 2) return { actions: [], english: '' };
  const { grid, lights } = maze;

  const actions = [];
  const chunks = []; // english chunks (NOT 1:1 with actions — wait_for_green
                     // chunks are placed in narrative order for readability)

  // Simulated tick counter, mirroring the runtime: +1 per cell entered, plus
  // tick advances inside wait_for_green when consumed. checkLightForEntry()
  // inserts a wait_for_green action when the upcoming entry would land on a
  // red/yellow light, and advances simTick to match what the runtime will do
  // when it consumes the wait.
  let simTick = 0;

  // Whenever the next entry lands on a lit cell, insert a wait_for_green
  // action — even if the light happens to be green at the arrival tick. The
  // wait is a no-op in that case but ensures the reveal solution always
  // teaches the "wait for the green" pattern when there are lights on the
  // route. Returns true if a wait chunk should be emitted in narrative order.
  const checkLightForEntry = (targetCell, cellsToReach) => {
    if (!lights || lights.size === 0) return false;
    const light = lights.get(`${targetCell.col},${targetCell.row}`);
    if (!light) return false;
    actions.push(makeWaitForGreen());
    const arrivalPreTick = simTick + cellsToReach - 1;
    let W = 0;
    while (lightColorAt(light, arrivalPreTick + W) !== 'G' && W < LIGHT_PERIOD * 2) W++;
    simTick += W;
    return true;
  };

  // STEP 1 — initial alignment turn if needed. The engine auto-steps after a
  // turn into the new corridor, so an alignment turn doubles as the "step into
  // the first cell" action — no kickoff needed in this case.
  const firstDir = stepDir(path[0], path[1]);
  const didAlign = firstDir !== startHeading;
  if (didAlign) {
    const waited = checkLightForEntry(path[1], 1);
    if (waited) chunks.push({ kind: 'wait_for_green' });
    const t = relativeTurn(startHeading, firstDir);
    actions.push(makeTurn(t));
    chunks.push({ kind: 'align', dir: t });
    simTick += 1;
  }

  // STEP 2 — if (0,0) has 2+ open passages AND no alignment fired, emit a
  // kickoff move so the next follow_road has a clean "back" direction.
  let cursor = didAlign ? 1 : 0;
  if (!didAlign && countOpen(grid[0][0]) >= 2) {
    const waited = checkLightForEntry(path[1], 1);
    if (waited) chunks.push({ kind: 'wait_for_green' });
    actions.push(makeMove(1));
    chunks.push({ kind: 'kickoff' });
    simTick += 1;
    cursor = 1;
  }

  // STEP 3 — walk the rest of the path, segmenting at real intersections.
  while (cursor < path.length - 1) {
    const here = grid[path[cursor].row][path[cursor].col];
    if (cursor > 0 && countOpen(here) >= 3) {
      // Standing on an intersection — turn (with auto-step) or push straight.
      const arrivalDir = stepDir(path[cursor - 1], path[cursor]);
      const nextDir = stepDir(path[cursor], path[cursor + 1]);
      const t = relativeTurn(arrivalDir, nextDir);
      const targetCell = path[cursor + 1];
      const waited = checkLightForEntry(targetCell, 1);
      if (waited) chunks.push({ kind: 'wait_for_green' });
      if (t) {
        actions.push(makeTurn(t));
        chunks.push({ kind: 'turn_at_intersection', dir: t });
      } else {
        actions.push(makeMove(1));
        chunks.push({ kind: 'straight_through_intersection' });
      }
      simTick += 1;
      cursor++;
      continue;
    }

    // Otherwise walk forward until the next intersection or dest.
    let runEnd = cursor + 1;
    while (runEnd < path.length - 1) {
      const cell = grid[path[runEnd].row][path[runEnd].col];
      if (countOpen(cell) >= 3) break;
      runEnd++;
    }
    const cellsInRun = runEnd - cursor;
    // Lights only sit on intersections; intermediate corridor cells are bends
    // and never lit. So only the LAST cell of a follow_road run can trigger a
    // light check, and only when it stops at an intersection (not at dest).
    let waited = false;
    if (runEnd < path.length - 1) {
      waited = checkLightForEntry(path[runEnd], cellsInRun);
    }
    actions.push(makeFollowRoad());
    chunks.push({
      kind: 'follow_road',
      count: cellsInRun,
      toDest: runEnd === path.length - 1,
    });
    if (waited) chunks.push({ kind: 'wait_for_green' });
    simTick += cellsInRun;
    cursor = runEnd;
  }

  return { actions, english: composeEnglish(chunks, maze.seed) };
}

// ---- Action makers (uniform shape with msg + icon for narration playback) ----
function makeTurn(t) {
  return {
    type: 'turn',
    dir: t,
    msg: turnMsg(t),
    icon: turnIcon(t),
  };
}
function makeMove(n) {
  return {
    type: 'move',
    count: n,
    msg: n === 1 ? 'One block ahead.' : `Straight ${n} blocks.`,
    icon: '🚗',
  };
}
function makeFollowRoad() {
  return {
    type: 'follow_road',
    msg: 'Following the road.',
    icon: '↩️',
  };
}
function makeWaitForGreen() {
  return {
    type: 'wait_for_green',
    msg: 'Holding for the green.',
    icon: '🚦',
  };
}
function turnMsg(t) {
  if (t === 'left')  return 'Hanging a left.';
  if (t === 'right') return 'Easy right.';
  return 'Spinning the wheel.';
}
function turnIcon(t) {
  if (t === 'left')  return '⬅️';
  if (t === 'right') return '➡️';
  return '🔄';
}

function countOpen(cell) {
  return (cell.n ? 1 : 0) + (cell.s ? 1 : 0) + (cell.e ? 1 : 0) + (cell.w ? 1 : 0);
}

// ---- English composer: turn chunks into varied, sentence-broken prose ----
//
// Each chunk *can* correspond to an emitted action, but some chunks
// (cross_intersection, straight_through_intersection) are engine bookkeeping
// only and produce no text. We filter those out, group the rest into
// sentences (sentence-break after each turn), and render each sentence with
// vocabulary variety seeded from maze.seed.
function composeEnglish(chunks, seed) {
  if (!chunks.length) return '';
  const rand = mulberry32((seed | 0) ^ 0x9E3779B1);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  // cross_intersection is engine-only bookkeeping (the implicit move 1 the
  // engine auto-issues after a turn at an intersection) — it produces no
  // narrative text. straight_through_intersection IS rendered so the player
  // (and any LLM reading the canned text) knows to emit a cross when the
  // canonical path goes straight through an intersection without turning.
  const visible = chunks.filter((c) => c.kind !== 'cross_intersection');
  if (!visible.length) return '';

  // Group into sentences. A sentence ends after a turn-style chunk so the
  // next leg starts fresh ("Take a left. From there, follow the road…").
  const sentences = [];
  let current = [];
  for (let i = 0; i < visible.length; i++) {
    current.push(visible[i]);
    const k = visible[i].kind;
    const isTurn = k === 'turn_at_intersection' || k === 'align';
    const isLast = i === visible.length - 1;
    if (isTurn || isLast) {
      sentences.push(current);
      current = [];
    }
  }

  const rendered = sentences
    .map((s, idx) => renderSentence(s, {
      isFirstSentence: idx === 0,
      isLastSentence: idx === sentences.length - 1,
      pick,
    }))
    .filter(Boolean);
  return rendered.join(' ');
}

function renderSentence(chunks, { isFirstSentence, isLastSentence, pick }) {
  const pieces = chunks
    .map((c, i) => renderChunk(c, {
      isFirstInSentence: i === 0,
      isFirstSentence,
      isLastSentence,
      pick,
    }))
    .filter(Boolean);
  if (!pieces.length) return '';

  let joined = pieces.join(', then ');
  joined = joined.charAt(0).toUpperCase() + joined.slice(1);
  if (!/[.!?]$/.test(joined)) joined += '.';
  return joined;
}

function renderChunk(c, ctx) {
  const { isFirstInSentence, isFirstSentence, isLastSentence, pick } = ctx;
  switch (c.kind) {
    case 'align': {
      const verbs = [
        `start with a ${c.dir}`,
        `turn ${c.dir} out of the gate`,
        `kick off with a ${c.dir}`,
      ];
      return pick(verbs);
    }
    case 'kickoff': {
      return pick(['ease into the first block', 'roll forward a block', 'pull out one block']);
    }
    case 'short_move': {
      if (isFirstInSentence && isFirstSentence) return 'drive one block';
      return 'one block';
    }
    case 'follow_road': {
      if (c.toDest) {
        if (isFirstSentence && isFirstInSentence) {
          return pick([
            'just follow the road to the destination',
            'follow the road all the way to the star',
            "cruise down the road and you'll see the star",
          ]);
        }
        return pick([
          'follow it the rest of the way to the destination',
          'follow the road to the star',
          'cruise the rest of the way to the destination',
        ]);
      }
      if (isFirstSentence && isFirstInSentence) {
        return pick([
          'head out and follow the road to the next intersection',
          'pull away and follow the road to the intersection',
          'roll out and follow the road to the next intersection',
          'cruise to the next intersection',
        ]);
      }
      return pick([
        'follow the road to the next intersection',
        'cruise to the next intersection',
        'keep going to the next intersection',
      ]);
    }
    case 'straight_through_intersection': {
      return pick(['continue straight through', 'roll straight through']);
    }
    case 'wait_for_green': {
      return pick([
        'wait for the green light',
        'hold for the green',
        'wait at the light',
      ]);
    }
    case 'cross_intersection': {
      // "move 1" to step past the intersection cell. We usually fold this into
      // the previous turn/straight phrase, but render it explicitly when nothing
      // else has been said in this sentence.
      return '';
    }
    case 'turn_at_intersection': {
      const dir = c.dir;
      if (dir === 'around') {
        return pick(['make a u-turn', 'spin around', 'flip a u-turn']);
      }
      if (isFirstInSentence) {
        return pick([`take a ${dir}`, `hang a ${dir}`, `swing ${dir}`]);
      }
      return pick([`take a ${dir}`, `hang a ${dir}`, dir]);
    }
    default:
      return '';
  }
}

// BFS over open passages from (0,0); returns the cell with the longest
// shortest-path. Ties are broken by (row desc, col desc) so when multiple cells
// are equally distant the dest favours the far side of the grid.
export function farthestCellFromStart(maze) {
  const { cols, rows, grid } = maze;
  const dist = Array.from({ length: rows }, () => new Array(cols).fill(-1));
  const queue = [[0, 0]];
  dist[0][0] = 0;
  let head = 0;
  let best = { col: 0, row: 0, distance: 0 };

  while (head < queue.length) {
    const [c, r] = queue[head++];
    const d = dist[r][c];
    if (
      d > best.distance ||
      (d === best.distance && (r > best.row || (r === best.row && c > best.col)))
    ) {
      best = { col: c, row: r, distance: d };
    }
    const cell = grid[r][c];
    for (const dir of DIRS) {
      if (!cell[dir.name]) continue;
      const nc = c + dir.dx;
      const nr = r + dir.dy;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      if (dist[nr][nc] !== -1) continue;
      dist[nr][nc] = d + 1;
      queue.push([nc, nr]);
    }
  }
  return best;
}

// Returns the maze's open passages as compact strings, e.g. "(0,0)→E".
// Used to feed the Gemini system prompt.
export function passageList(maze) {
  const out = [];
  const { cols, rows, grid } = maze;
  const labels = { n: 'N', s: 'S', e: 'E', w: 'W' };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = grid[r][c];
      for (const k of ['n', 's', 'e', 'w']) {
        if (cell[k]) out.push(`(${c},${r})→${labels[k]}`);
      }
    }
  }
  return out;
}

// Picks which intersections on the canonical path get traffic lights.
//
// Easy   → no lights.
// Medium → ratio 2/3 of route intersections (min 1 when any exist).
// Hard   → ratio 3/4 of route intersections (min 1 when any exist).
//
// "Route intersections" means cells with 3+ open passages that the canonical
// solution traverses. Lights on off-path intersections wouldn't affect
// gameplay, so we leave those clear.
//
// Each lit intersection gets a phase `offset` baked in from the seed so
// different lights cycle out of phase. Returns Map<"c,r", { col, row, offset }>.
export function chooseLitIntersections(maze, twistiness, path) {
  const lights = new Map();
  if (twistiness === 'easy') return lights;
  if (!path || path.length === 0) return lights;

  // Intersections on the canonical path, preserving path order.
  const { grid } = maze;
  const seen = new Set();
  const onPath = [];
  for (const { col, row } of path) {
    const key = `${col},${row}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cell = grid[row][col];
    const open = (cell.n ? 1 : 0) + (cell.s ? 1 : 0) + (cell.e ? 1 : 0) + (cell.w ? 1 : 0);
    if (open >= 3) onPath.push({ col, row });
  }
  if (onPath.length === 0) return lights;

  // Target count: guarantee at least 1, scale by difficulty ratio.
  const ratio = twistiness === 'hard' ? 0.75 : 2 / 3;
  const target = Math.max(1, Math.round(onPath.length * ratio));

  // Deterministic Fisher–Yates shuffle so light placement varies across the
  // route but stays reproducible per seed.
  const rand = mulberry32(((maze.seed | 0) ^ 0x1A5B7C9D) >>> 0);
  const order = onPath.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  for (let i = 0; i < target && i < order.length; i++) {
    const { col, row } = order[i];
    const offsetSeed = (hashStr(`light:${col},${row}`) ^ (maze.seed | 0)) >>> 0;
    const offset = Math.floor(mulberry32(offsetSeed)() * LIGHT_PERIOD);
    lights.set(`${col},${row}`, { col, row, offset });
  }
  return lights;
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Cells with 3+ open roads — the maze's real intersections (choice points).
// A 2-passage cell is just a bend/curve and is NOT included. Returns compact
// "(c,r)" strings for the Gemini prompt.
export function intersectionList(maze) {
  const out = [];
  const { cols, rows, grid } = maze;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = grid[r][c];
      const open = (cell.n ? 1 : 0) + (cell.s ? 1 : 0) + (cell.e ? 1 : 0) + (cell.w ? 1 : 0);
      if (open >= 3) out.push(`(${c},${r})`);
    }
  }
  return out;
}

// Intersections along the shortest solution path from (0,0) to dest, in the
// order the driver will encounter them. Uses iterative BFS (no recursion) to
// find the path, then walks it collecting 3+-open-road cells.
// Falls back to intersectionList() if the destination is unreachable.
export function intersectionsAlongPath(maze) {
  const { cols, rows, grid, dest } = maze;
  const STEP = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };

  // Iterative BFS: visited maps "col,row" → {fromCol, fromRow}
  const visited = new Map();
  visited.set('0,0', { fromCol: -1, fromRow: -1 });
  const queue = [[0, 0]];
  let found = false;

  outer: while (queue.length) {
    const [col, row] = queue.shift();
    if (col === dest.col && row === dest.row) { found = true; break; }
    const cell = grid[row][col];
    for (const [d, [dc, dr]] of Object.entries(STEP)) {
      if (!cell[d]) continue;
      const nc = col + dc, nr = row + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const key = `${nc},${nr}`;
      if (visited.has(key)) continue;
      visited.set(key, { fromCol: col, fromRow: row });
      queue.push([nc, nr]);
    }
  }

  if (!found) return intersectionList(maze);

  // Reconstruct path by back-tracking from dest to start, then reverse.
  const path = [];
  let col = dest.col, row = dest.row;
  while (col !== -1) {
    path.push([col, row]);
    const prev = visited.get(`${col},${row}`);
    col = prev.fromCol; row = prev.fromRow;
  }
  path.reverse();

  // Collect cells with 3+ open roads, in encounter order.
  const out = [];
  for (const [c, r] of path) {
    const cell = grid[r][c];
    const open = (cell.n ? 1 : 0) + (cell.s ? 1 : 0) + (cell.e ? 1 : 0) + (cell.w ? 1 : 0);
    if (open >= 3) out.push(`(${c},${r})`);
  }
  return out;
}

// Sanity check: every cell reachable from (0,0)? Used only in dev assertions.
export function isFullyConnected(maze) {
  const { cols, rows, grid } = maze;
  const seen = Array.from({ length: rows }, () => new Array(cols).fill(false));
  const stack = [[0, 0]];
  seen[0][0] = true;
  let count = 1;
  while (stack.length) {
    const [c, r] = stack.pop();
    const cell = grid[r][c];
    for (const d of DIRS) {
      if (!cell[d.name]) continue;
      const nc = c + d.dx, nr = r + d.dy;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      if (seen[nr][nc]) continue;
      seen[nr][nc] = true;
      count++;
      stack.push([nc, nr]);
    }
  }
  return count === cols * rows;
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
