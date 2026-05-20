// Canvas renderer + step animation.
//
// Owns the canvas, the current maze, and the car's position. game.js drives it
// via animateSteps(steps, onMsg, onDone).

import { mulberry32 } from './maze.js';

const FACADE_PALETTE = ['#5b6f87', '#7a6a55', '#6f5b75', '#5a7a6a', '#876f54'];
const ROAD = '#2a2a2a';
const SIDEWALK = '#3a3a3a';
const LANE_DASH = 'rgba(240, 220, 100, 0.7)';

const STEP_MS = 380;        // per-step animation duration (slower so the player can read each line)
const RESET_MS = 420;       // duration of return-to-start animation on fail
const READ_MS = 600;        // pause after each driver line so the player can read it before the car moves

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
    this.cellPx = mobileViewport() ? 48 : 56;
    this.car = { col: 0, row: 0, heading: HEADING.E }; // logical
    this._displayCar = { x: 0, y: 0, heading: HEADING.E }; // animated
    this._buildingSeeds = null;
    this._aborted = false;
  }

  setMaze(maze) {
    this.maze = maze;
    this.cellPx = this.computeCellPx(maze.cols);
    this._resizeCanvas();
    this._buildingSeeds = this._buildSeedTable(maze);
    const startHeading = this._headingForOpenRoad(0, 0);
    this.car = { col: 0, row: 0, heading: startHeading };
    const start = this._cellCenter(0, 0);
    this._displayCar = { x: start.x, y: start.y, heading: startHeading };
    this.render();
  }

  // Pick the largest cell size that lets `cols` columns fit inside the canvas
  // wrapper, capped at the natural size for the current viewport. Keeps the
  // 9×9 from overflowing a 375px phone, while leaving small mazes crisp.
  computeCellPx(cols) {
    const natural = mobileViewport() ? 48 : 56;
    const wrap = this.canvas.parentElement;
    const wrapWidth = wrap ? wrap.clientWidth : window.innerWidth;
    // canvas-wrap padding eats some width (4px each side on mobile, 8px on desktop).
    const padding = mobileViewport() ? 8 : 16;
    const fit = Math.floor((wrapWidth - padding) / cols);
    return Math.max(20, Math.min(natural, fit));
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
    const { grid, dest } = this.maze;

    let col = this.car.col;
    let row = this.car.row;
    let dir = headingToDir(this.car.heading);
    // Track the cell we were in immediately before arriving at (col, row).
    // Needed because after a `turn` action the heading changes but we haven't
    // moved — so reverseOf(heading) no longer points to where we came from.
    let prevCol = -1, prevRow = -1;

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
    const atDest = () => col === dest.col && row === dest.row;
    const reachedDest = () => {
      this.car.col = col; this.car.row = row; this.car.heading = dirToHeading(dir);
      return { success: true, hitWallAt: null };
    };

    for (const action of actions) {
      if (this._aborted) break;
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
            prevCol = col; prevRow = row;
            await this._tweenStep(col, row, dir);
            [col, row] = stepCell(col, row, dir);
            if (atDest()) return reachedDest();
          }
          break;
        }

        case 'move_until': {
          // Graceful: stop at wall even if the named target was never found.
          let safety = 0;
          while (safety++ < 200) {
            if (this._aborted) break;
            if (action.target === 'intersection' && countOpen(grid[row][col]) >= 3) break;
            if (!grid[row][col][dir]) break;
            prevCol = col; prevRow = row;
            await this._tweenStep(col, row, dir);
            [col, row] = stepCell(col, row, dir);
            if (atDest()) return reachedDest();
          }
          break;
        }

        case 'take_turn': {
          // Graceful: if the requested side never opens before the corridor
          // ends, stop at the wall. We still rotate to face the side if we
          // did find an opening; otherwise leave heading alone.
          const sideFor = (d) => action.dir === 'left' ? leftOf(d) : rightOf(d);
          let safety = 0;
          let sideOpen = grid[row][col][sideFor(dir)];
          while (!sideOpen && safety++ < 200) {
            if (this._aborted) break;
            if (!grid[row][col][dir]) break; // wall — no turn found
            prevCol = col; prevRow = row;
            await this._tweenStep(col, row, dir);
            [col, row] = stepCell(col, row, dir);
            if (atDest()) return reachedDest();
            sideOpen = grid[row][col][sideFor(dir)];
          }
          if (sideOpen) {
            dir = sideFor(dir);
            await this._rotateTo(col, row, dir);
            // Auto-step into the new corridor. Without this, a follow_road or
            // turn at an intersection would never get past it (forward
            // options >= 2 → stop). Taking a turn means committing to it.
            if (grid[row][col][dir]) {
              prevCol = col; prevRow = row;
              await this._tweenStep(col, row, dir);
              [col, row] = stepCell(col, row, dir);
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
          // Auto-step into the new direction if it has an open passage. Same
          // reason as take_turn — a turn at an intersection has to commit.
          if (grid[row][col][dir]) {
            prevCol = col; prevRow = row;
            await this._tweenStep(col, row, dir);
            [col, row] = stepCell(col, row, dir);
            if (atDest()) return reachedDest();
          }
          break;
        }

        case 'say':
          // Pure narration — no movement.
          break;

        case 'follow_road': {
          // Drive forward, automatically taking the only available turn at
          // every bend. Stops at a real "must choose" intersection, at a dead
          // end, or at DEST. "Back" is the actual previous cell (not just
          // reverseOf(heading)), so this works correctly after a turn.
          let safety = 0;
          while (safety++ < 400) {
            if (this._aborted) break;
            const cell = grid[row][col];
            const back = backDirFromPrev();
            const openDirs = ['n','s','e','w'].filter(d => cell[d]);
            const forwardOptions = back ? openDirs.filter(d => d !== back) : openDirs;

            if (forwardOptions.length === 0) {
              // Truly stuck (dead-end branch).
              return failWall();
            }
            if (forwardOptions.length >= 2) {
              // Real choice — stop and let the player decide.
              break;
            }
            const nextDir = forwardOptions[0];
            if (nextDir !== dir) {
              dir = nextDir;
              await this._rotateTo(col, row, dir);
            }
            prevCol = col; prevRow = row;
            await this._tweenStep(col, row, dir);
            [col, row] = stepCell(col, row, dir);
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
    ctx.fillStyle = '#0a0d11';
    ctx.fillRect(0, 0, w, h);

    const { cols, rows, grid } = this.maze;
    const s = this.cellPx;

    // Pass 1: roads (passable cells), pass 2: buildings (impassable would be… in a perfect maze, every cell is reachable).
    // Here, "buildings" sit between cells: a cell whose passage in dir D is closed has a wall on that side.
    // To get the spec's look we treat each cell as a road tile and draw building rectangles in the gaps (the wall blocks).
    //
    // Specifically the spec talks about "city blocks (walls)" — these are the impassable corners between 4 cells.
    // We draw them as small building tiles at the inter-cell intersections plus along closed cell boundaries.

    // Draw all road tiles.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        this._drawRoadCell(c, r, s);
      }
    }

    // Draw walls / buildings between adjacent cells (where the passage is closed).
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = grid[r][c];
        // North wall (only draw for top row; otherwise the south wall of the cell above handles it)
        if (!cell.n && r === 0) this._drawWall(c, r, 'n', s);
        if (!cell.w && c === 0) this._drawWall(c, r, 'w', s);
        if (!cell.e) this._drawWall(c, r, 'e', s);
        if (!cell.s) this._drawWall(c, r, 's', s);
      }
    }

    // Start + destination overlays.
    this._drawStartDest(s);

    // Car (drawn last so it is on top).
    this._drawCar();

    ctx.restore();
  }

  _drawRoadCell(c, r, s) {
    const ctx = this.ctx;
    const x = c * s, y = r * s;

    // Asphalt fill.
    ctx.fillStyle = ROAD;
    ctx.fillRect(x, y, s, s);

    // Sidewalk band inset (only where walls exist on that side).
    const cell = this.maze.grid[r][c];
    const inset = 4;
    ctx.fillStyle = SIDEWALK;
    if (!cell.n) ctx.fillRect(x, y, s, inset);
    if (!cell.s) ctx.fillRect(x, y + s - inset, s, inset);
    if (!cell.w) ctx.fillRect(x, y, inset, s);
    if (!cell.e) ctx.fillRect(x + s - inset, y, inset, s);

    // Dashed lane markings between adjacent road cells.
    // We add a dashed line spanning the corridor between the centres of this cell and the neighbour.
    const open = ['n','s','e','w'].filter(k => cell[k]).length;
    const drawDash = open <= 2; // skip dashes for 3- or 4-way intersections (looks busier without them)
    if (drawDash) {
      ctx.save();
      ctx.strokeStyle = LANE_DASH;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      const cx = x + s / 2, cy = y + s / 2;
      if (cell.e) { ctx.moveTo(cx, cy); ctx.lineTo(x + s, cy); }
      if (cell.w) { ctx.moveTo(cx, cy); ctx.lineTo(x, cy); }
      if (cell.n) { ctx.moveTo(cx, cy); ctx.lineTo(cx, y); }
      if (cell.s) { ctx.moveTo(cx, cy); ctx.lineTo(cx, y + s); }
      ctx.stroke();
      ctx.restore();
    }
  }

  _drawWall(c, r, side, s) {
    // Draw a building strip along the closed side. Width depends on side.
    const ctx = this.ctx;
    const x = c * s, y = r * s;
    const thickness = 4;
    let bx, by, bw, bh;
    if (side === 'n') { bx = x; by = y; bw = s; bh = thickness; }
    else if (side === 's') { bx = x; by = y + s - thickness; bw = s; bh = thickness; }
    else if (side === 'w') { bx = x; by = y; bw = thickness; bh = s; }
    else { bx = x + s - thickness; by = y; bw = thickness; bh = s; }

    // Pick a facade colour seeded by position so adjacent walls don't clash randomly.
    const seedKey = `${c},${r},${side}`;
    const seed = hashString(seedKey) >>> 0;
    const palIdx = seed % FACADE_PALETTE.length;
    ctx.fillStyle = FACADE_PALETTE[palIdx];
    ctx.fillRect(bx, by, bw, bh);

    // Roofline (darker band on top edge).
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    if (side === 'n') ctx.fillRect(bx, by, bw, 1);
    else if (side === 's') ctx.fillRect(bx, by, bw, 1);
    else if (side === 'w') ctx.fillRect(bx, by, 1, bh);
    else ctx.fillRect(bx, by, 1, bh);
  }

  _drawStartDest(s) {
    const ctx = this.ctx;

    // Start tile: blue tint border + "START" label.
    ctx.save();
    ctx.strokeStyle = 'rgba(96, 165, 250, 0.85)';
    ctx.lineWidth = 2;
    ctx.strokeRect(2, 2, s - 4, s - 4);
    ctx.fillStyle = 'rgba(96, 165, 250, 0.18)';
    ctx.fillRect(2, 2, s - 4, s - 4);
    ctx.fillStyle = 'rgba(219, 234, 254, 0.85)';
    ctx.font = `600 ${Math.max(8, Math.floor(s * 0.18))}px ${fontStack()}`;
    ctx.textBaseline = 'top';
    ctx.fillText('START', 5, 5);
    ctx.restore();

    // Destination tile: green tint, star, "DEST" label.
    const { col: dCol, row: dRow } = this.maze.dest;
    const dx = dCol * s;
    const dy = dRow * s;
    ctx.save();
    ctx.fillStyle = 'rgba(34, 197, 94, 0.28)';
    ctx.fillRect(dx + 2, dy + 2, s - 4, s - 4);
    ctx.strokeStyle = 'rgba(34, 197, 94, 0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(dx + 2, dy + 2, s - 4, s - 4);
    ctx.fillStyle = 'rgba(220, 252, 231, 0.95)';
    ctx.font = `${Math.max(14, Math.floor(s * 0.42))}px ${fontStack()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('★', dx + s / 2, dy + s / 2);
    ctx.font = `600 ${Math.max(8, Math.floor(s * 0.18))}px ${fontStack()}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('DEST', dx + 5, dy + 5);
    ctx.restore();
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
    const s = this.cellPx;
    const wCss = cols * s;
    const hCss = rows * s;
    this.canvas.style.width = wCss + 'px';
    this.canvas.style.height = hCss + 'px';
    this.canvas.width = Math.round(wCss * this.dpr);
    this.canvas.height = Math.round(hCss * this.dpr);
  }

  _cellCenter(c, r) {
    const s = this.cellPx;
    return { x: c * s + s / 2, y: r * s + s / 2 };
  }

  _buildSeedTable(maze) {
    // Reserved for future per-cell window seeds.
    const rand = mulberry32((maze.seed | 0) ^ 0xA5A5A5A5);
    const table = new Float32Array(maze.cols * maze.rows);
    for (let i = 0; i < table.length; i++) table[i] = rand();
    return table;
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
