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
  // Precompute a canonical solution so the lockout state can offer "Watch the
  // solution" without re-running BFS or calling Gemini.
  const path = solutionPath(maze);
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
  const { grid } = maze;

  const actions = [];
  const chunks = []; // english chunks parallel to actions

  // STEP 1 — initial alignment turn if needed.
  const firstDir = stepDir(path[0], path[1]);
  if (firstDir !== startHeading) {
    const t = relativeTurn(startHeading, firstDir);
    actions.push(makeTurn(t));
    chunks.push({ kind: 'align', dir: t });
  }

  // STEP 2 — if start cell has 2+ open passages, emit an explicit move 1 to
  // disambiguate which corridor we're taking. follow_road can't decide at start
  // because there's no "previous cell" to mark the inbound side.
  let cursor = 0;
  if (countOpen(grid[0][0]) >= 2) {
    actions.push(makeMove(1));
    chunks.push({ kind: 'kickoff' });
    cursor = 1;
  }

  // STEP 3 — walk the rest of the path, segmenting at real intersections
  // (cells with 3+ open passages where the player has a genuine choice).
  //
  // follow_road has two hard rules baked into the renderer:
  //   1. It can't START at a cell with 2+ forward options (an intersection).
  //   2. It stops the moment it ARRIVES at such a cell.
  // So every intersection along the path must be handled as
  //   [follow_road → intersection] + [turn] + [move 1 to push past].
  // Back-to-back intersections require multiple turn+cross pairs in a row.
  while (cursor < path.length - 1) {
    const here = grid[path[cursor].row][path[cursor].col];
    if (cursor > 0 && countOpen(here) >= 3) {
      // We're standing on an intersection. If the canonical path turns here,
      // emit a turn action — the engine auto-steps into the new corridor after
      // rotation, so no explicit move 1 is needed. If the canonical path
      // continues straight through, the engine has no turn to trigger the
      // auto-step, so emit move 1 explicitly to push past.
      const arrivalDir = stepDir(path[cursor - 1], path[cursor]);
      const nextDir = stepDir(path[cursor], path[cursor + 1]);
      const t = relativeTurn(arrivalDir, nextDir);
      if (t) {
        actions.push(makeTurn(t));
        chunks.push({ kind: 'turn_at_intersection', dir: t });
      } else {
        actions.push(makeMove(1));
        chunks.push({ kind: 'straight_through_intersection' });
      }
      cursor++;
      continue;
    }

    // Otherwise walk forward until the next intersection on the path or dest.
    let runEnd = cursor + 1;
    while (runEnd < path.length - 1) {
      const cell = grid[path[runEnd].row][path[runEnd].col];
      if (countOpen(cell) >= 3) break;
      runEnd++;
    }
    const runLen = runEnd - cursor;
    // Always use follow_road for inter-intersection runs — it auto-adjusts
    // heading at forced bends. Using `move N` here would drive in the current
    // heading and crash into a wall the moment the corridor bends.
    actions.push(makeFollowRoad());
    chunks.push({
      kind: 'follow_road',
      count: runLen,
      toDest: runEnd === path.length - 1,
    });
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
    icon: '🛣️',
  };
}
function turnMsg(t) {
  if (t === 'left')  return 'Hanging a left.';
  if (t === 'right') return 'Easy right.';
  return 'Spinning the wheel.';
}
function turnIcon(t) {
  if (t === 'left')  return '↪️';
  if (t === 'right') return '↩️';
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

  const visible = chunks.filter((c) =>
    c.kind !== 'cross_intersection' &&
    c.kind !== 'straight_through_intersection'
  );
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
