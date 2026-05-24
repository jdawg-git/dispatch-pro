// App bootstrap: wires the controls bar to a fresh maze + renderer + game.

import { generateMaze, randomSeed } from './maze.js';
import { Renderer } from './renderer.js';
import { createGame } from './game.js';

const els = {
  canvas:           document.getElementById('city-canvas'),
  gridSize:         document.getElementById('grid-size'),
  difficulty:       document.getElementById('difficulty'),
  generateBtn:      document.getElementById('generate-btn'),
  transmitBtn:      document.getElementById('transmit-btn'),
  dispatchInput:    document.getElementById('dispatch-input'),
  dispatchBlock:    document.getElementById('dispatch-block'),
  lockoutBlock:     document.getElementById('lockout-block'),
  log:              document.getElementById('driver-log'),
  ripple:           document.getElementById('ripple'),
  charCount:        document.getElementById('char-count'),
  mapMeta:          document.getElementById('map-meta'),
  dispatchModeTag:  document.getElementById('dispatch-mode-tag'),
  lockoutBlockTextEl: document.getElementById('lockout-message'),
  inspectBtn:       document.getElementById('inspect-btn'),
  actionsModal:     document.getElementById('actions-modal'),
  actionsModalBody: document.getElementById('actions-modal-body'),
  attemptDots:      [...document.querySelectorAll('.attempt-dot')],
  attemptLabel:     document.getElementById('attempt-label'),
  toast:            document.getElementById('toast'),
  spinner:          document.querySelector('#transmit-btn .spinner'),
  btnLabel:         document.querySelector('#transmit-btn .btn-label'),
};

const renderer = new Renderer(els.canvas);
const game = createGame({ renderer, els, showToast });

function resetMap() {
  renderer.abort();
  const cols = Number(els.gridSize.value);
  const rows = cols;
  const difficulty = els.difficulty.value;
  const seed = randomSeed();
  const maze = generateMaze(cols, rows, seed, difficulty);
  renderer.setMaze(maze);
  updateMapMeta(maze);
  game.reset(maze);
}

function updateMapMeta(maze) {
  let intersections = 0, bends = 0, deadEnds = 0;
  const isStart = (c, r) => c === 0 && r === 0;
  const isDest  = (c, r) => c === maze.dest.col && r === maze.dest.row;
  for (let r = 0; r < maze.rows; r++) {
    for (let c = 0; c < maze.cols; c++) {
      const cell = maze.grid[r][c];
      const open = (cell.n?1:0) + (cell.s?1:0) + (cell.e?1:0) + (cell.w?1:0);
      if (open >= 3) intersections++;
      else if (open === 1 && !isStart(c, r) && !isDest(c, r)) deadEnds++;
      else if (open === 2 && !((cell.n && cell.s) || (cell.e && cell.w))) bends++;
    }
  }
  const path = maze.dest.distance;
  const lights = maze.lights ? maze.lights.size : 0;
  let html =
    `Path: <strong>${path}</strong> cells &middot; ` +
    `<strong>${intersections}</strong> intersection${intersections === 1 ? '' : 's'} &middot; ` +
    `<strong>${bends}</strong> bends &middot; ` +
    `<strong>${deadEnds}</strong> dead end${deadEnds === 1 ? '' : 's'}`;
  if (lights > 0) {
    html += ` &middot; <strong>${lights}</strong> traffic light${lights === 1 ? '' : 's'} 🚦`;
  }
  els.mapMeta.innerHTML = html;
}

els.generateBtn.addEventListener('click', resetMap);

// Live character count under the dispatch header.
function updateCharCount() {
  els.charCount.textContent = String(els.dispatchInput.value.length);
}
els.dispatchInput.addEventListener('input', updateCharCount);
updateCharCount();

let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!renderer.maze) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const want = renderer.computeCellPx(renderer.maze.cols);
    if (want !== renderer.cellPx) {
      renderer.cellPx = want;
      renderer._resizeCanvas();
      const cur = renderer._cellCenter(renderer.car.col, renderer.car.row);
      renderer._displayCar = { ...renderer._displayCar, x: cur.x, y: cur.y };
      renderer.render();
    }
  }, 80);
});

resetMap();

// -------- Helpers --------

let toastTimer = null;
function showToast(message, kind = 'info', ms = 3200) {
  els.toast.textContent = message;
  els.toast.className = 'toast' + (kind === 'error' ? ' error' : '');
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}
