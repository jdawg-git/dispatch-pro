// Canvas renderer + step animation.
//
// Owns the canvas, the current maze, and the car's position. game.js drives it
// via animateSteps(steps, onMsg, onDone).

import { mulberry32, lightColorAt } from './maze.js';

// Bright daytime palette for the maze canvas (the surrounding app UI stays dark).
const GRASS = '#86bf52';
const ROAD = '#9a9da2';
const SIDEWALK = '#c4c7cb';
const LANE_DASH = 'rgba(255, 255, 255, 0.9)';
const TREE_TRUNK = '#7c5a3a';
const TREE_GREENS = ['#3f8f3a', '#4ba343', '#5aa84e', '#357f31']; // round (deciduous) trees
const PINE_GREENS = ['#2f6e3a', '#27613a', '#356f44'];            // conifers — darker
const BUSH_GREENS = ['#6cb95a', '#7cc266', '#5fae4d'];            // bushes — lighter
const BUILDING_FACADES = [
  '#e6d6ad', '#d9c79c', '#cdb98c', '#e3c9a0',  // warm tans / creams
  '#dcc2a0', '#cdd3c0', '#e0cab8', '#c9c2b0',  // muted greige / sage
  '#f4f1ea', '#eef0f3', '#f6f5f2',             // whites
  '#d8dbde', '#c6cacd', '#cdd0d3',             // light grays
];
const BUILDING_ROOFS = ['#b65b38', '#9c4f33', '#6f4e3d', '#7d8a93', '#a8523f', '#566069'];

// Wall-gap thickness as a fraction of the road-cell size.
const WALL_RATIO = 0.42;

const STEP_MS = 380;        // per-step animation duration (slower so the player can read each line)
const RESET_MS = 420;       // duration of return-to-start animation on fail
const READ_MS = 600;        // pause after each driver line so the player can read it before the car moves
const LIGHT_TICK_MS = 320;  // visible delay between ticks while a wait-for-green is being consumed
const LIGHT_TICK_SAFETY = 24; // upper bound on ticks consumed during a single wait (~3 cycles)

// Headings (where the car is pointing)
export const HEADING = {
  E: 0, S: Math.PI / 2, W: Math.PI, N: -Math.PI / 2,
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    this.maze = null;
    this.cellPx = mobileViewport() ? 40 : 48; // road-cell size
    this.wallPx = 0;                          // wall-gap thickness (set in _resizeCanvas)
    this.car = { col: 0, row: 0, heading: HEADING.E }; // logical
    this._displayCar = { x: 0, y: 0, heading: HEADING.E }; // animated
    this._aborted = false;
  }

  setMaze(maze) {
    this.maze = maze;
    this.cellPx = this.computeCellPx(maze.cols);
    this._resizeCanvas();
    const startHeading = this._headingForOpenRoad(0, 0);
    this.car = { col: 0, row: 0, heading: startHeading };
    const start = this._cellCenter(0, 0);
    this._displayCar = { x: start.x, y: start.y, heading: startHeading };
    this._tick = 0;
    this._pendingWait = false;
    this.render();
  }

  // Pick the largest road-cell size that lets the whole board (roads + wall
  // gaps) fit inside the canvas wrapper, capped at the natural size for the
  // current viewport. Total board width ≈ road*cols + wall*(cols+1), and
  // wall ≈ WALL_RATIO*road, so width ≈ road*(cols + WALL_RATIO*(cols+1)).
  computeCellPx(cols) {
    const natural = mobileViewport() ? 40 : 48;
    const wrap = this.canvas.parentElement;
    const wrapWidth = wrap ? wrap.clientWidth : window.innerWidth;
    const padding = mobileViewport() ? 8 : 16;
    const avail = wrapWidth - padding;
    const fit = Math.floor(avail / (cols + WALL_RATIO * (cols + 1)));
    return Math.max(18, Math.min(natural, fit));
  }

  // Returns a HEADING that points toward an open passage from (col,row).
  // Preference order: E, S, W, N (so on (0,0) the car prefers East when both
  // E and S are open, matching the previous default).
  _headingForOpenRoad(col, row) {
    const cell = this.maze.grid[row][col];
    if (cell.e) return HEADING.E;
    if (cell.s) return HEADING.S;
    if (cell.w) return HEADING.W;
    if (cell.n) return HEADING.N;
    return HEADING.E;
  }

  abort() { this._aborted = true; }

  // Runs a sequence of high-level driver actions. The engine owns all geometry —
  // heading math (driver's left vs map's left), where intersections are, what
  // counts as a turn opportunity. The LLM never sees compass directions.
  //
  // action shapes (see js/gemini.js for the prompt that produces them):
  //   { type: 'move', count: N, msg, icon }
  //   { type: 'move_until', target: 'wall' | 'intersection', msg, icon }
  //   { type: 'take_turn', dir: 'left' | 'right', msg, icon }
  //   { type: 'turn', dir: 'left' | 'right' | 'around', msg, icon }
  //   { type: 'say', msg, icon }
  //
  // Returns { success, hitWallAt? }.
  async animateActions(actions, onMsg) {
    if (!this.maze) throw new Error('no maze');
    this._aborted = false;
    this._tick = 0;
    this._pendingWait = false;
    const { grid, dest, lights } = this.maze;

    let col = this.car.col;
    let row = this.car.row;
    let dir = headingToDir(this.car.heading);
    let prevCol = -1, prevRow = -1;
    // Lookahead bookkeeping — when an upcoming lit cell needs a wait and one
    // hasn't been queued yet, we may claim a wait_for_green from later in the
    // action list. Those indices get skipped when the for-loop reaches them.
    const skipIndices = new Set();
    let actionIndex = 0;

    const backDirFromPrev = () => {
      if (prevCol < 0) return null;
      if (prevRow === row && prevCol === col - 1) return 'w';
      if (prevRow === row && prevCol === col + 1) return 'e';
      if (prevCol === col && prevRow === row - 1) return 'n';
      if (prevCol === col && prevRow === row + 1) return 's';
      return null;
    };

    const failWall = () => {
      onMsg?.({ icon: '🚧', msg: 'Wall ahead — aborting route.', kind: 'fail' });
      this.car.col = col; this.car.row = row; this.car.heading = dirToHeading(dir);
      return { success: false, hitWallAt: { col, row, dir } };
    };
    const failRed = () => {
      onMsg?.({ icon: '🛑', msg: 'Ran a red — that\'s a busted attempt.', kind: 'fail' });
      this.car.col = col; this.car.row = row; this.car.heading = dirToHeading(dir);
      return { success: false, ranRed: true };
    };
    const atDest = () => col === dest.col && row === dest.row;
    const reachedDest = () => {
      this.car.col = col; this.car.row = row; this.car.heading = dirToHeading(dir);
      return { success: true, hitWallAt: null };
    };

    // Centralised per-cell advance: red-light check (consuming pendingWait or
    // claiming a future wait_for_green if available), then tween into the
    // target cell, then tick++. Returns null on red-light fail.
    const advanceOne = async (fromCol, fromRow, intoDir) => {
      const [tc, tr] = stepCell(fromCol, fromRow, intoDir);
      let ok = await this._consumeLightAt(tc, tr, onMsg);
      if (!ok) {
        // Engine forgiveness: the player included a wait_for_green further
        // down the action list (natural English order — "drive to the
        // intersection, wait for the green, then turn"). Claim it now.
        for (let j = actionIndex + 1; j < actions.length; j++) {
          if (skipIndices.has(j)) continue;
          if (actions[j].type === 'wait_for_green') {
            skipIndices.add(j);
            this._pendingWait = true;
            ok = await this._consumeLightAt(tc, tr, onMsg);
            break;
          }
        }
      }
      if (!ok) return null;
      await this._tweenStep(fromCol, fromRow, intoDir);
      this._tick += 1;
      this.render();
      return { tc, tr };
    };

    for (actionIndex = 0; actionIndex < actions.length; actionIndex++) {
      if (this._aborted) break;
      if (skipIndices.has(actionIndex)) continue; // already claimed by a lookahead
      const action = actions[actionIndex];
      const { msg = '', icon = '🚗' } = action;
      onMsg?.({ icon, msg, kind: 'info' });
      // Give the player a beat to read the new line before the car moves.
      await this._wait(READ_MS);
      if (this._aborted) break;

      switch (action.type) {
        case 'move': {
          const n = action.count;
          for (let i = 0; i < n; i++) {
            if (this._aborted) break;
            if (!grid[row][col][dir]) return failWall();
            const r = await advanceOne(col, row, dir);
            if (!r) return failRed();
            prevCol = col; prevRow = row;
            col = r.tc; row = r.tr;
            if (atDest()) return reachedDest();
          }
          break;
        }

        case 'move_until': {
          // Follow the corridor (handling bends like follow_road does) and
          // stop when the named target is reached. Without bend-following,
          // "drive to the next intersection" would crash at the first curve
          // in a bendy corridor between two intersections.
          let safety = 0;
          while (safety++ < 200) {
            if (this._aborted) break;
            if (action.target === 'intersection' && countOpen(grid[row][col]) >= 3) break;
            const cell = grid[row][col];
            const back = backDirFromPrev();
            const openDirs = ['n','s','e','w'].filter(d => cell[d]);
            const forwardOptions = back ? openDirs.filter(d => d !== back) : openDirs;
            // No forward options = dead end (or wall). For target=wall this is
            // the intended stop; for intersection we never found one. Either
            // way, stop gracefully.
            if (forwardOptions.length === 0) break;
            // Multiple forward options = at an intersection. For
            // target=intersection we'd have broken above; for target=wall
            // stop here (the player asked to go to a wall, not a fork).
            if (forwardOptions.length >= 2) break;
            const nextDir = forwardOptions[0];
            if (nextDir !== dir) {
              dir = nextDir;
              await this._rotateTo(col, row, dir);
            }
            const r = await advanceOne(col, row, dir);
            if (!r) return failRed();
            prevCol = col; prevRow = row;
            col = r.tc; row = r.tr;
            if (atDest()) return reachedDest();
          }
          break;
        }

        case 'take_turn': {
          const sideFor = (d) => action.dir === 'left' ? leftOf(d) : rightOf(d);
          let safety = 0;
          let sideOpen = grid[row][col][sideFor(dir)];
          while (!sideOpen && safety++ < 200) {
            if (this._aborted) break;
            if (!grid[row][col][dir]) break;
            const r = await advanceOne(col, row, dir);
            if (!r) return failRed();
            prevCol = col; prevRow = row;
            col = r.tc; row = r.tr;
            if (atDest()) return reachedDest();
            sideOpen = grid[row][col][sideFor(dir)];
          }
          if (sideOpen) {
            dir = sideFor(dir);
            await this._rotateTo(col, row, dir);
            if (grid[row][col][dir]) {
              const r = await advanceOne(col, row, dir);
              if (!r) return failRed();
              prevCol = col; prevRow = row;
              col = r.tc; row = r.tr;
              if (atDest()) return reachedDest();
            }
          }
          break;
        }

        case 'turn': {
          if (action.dir === 'left') dir = leftOf(dir);
          else if (action.dir === 'right') dir = rightOf(dir);
          else if (action.dir === 'around') dir = reverseOf(dir);
          await this._rotateTo(col, row, dir);
          if (grid[row][col][dir]) {
            const r = await advanceOne(col, row, dir);
            if (!r) return failRed();
            prevCol = col; prevRow = row;
            col = r.tc; row = r.tr;
            if (atDest()) return reachedDest();
          }
          break;
        }

        case 'wait_for_green': {
          // Sets a token consumed at the next lit-cell entry. The actual hold
          // animation happens inside _consumeLightAt so the player sees the
          // signal cycle as the driver waits.
          this._pendingWait = true;
          break;
        }

        case 'wait': {
          // Single-tick wait — advance time without moving.
          this._tick += 1;
          this.render();
          await this._wait(READ_MS);
          break;
        }

        case 'say':
          break;

        case 'follow_road': {
          let safety = 0;
          while (safety++ < 400) {
            if (this._aborted) break;
            const cell = grid[row][col];
            const back = backDirFromPrev();
            const openDirs = ['n','s','e','w'].filter(d => cell[d]);
            const forwardOptions = back ? openDirs.filter(d => d !== back) : openDirs;

            if (forwardOptions.length === 0) return failWall();
            if (forwardOptions.length >= 2) break;

            const nextDir = forwardOptions[0];
            if (nextDir !== dir) {
              dir = nextDir;
              await this._rotateTo(col, row, dir);
            }
            const r = await advanceOne(col, row, dir);
            if (!r) return failRed();
            prevCol = col; prevRow = row;
            col = r.tc; row = r.tr;
            if (atDest()) return reachedDest();
          }
          break;
        }
      }

      this.car.col = col; this.car.row = row; this.car.heading = dirToHeading(dir);
    }

    if (this._aborted) return { success: false, aborted: true };
    this.car.col = col; this.car.row = row; this.car.heading = dirToHeading(dir);
    return { success: atDest(), hitWallAt: null };
  }

  // Red-light enforcement. If the target cell is lit and not currently green,
  // either consume a pending wait token (advancing ticks visibly until the
  // light turns green) or fail the attempt. Returns true if the car may enter.
  async _consumeLightAt(targetCol, targetRow, onMsg) {
    const lights = this.maze?.lights;
    if (!lights || lights.size === 0) return true;
    const light = lights.get(`${targetCol},${targetRow}`);
    if (!light) return true;
    let color = lightColorAt(light, this._tick);
    if (color === 'G') return true;
    if (!this._pendingWait) return false;
    // Show the hold visually: advance one tick at a time, re-render so the
    // signal's circles cycle, pause briefly between ticks.
    onMsg?.({ icon: '🚦', msg: 'Holding for the green light...', kind: 'info' });
    let safety = 0;
    while (color !== 'G' && safety++ < LIGHT_TICK_SAFETY) {
      if (this._aborted) return true;
      this._tick += 1;
      this.render();
      await this._wait(LIGHT_TICK_MS);
      color = lightColorAt(light, this._tick);
    }
    this._pendingWait = false;
    onMsg?.({ icon: '✅', msg: 'Green. Rolling.', kind: 'info' });
    return true;
  }

  _tweenStep(col, row, dir) {
    const [tc, tr] = stepCell(col, row, dir);
    return this._tweenTo(tc, tr, dirToHeading(dir));
  }

  // Promise that resolves after `ms` or when an abort fires, whichever first.
  _wait(ms) {
    return new Promise((resolve) => {
      const start = performance.now();
      const tick = () => {
        if (this._aborted) return resolve();
        if (performance.now() - start >= ms) return resolve();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  _rotateTo(col, row, dir) {
    return new Promise((resolve) => {
      const target = dirToHeading(dir);
      const fromH = this._displayCar.heading;
      const dH = shortestAngleDelta(fromH, target);
      if (Math.abs(dH) < 0.001) return resolve();
      const t0 = performance.now();
      const duration = 220;
      const tick = (now) => {
        if (this._aborted) return resolve();
        const t = Math.min(1, (now - t0) / duration);
        const e = easeInOutCubic(t);
        this._displayCar.heading = fromH + dH * e;
        this.render();
        if (t < 1) requestAnimationFrame(tick);
        else {
          this._displayCar.heading = target;
          this.render();
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
  }

  // Animate the car back to (0,0). Public so game.js can call it after a fail.
  resetCar() {
    this._aborted = false;
    return this._returnToStart();
  }

  _returnToStart() {
    return new Promise((resolve) => {
      const start = this._cellCenter(0, 0);
      const startHeading = this._headingForOpenRoad(0, 0);
      const from = { ...this._displayCar };
      const dHead = shortestAngleDelta(from.heading, startHeading);
      const t0 = performance.now();
      const duration = RESET_MS;
      const tick = (now) => {
        if (this._aborted) return resolve();
        const t = Math.min(1, (now - t0) / duration);
        const e = easeInOutCubic(t);
        this._displayCar.x = from.x + (start.x - from.x) * e;
        this._displayCar.y = from.y + (start.y - from.y) * e;
        this._displayCar.heading = from.heading + dHead * e;
        this.render();
        if (t < 1) requestAnimationFrame(tick);
        else {
          this.car = { col: 0, row: 0, heading: startHeading };
          this._displayCar = { x: start.x, y: start.y, heading: startHeading };
          this.render();
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
  }

  _tweenTo(tc, tr, heading) {
    return new Promise((resolve) => {
      const fromX = this._displayCar.x, fromY = this._displayCar.y;
      const fromH = this._displayCar.heading;
      const target = this._cellCenter(tc, tr);
      const t0 = performance.now();
      const duration = STEP_MS;
      const dHead = shortestAngleDelta(fromH, heading);

      const tick = (now) => {
        if (this._aborted) return resolve();
        const t = Math.min(1, (now - t0) / duration);
        const e = easeInOutCubic(t);
        this._displayCar.x = fromX + (target.x - fromX) * e;
        this._displayCar.y = fromY + (target.y - fromY) * e;
        this._displayCar.heading = fromH + dHead * e;
        this.render();
        if (t < 1) requestAnimationFrame(tick);
        else {
          this._displayCar.heading = heading;
          this.render();
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
  }

  // -------- Rendering --------

  render() {
    if (!this.maze) return;
    const { ctx } = this;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Grass background — every non-road area shows through as green.
    ctx.fillStyle = GRASS;
    ctx.fillRect(0, 0, w, h);

    const { cols, rows, grid } = this.maze;

    // Road cells.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) this._drawRoadCell(c, r);
    }
    // Road connectors filling the wall gaps at open passages.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = grid[r][c];
        if (cell.e && c < cols - 1) this._drawConnector(c, r, 'e');
        if (cell.s && r < rows - 1) this._drawConnector(c, r, 's');
      }
    }
    // Dashed lane markings down the corridors.
    this._drawLaneMarkings();
    // Trees and buildings in the green blocks.
    this._drawScenery();
    // Start + destination overlays.
    this._drawStartDest();
    // Traffic lights at lit intersections.
    this._drawLights();
    // Car (drawn last so it is on top).
    this._drawCar();

    ctx.restore();
  }

  _drawRoadCell(c, r) {
    const ctx = this.ctx;
    const { x, y, size } = this._cellRect(c, r);
    ctx.fillStyle = ROAD;
    ctx.fillRect(x, y, size, size);

    // Sidewalk edge wherever the road tile meets grass (a closed side).
    const cell = this.maze.grid[r][c];
    const inset = Math.max(2, size * 0.08);
    ctx.fillStyle = SIDEWALK;
    if (!cell.n) ctx.fillRect(x, y, size, inset);
    if (!cell.s) ctx.fillRect(x, y + size - inset, size, inset);
    if (!cell.w) ctx.fillRect(x, y, inset, size);
    if (!cell.e) ctx.fillRect(x + size - inset, y, inset, size);
  }

  // Fills the wall gap between a cell and its E or S neighbour with road.
  _drawConnector(c, r, side) {
    const ctx = this.ctx;
    const { x, y, size } = this._cellRect(c, r);
    const wall = this.wallPx;
    const inset = Math.max(2, size * 0.08);
    ctx.fillStyle = ROAD;
    if (side === 'e') {
      ctx.fillRect(x + size, y, wall, size);
      ctx.fillStyle = SIDEWALK;
      ctx.fillRect(x + size, y, wall, inset);
      ctx.fillRect(x + size, y + size - inset, wall, inset);
    } else {
      ctx.fillRect(x, y + size, size, wall);
      ctx.fillStyle = SIDEWALK;
      ctx.fillRect(x, y + size, inset, wall);
      ctx.fillRect(x + size - inset, y + size, inset, wall);
    }
  }

  _drawLaneMarkings() {
    const { cols, rows, grid } = this.maze;
    const ctx = this.ctx;
    const dash = Math.max(3, this.cellPx * 0.18);
    ctx.save();
    ctx.strokeStyle = LANE_DASH;
    ctx.lineWidth = Math.max(1, this.cellPx * 0.045);
    ctx.setLineDash([dash, dash]);
    ctx.beginPath();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = grid[r][c];
        const a = this._cellCenter(c, r);
        if (cell.e && c < cols - 1) {
          const b = this._cellCenter(c + 1, r);
          ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        }
        if (cell.s && r < rows - 1) {
          const b = this._cellCenter(c, r + 1);
          ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        }
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  // Decorates the green blocks: closed wall gaps + corner blocks.
  _drawScenery() {
    const { cols, rows, grid } = this.maze;
    // Corner blocks — small wall×wall squares, always green.
    for (let gr = 0; gr <= rows; gr++) {
      for (let gc = 0; gc <= cols; gc++) {
        this._decorateSlot(2 * gc, 2 * gr, 'corner');
      }
    }
    // Vertical wall slots (E/W gaps) — green when the passage is closed.
    for (let r = 0; r < rows; r++) {
      for (let sc = 0; sc <= cols; sc++) {
        const closed = (sc === 0 || sc === cols) ? true : !grid[r][sc - 1].e;
        if (closed) this._decorateSlot(2 * sc, 2 * r + 1, 'wall');
      }
    }
    // Horizontal wall slots (N/S gaps) — green when the passage is closed.
    for (let c = 0; c < cols; c++) {
      for (let sr = 0; sr <= rows; sr++) {
        const closed = (sr === 0 || sr === rows) ? true : !grid[sr - 1][c].s;
        if (closed) this._decorateSlot(2 * c + 1, 2 * sr, 'wall');
      }
    }
  }

  _decorateSlot(sc, sr, kind) {
    const x = this._slotX(sc), y = this._slotX(sr);
    const w = this._slotSize(sc), h = this._slotSize(sr);
    if (w < 2 || h < 2) return;
    // Leave grass plain around START and DEST so trees/buildings don't
    // crowd the labelled tiles or overhang their corners.
    if (this._slotTouchesAnchor(sc, sr)) return;
    const seed = (hashString(`${sc}:${sr}:${kind}`) ^ (this.maze.seed | 0)) >>> 0;
    const rand = mulberry32(seed);
    const roll = rand();
    const cx = x + w / 2, cy = y + h / 2;
    if (kind === 'corner') {
      // Small block — a plant or grass.
      if (roll < 0.5) this._drawPlant(cx, cy, Math.min(w, h) * 1.5, rand, 'small');
      return;
    }
    // Wall slot — building, plant, or grass.
    if (roll < 0.46) {
      this._drawBuilding(x, y, w, h, rand);
    } else if (roll < 0.85) {
      this._drawPlant(cx, cy, Math.min(w, h) * 1.9, rand, 'wall');
    }
  }

  // True when the wall/corner slot (sc, sr) is adjacent to the START or DEST
  // road cell — i.e. the slot's neighbours include that cell. Road cell (c, r)
  // lives at slot (2c+1, 2r+1); any wall/corner slot within ±1 on each axis
  // touches it.
  _slotTouchesAnchor(sc, sr) {
    const targets = [
      { col: 0, row: 0 },
      { col: this.maze.dest.col, row: this.maze.dest.row },
    ];
    for (const t of targets) {
      const cellSc = 2 * t.col + 1;
      const cellSr = 2 * t.row + 1;
      if (Math.abs(sc - cellSc) <= 1 && Math.abs(sr - cellSr) <= 1) return true;
    }
    return false;
  }

  // Picks a plant type and draws it. Corner ('small') slots lean toward bushes;
  // wall slots get the full round-tree / pine / bush mix.
  _drawPlant(cx, cy, size, rand, context) {
    const t = rand();
    if (context === 'small') {
      if (t < 0.68) return this._drawBush(cx, cy, size, rand);
      return this._drawRoundTree(cx, cy, size * 0.9, rand);
    }
    if (t < 0.40) return this._drawRoundTree(cx, cy, size, rand);
    if (t < 0.72) return this._drawPineTree(cx, cy, size, rand);
    return this._drawBush(cx, cy, size * 0.9, rand);
  }

  _drawBuilding(x, y, w, h, rand) {
    const ctx = this.ctx;
    const pad = Math.max(1, Math.min(w, h) * 0.12);
    const bx = x + pad, by = y + pad, bw = w - pad * 2, bh = h - pad * 2;
    if (bw < 3 || bh < 3) return;

    ctx.fillStyle = BUILDING_FACADES[Math.floor(rand() * BUILDING_FACADES.length)];
    ctx.fillRect(bx, by, bw, bh);

    // Roof band along the top edge (colour varies per building).
    const roof = Math.max(2, Math.min(bw, bh) * 0.34);
    ctx.fillStyle = BUILDING_ROOFS[Math.floor(rand() * BUILDING_ROOFS.length)];
    ctx.fillRect(bx, by, bw, roof);

    // A couple of window dots on the facade below the roof, if there's room.
    const winTop = by + roof + Math.max(1, bh * 0.08);
    const winH = bh - roof - Math.max(1, bh * 0.08) * 2;
    if (winH >= 3 && bw >= 6) {
      ctx.fillStyle = 'rgba(70, 100, 140, 0.75)';
      const winSize = Math.min(winH, bw * 0.22, 5);
      const slots = Math.max(1, Math.floor(bw / (winSize * 2.2)));
      const gap = bw / (slots + 1);
      for (let i = 1; i <= slots; i++) {
        ctx.fillRect(bx + gap * i - winSize / 2, winTop, winSize, Math.min(winSize, winH));
      }
    }
  }

  // Round (deciduous) tree — trunk + a 3-lobe canopy.
  _drawRoundTree(cx, cy, size, rand) {
    const ctx = this.ctx;
    const trunkW = Math.max(2, size * 0.16);
    const trunkH = Math.max(3, size * 0.30);
    ctx.fillStyle = TREE_TRUNK;
    ctx.fillRect(cx - trunkW / 2, cy + size * 0.04, trunkW, trunkH);

    const green = TREE_GREENS[Math.floor(rand() * TREE_GREENS.length)];
    const cr = size * 0.34;
    ctx.fillStyle = green;
    for (const [px, py] of [
      [cx, cy - cr * 0.5],
      [cx - cr * 0.72, cy + cr * 0.16],
      [cx + cr * 0.72, cy + cr * 0.16],
    ]) {
      ctx.beginPath();
      ctx.arc(px, py, cr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
    ctx.beginPath();
    ctx.arc(cx + cr * 0.72, cy + cr * 0.16, cr * 0.82, 0, Math.PI * 2);
    ctx.fill();
  }

  // Pine / conifer — short trunk + 3 stacked triangle tiers, widest at the base.
  _drawPineTree(cx, cy, size, rand) {
    const ctx = this.ctx;
    const trunkW = Math.max(2, size * 0.12);
    const trunkH = Math.max(3, size * 0.20);
    const bottom = cy + size * 0.46;
    ctx.fillStyle = TREE_TRUNK;
    ctx.fillRect(cx - trunkW / 2, bottom - trunkH, trunkW, trunkH);

    ctx.fillStyle = PINE_GREENS[Math.floor(rand() * PINE_GREENS.length)];
    const top = cy - size * 0.5;
    const canopyBot = bottom - trunkH;
    const tiers = 3;
    for (let i = 0; i < tiers; i++) {
      const frac = i / tiers;
      const tierTopY = top + (canopyBot - top) * frac * 0.85;
      const tierBotY = top + (canopyBot - top) * ((i + 1) / tiers);
      // Wider at the BOTTOM — i grows top→bottom, so width grows with i too.
      const widthFrac = i / Math.max(1, tiers - 1); // 0, .5, 1 for 3 tiers
      const halfW = size * (0.16 + 0.28 * widthFrac);
      ctx.beginPath();
      ctx.moveTo(cx, tierTopY);
      ctx.lineTo(cx - halfW, tierBotY);
      ctx.lineTo(cx + halfW, tierBotY);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Bush — one or two low rounded blobs, no real trunk.
  _drawBush(cx, cy, size, rand) {
    const ctx = this.ctx;
    const green = BUSH_GREENS[Math.floor(rand() * BUSH_GREENS.length)];
    const r = size * 0.30;
    ctx.fillStyle = green;
    if (rand() < 0.5) {
      ctx.beginPath();
      ctx.arc(cx, cy + size * 0.12, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(cx - r * 0.5, cy + size * 0.14, r * 0.85, 0, Math.PI * 2);
      ctx.arc(cx + r * 0.5, cy + size * 0.14, r * 0.85, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
    ctx.beginPath();
    ctx.arc(cx + r * 0.45, cy + size * 0.16, r * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawStartDest() {
    const ctx = this.ctx;
    const s = this.cellPx;

    // Start tile.
    const start = this._cellRect(0, 0);
    ctx.save();
    ctx.fillStyle = 'rgba(37, 99, 235, 0.22)';
    ctx.fillRect(start.x, start.y, s, s);
    ctx.strokeStyle = 'rgba(37, 99, 235, 0.95)';
    ctx.lineWidth = 2;
    ctx.strokeRect(start.x + 1, start.y + 1, s - 2, s - 2);
    ctx.fillStyle = '#15307a';
    ctx.font = `700 ${Math.max(7, Math.floor(s * 0.2))}px ${fontStack()}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('START', start.x + 3, start.y + 3);
    ctx.restore();

    // Destination tile — bold red border + warm gold fill + outlined star so
    // it pops against the grass and surrounding scenery.
    const dest = this._cellRect(this.maze.dest.col, this.maze.dest.row);
    ctx.save();
    ctx.fillStyle = 'rgba(250, 204, 21, 0.45)';
    ctx.fillRect(dest.x, dest.y, s, s);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#dc2626';
    ctx.strokeRect(dest.x + 1.5, dest.y + 1.5, s - 3, s - 3);
    // Star with a dark outline for legibility on any background.
    const starSize = Math.max(14, Math.floor(s * 0.6));
    ctx.font = `${starSize}px ${fontStack()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, starSize * 0.12);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#7a2e0e';
    ctx.strokeText('★', dest.x + s / 2, dest.y + s / 2);
    ctx.fillStyle = '#facc15';
    ctx.fillText('★', dest.x + s / 2, dest.y + s / 2);
    // DEST label in dark red for contrast with the gold tint.
    ctx.fillStyle = '#7a1d1d';
    ctx.font = `700 ${Math.max(7, Math.floor(s * 0.2))}px ${fontStack()}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('DEST', dest.x + 3, dest.y + 3);
    ctx.restore();
  }

  // Small traffic-light fixture in the corner of each lit intersection cell.
  // Three vertical circles: red top, yellow middle, green bottom. The circle
  // matching the current phase glows bright; the others dim.
  _drawLights() {
    const lights = this.maze?.lights;
    if (!lights || lights.size === 0) return;
    const ctx = this.ctx;
    const s = this.cellPx;
    const tick = this._tick | 0;
    const fixW = Math.max(8, s * 0.22);
    const fixH = Math.max(18, s * 0.52);
    const pad = Math.max(2, s * 0.06);
    const cr = Math.max(2, fixW * 0.30);

    for (const light of lights.values()) {
      const rect = this._cellRect(light.col, light.row);
      // Centered in the intersection cell — the car drives past it.
      const fx = rect.x + (s - fixW) / 2;
      const fy = rect.y + (s - fixH) / 2;
      // Fixture body — dark rounded rect.
      ctx.fillStyle = '#1f2937';
      roundRect(ctx, fx, fy, fixW, fixH, 2);
      ctx.fill();
      // Subtle highlight on the left edge (suggests a metal post / housing).
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(fx + 1, fy + 1, 1, fixH - 2);

      const color = lightColorAt(light, tick);
      const cx = fx + fixW / 2;
      const cyR = fy + fixH * 0.20;
      const cyY = fy + fixH * 0.50;
      const cyG = fy + fixH * 0.80;
      this._drawLightCircle(cx, cyR, cr, color === 'R' ? '#ef4444' : '#4a1f22');
      this._drawLightCircle(cx, cyY, cr, color === 'Y' ? '#facc15' : '#4a431a');
      this._drawLightCircle(cx, cyG, cr, color === 'G' ? '#22c55e' : '#1a4a2c');
    }
  }

  _drawLightCircle(cx, cy, r, fill) {
    const ctx = this.ctx;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawCar() {
    const ctx = this.ctx;
    const s = this.cellPx;
    const len = s * 0.62;
    const wid = s * 0.36;
    const { x, y, heading } = this._displayCar;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(heading);

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    roundRect(ctx, -len / 2 + 1, -wid / 2 + 2, len, wid, 4);
    ctx.fill();

    // Body
    ctx.fillStyle = '#2563eb';
    roundRect(ctx, -len / 2, -wid / 2, len, wid, 5);
    ctx.fill();

    // Roof / windshield
    ctx.fillStyle = '#1d4ed8';
    roundRect(ctx, -len * 0.08, -wid * 0.42, len * 0.5, wid * 0.84, 3);
    ctx.fill();
    ctx.fillStyle = 'rgba(173, 216, 230, 0.85)';
    roundRect(ctx, len * 0.06, -wid * 0.34, len * 0.18, wid * 0.68, 1);
    ctx.fill();

    // Wheels
    ctx.fillStyle = '#0b1220';
    const ww = Math.max(2, len * 0.08), wh = Math.max(2, wid * 0.22);
    ctx.fillRect(-len * 0.35, -wid / 2 - wh * 0.2, ww, wh);
    ctx.fillRect( len * 0.27, -wid / 2 - wh * 0.2, ww, wh);
    ctx.fillRect(-len * 0.35,  wid / 2 - wh * 0.8, ww, wh);
    ctx.fillRect( len * 0.27,  wid / 2 - wh * 0.8, ww, wh);

    // Headlights (front)
    ctx.fillStyle = '#fef3c7';
    ctx.fillRect(len * 0.42, -wid * 0.32, 3, 3);
    ctx.fillRect(len * 0.42,  wid * 0.20, 3, 3);
    // Tail lights (rear)
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(-len * 0.46, -wid * 0.32, 2, 3);
    ctx.fillRect(-len * 0.46,  wid * 0.20, 2, 3);

    ctx.restore();
  }

  // -------- Helpers --------

  _resizeCanvas() {
    const { cols, rows } = this.maze;
    // Derive the wall-gap thickness from the road-cell size.
    this.wallPx = Math.max(6, Math.round(this.cellPx * WALL_RATIO));
    const wCss = this._slotX(2 * cols + 1);
    const hCss = this._slotX(2 * rows + 1);
    this.canvas.style.width = wCss + 'px';
    this.canvas.style.height = hCss + 'px';
    this.canvas.width = Math.round(wCss * this.dpr);
    this.canvas.height = Math.round(hCss * this.dpr);
  }

  // Slot model: the board is a strip of `wall, road, wall, road, …, road, wall`
  // per axis. Even slot indices are wall gaps, odd indices are road cells.
  // _slotX works for both axes since the layout is symmetric.
  _slotX(slot) {
    return Math.ceil(slot / 2) * this.wallPx + Math.floor(slot / 2) * this.cellPx;
  }
  _slotSize(slot) {
    return slot % 2 === 0 ? this.wallPx : this.cellPx;
  }

  // Pixel rect of road cell (c, r) — that's slot (2c+1, 2r+1).
  _cellRect(c, r) {
    return {
      x: this._slotX(2 * c + 1),
      y: this._slotX(2 * r + 1),
      size: this.cellPx,
    };
  }

  _cellCenter(c, r) {
    const rect = this._cellRect(c, r);
    return { x: rect.x + rect.size / 2, y: rect.y + rect.size / 2 };
  }
}

// Driver-perspective turn math. dir is one of 'n','s','e','w'.
const LEFT_OF  = { n: 'w', w: 's', s: 'e', e: 'n' };
const RIGHT_OF = { n: 'e', e: 's', s: 'w', w: 'n' };
const REV_OF   = { n: 's', s: 'n', e: 'w', w: 'e' };

function leftOf(d) { return LEFT_OF[d]; }
function rightOf(d) { return RIGHT_OF[d]; }
function reverseOf(d) { return REV_OF[d]; }

function stepCell(c, r, d) {
  if (d === 'e') return [c + 1, r];
  if (d === 'w') return [c - 1, r];
  if (d === 's') return [c, r + 1];
  return [c, r - 1];
}

function countOpen(cell) {
  return (cell.n ? 1 : 0) + (cell.s ? 1 : 0) + (cell.e ? 1 : 0) + (cell.w ? 1 : 0);
}

function dirToHeading(d) {
  return d === 'e' ? HEADING.E : d === 'w' ? HEADING.W : d === 's' ? HEADING.S : HEADING.N;
}

function headingToDir(h) {
  // The four cardinal HEADING constants are exact, but tween rotations can land
  // slightly off due to easing; snap to the nearest cardinal.
  const TAU = Math.PI * 2;
  let a = ((h % TAU) + TAU) % TAU;
  if (a < Math.PI / 4 || a >= 7 * Math.PI / 4) return 'e';
  if (a < 3 * Math.PI / 4) return 's';
  if (a < 5 * Math.PI / 4) return 'w';
  return 'n';
}

function shortestAngleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mobileViewport() {
  return typeof window !== 'undefined' && window.innerWidth < 768;
}

function fontStack() {
  return '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
}
