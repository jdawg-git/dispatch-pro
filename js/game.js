// Attempt loop, success/fail/lockout, driver display, transmission ripple.

import { transmit, GeminiError } from './gemini.js';
import { play as playSfx, playRandomChirp, preloadAll as preloadSfx } from './audio.js';
import { recordGame } from './stats.js';

const MAX_ATTEMPTS = 3;

export function createGame({ renderer, els, showToast }) {
  const state = {
    maze: null,
    attemptsUsed: 0,
    lockedOut: false,
    solved: false,
    inFlight: false,
    generation: 0,
    lastPromptChars: 0,
    lastActions: null,
    lastActionsSource: null, // 'transmit' | 'reveal'
    // Set right after the beep so the first driver line of a route doesn't
    // double-up the horn with a chirp. Cleared after the first chirp-eligible
    // message fires.
    suppressNextChirp: false,
    // 'play'   — TRANSMIT sends the textarea through Gemini (normal flow).
    // 'reveal' — TRANSMIT is repurposed as "Watch the solution"; plays canned
    //            actions from maze.solution.actions, bypassing Gemini entirely.
    mode: 'play',
  };

  // Preload the SFX so the first beep/chirp plays with zero latency.
  preloadSfx();

  // -------- DOM event wiring --------
  els.transmitBtn.addEventListener('click', onPrimaryClick);
  els.dispatchInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      onPrimaryClick();
    }
  });
  els.inspectBtn.addEventListener('click', openInspectModal);
  els.actionsModal.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.hasAttribute('data-close')) {
      closeInspectModal();
    }
  });
  els.hintBtn.addEventListener('click', openHintModal);
  els.hintModal.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.hasAttribute('data-close')) {
      closeHintModal();
    }
  });
  els.hintNoBtn.addEventListener('click', closeHintModal);
  els.hintYesBtn.addEventListener('click', () => {
    const english = state.maze?.solution?.english;
    if (english) {
      els.dispatchInput.value = english;
      els.dispatchInput.dispatchEvent(new Event('input'));
    }
    closeHintModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.actionsModal.hidden) closeInspectModal();
    if (e.key === 'Escape' && !els.hintModal.hidden) closeHintModal();
  });

  function onPrimaryClick() {
    if (state.mode === 'reveal') return onWatch();
    if (state.mode === 'replay') return onReplay();
    return onTransmit();
  }

  function openInspectModal() {
    els.actionsModalBody.innerHTML = renderActionList(state.lastActions, state.lastActionsSource);
    els.actionsModal.hidden = false;
    // Move focus to the close button so Esc / Tab feel right.
    const closeBtn = els.actionsModal.querySelector('.modal-close');
    closeBtn?.focus();
  }
  function closeInspectModal() {
    els.actionsModal.hidden = true;
    els.inspectBtn.focus();
  }

  function openHintModal() {
    els.hintModal.hidden = false;
    els.hintNoBtn.focus();
  }
  function closeHintModal() {
    els.hintModal.hidden = true;
    els.hintBtn.focus();
  }

  return { reset };

  // -------- Reset on new map --------
  function reset(maze) {
    state.generation += 1;
    state.maze = maze;
    state.attemptsUsed = 0;
    state.lockedOut = false;
    state.solved = false;
    state.inFlight = false;
    state.lastPromptChars = 0;
    state.lastActions = null;
    state.lastActionsSource = null;
    state.suppressNextChirp = false;
    state.mode = 'play';
    clearLog();
    els.dispatchInput.value = '';
    els.dispatchInput.readOnly = false;
    els.dispatchInput.classList.remove('readonly');
    els.dispatchInput.dispatchEvent(new Event('input'));
    els.dispatchInput.disabled = false;
    els.dispatchModeTag.hidden = true;
    els.dispatchModeTag.textContent = 'SOLUTION';
    els.btnLabel.textContent = '📻 TRANSMIT';
    els.lockoutBlock.classList.remove('banner');
    // Supervisor tip refreshes per map.
    const canned = maze?.solution?.english?.length ?? 0;
    if (canned > 0) {
      els.supervisorTip.textContent =
        `The Dispatch Supervisor did this route in ${canned} characters. Can you beat that?`;
      els.supervisorTip.hidden = false;
    } else {
      els.supervisorTip.hidden = true;
    }
    showPlayLayout();
    setSpinner(false);
    setTransmitDisabled(false);
    setControlsDisabled(false);
    renderAttemptDots();
  }

  // -------- TRANSMIT --------
  async function onTransmit() {
    if (state.inFlight || state.lockedOut || state.solved) return;
    const userText = els.dispatchInput.value.trim();
    if (!userText) {
      showToast('Type a route first.', 'error', 2000);
      els.dispatchInput.focus();
      return;
    }

    // Token-based cancellation: if reset() runs while we're awaiting, the
    // generation changes and we bail without mutating new-map state.
    const generation = state.generation;
    // Capture the prompt length so we can show it in the success label.
    state.lastPromptChars = userText.length;
    state.inFlight = true;
    setControlsDisabled(true);
    setTransmitDisabled(true);
    setSpinner(true);
    clearLog();

    let result;
    try {
      const { actions } = await transmit(userText, state.maze);
      if (state.generation !== generation) return;
      // Remember the parsed action list so the inspect modal can show it.
      state.lastActions = actions;
      state.lastActionsSource = 'transmit';
      setSpinner(false);

      // Radio-wave ripple before the car starts moving.
      await playRipple();
      if (state.generation !== generation) return;

      // Car is rolling — give it a horn. Suppress the chirp on the first
      // driver line so the beep gets the spotlight.
      playSfx('beepbeep');
      state.suppressNextChirp = true;

      // Run the route. setDriverMessage replaces the previous line each step.
      result = await renderer.animateActions(actions, setDriverMessage);
      if (state.generation !== generation) return;
    } catch (err) {
      if (state.generation !== generation) return;
      setSpinner(false);
      handleTransmitError(err);
      state.inFlight = false;
      setControlsDisabled(false);
      setTransmitDisabled(false);
      return;
    }

    if (result.aborted) return;

    // Animation finished. Count this as an attempt and process outcome.
    state.attemptsUsed += 1;
    state.inFlight = false;
    setControlsDisabled(false);

    if (result.success) {
      onSuccess();
    } else if (state.attemptsUsed >= MAX_ATTEMPTS) {
      onLockout(result);
    } else {
      onFailRetry(result);
    }
    renderAttemptDots();
  }

  // Maps the renderer's result object to a short human reason for the
  // attempt-failed line. The renderer flags ranRed for red-light fails and
  // sets hitWallAt for wall hits; everything else (incomplete route) means
  // the action list ran out before reaching DEST.
  function failReason(result) {
    if (result?.ranRed) return 'ran a red light';
    if (result?.hitWallAt) return 'hit a wall';
    return 'incomplete route';
  }

  function handleTransmitError(err) {
    if (err instanceof GeminiError) {
      showToast(err.message, 'error');
    } else {
      console.error('[transmit] unexpected error:', err);
      showToast('Something went wrong. Try again.', 'error');
    }
  }

  // -------- Outcomes --------
  function statBase() {
    return {
      difficulty: els.difficulty.value || null,
      grid_size:  state.maze ? `${state.maze.cols}×${state.maze.rows}` : null,
      path_length:   state.maze?.dest?.distance ?? null,
      prompt_chars:  state.lastPromptChars || null,
      attempts_used: state.attemptsUsed,
      actions_count: state.lastActions?.length ?? null,
    };
  }

  function onSuccess() {
    state.solved = true;
    state.mode = 'replay';
    playSfx('win');

    const canned = state.maze?.solution?.english?.length ?? Infinity;
    const beat = state.lastPromptChars > 0 && state.lastPromptChars < canned;
    recordGame({ ...statBase(), outcome: 'win', beat_supervisor: beat });
    if (beat) {
      fireConfetti();
      const diff = canned - state.lastPromptChars;
      setDriverMessage({
        icon: '🎉',
        msg: `Beat the supervisor by ${diff} character${diff === 1 ? '' : 's'}. Showstopper, dispatch.`,
        kind: 'win',
      });
    } else {
      setDriverMessage({
        icon: '🏁',
        msg: 'Destination reached. Good navigation, dispatch.',
        kind: 'win',
      });
    }

    // Repurpose the dispatch block for replay (mirrors the reveal flow).
    els.dispatchInput.readOnly = true;
    els.dispatchInput.classList.add('readonly');
    els.btnLabel.textContent = '▶ Replay your route';
    els.dispatchModeTag.textContent = 'WIN';
    els.dispatchModeTag.hidden = false;
    els.supervisorTip.hidden = true;
    els.transmitBtn.disabled = false;
    // Same layout as reveal — dispatch visible, lockout hidden.
    showRevealLayout();
  }

  // Two angled confetti bursts. Optional-chains the call so a CDN failure
  // (no global `confetti`) silently no-ops without breaking the win flow.
  function fireConfetti() {
    const cf = window.confetti;
    if (typeof cf !== 'function') return;
    cf({ particleCount: 90, spread: 70, angle: 60,  origin: { x: 0, y: 0.95 } });
    cf({ particleCount: 90, spread: 70, angle: 120, origin: { x: 1, y: 0.95 } });
  }

  function onFailRetry(result) {
    playSfx('lose');
    const reason = failReason(result);
    recordGame({ ...statBase(), outcome: 'fail', failure_reason: reason, beat_supervisor: false });
    setDriverMessage({
      icon: '📻',
      msg: `Attempt ${state.attemptsUsed} failed — ${reason}. Try again, dispatch.`,
      kind: 'fail',
    });
    setTransmitDisabled(true);
    appendTryAgain();
  }

  function appendTryAgain() {
    const row = document.createElement('div');
    row.className = 'log-action';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary';
    btn.textContent = '↺ Try Again';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const gen = state.generation;
      await renderer.resetCar();
      if (state.generation !== gen) return;
      row.remove();
      setTransmitDisabled(false);
      els.dispatchInput.focus();
    });
    row.append(btn);
    els.log.append(row);
  }

  function onLockout(result) {
    state.lockedOut = true;
    state.mode = 'reveal';
    playSfx('lose');
    const reason = failReason(result);
    recordGame({ ...statBase(), outcome: 'lockout', failure_reason: reason, beat_supervisor: false });
    setDriverMessage({
      icon: '📡',
      msg: `Out of attempts — ${reason} on the last one. Here is the route the dispatcher had in mind.`,
      kind: 'fail',
    });

    // Fill dispatch with the canonical English solution and lock the textarea.
    const english = state.maze?.solution?.english || '';
    els.dispatchInput.value = english;
    els.dispatchInput.readOnly = true;
    els.dispatchInput.classList.add('readonly');
    els.dispatchInput.dispatchEvent(new Event('input'));

    // Repurpose the TRANSMIT button in place.
    els.btnLabel.textContent = '▶ Watch the solution';
    els.transmitBtn.disabled = false;
    els.dispatchModeTag.textContent = 'SOLUTION';
    els.dispatchModeTag.hidden = false;
    els.supervisorTip.hidden = true; // player is now looking at the supervisor's prompt
    showRevealLayout();
  }

  async function onWatch() {
    if (state.inFlight) return;
    if (!state.maze?.solution?.actions?.length) {
      showToast('No solution available for this map.', 'error');
      return;
    }
    const generation = state.generation;
    state.lastActions = state.maze.solution.actions;
    state.lastActionsSource = 'reveal';
    state.inFlight = true;
    setTransmitDisabled(true);
    els.btnLabel.textContent = '▶ Watching…';
    clearLog();

    try {
      // Reset car to start if it isn't already there.
      if (renderer.car.col !== 0 || renderer.car.row !== 0) {
        await renderer.resetCar();
        if (state.generation !== generation) return;
      }
      await playRipple();
      if (state.generation !== generation) return;
      playSfx('beepbeep');
      state.suppressNextChirp = true;
      const result = await renderer.animateActions(state.maze.solution.actions, setDriverMessage);
      if (state.generation !== generation) return;
      // Final flourish — replace the last action's msg with a confirmation.
      if (result.success) playSfx('win');
      setDriverMessage({ icon: '🏁', msg: 'Destination reached. That was the route.', kind: 'win' });
    } catch (err) {
      if (state.generation !== generation) return;
      console.error('[watch] unexpected error:', err);
      showToast('Something went wrong watching the solution.', 'error');
    } finally {
      if (state.generation === generation) {
        state.inFlight = false;
        setTransmitDisabled(false);
        els.btnLabel.textContent = '▶ Watch the solution';
      }
    }
  }

  // Replay the player's last successful action list. Mirrors onWatch but reads
  // from state.lastActions instead of the canned solution, and does NOT touch
  // attempts / solved state — purely cosmetic playback.
  async function onReplay() {
    if (state.inFlight) return;
    if (!state.lastActions?.length) {
      showToast('No route to replay yet.', 'error');
      return;
    }
    const generation = state.generation;
    state.inFlight = true;
    setTransmitDisabled(true);
    els.btnLabel.textContent = '▶ Replaying…';
    clearLog();

    try {
      if (renderer.car.col !== 0 || renderer.car.row !== 0) {
        await renderer.resetCar();
        if (state.generation !== generation) return;
      }
      await playRipple();
      if (state.generation !== generation) return;
      playSfx('beepbeep');
      state.suppressNextChirp = true;
      const result = await renderer.animateActions(state.lastActions, setDriverMessage);
      if (state.generation !== generation) return;
      if (result.success) playSfx('win');
      setDriverMessage({ icon: '🏁', msg: 'Destination reached. That was your route.', kind: 'win' });
    } catch (err) {
      if (state.generation !== generation) return;
      console.error('[replay] unexpected error:', err);
      showToast('Something went wrong replaying the route.', 'error');
    } finally {
      if (state.generation === generation) {
        state.inFlight = false;
        setTransmitDisabled(false);
        els.btnLabel.textContent = '▶ Replay your route';
      }
    }
  }

  // -------- UI helpers --------
  function renderAttemptDots() {
    // Mark used attempts. Successful attempt = win on the last used dot. Otherwise fail.
    for (let i = 0; i < els.attemptDots.length; i++) {
      const dot = els.attemptDots[i];
      dot.classList.remove('current', 'fail', 'win');
      if (i < state.attemptsUsed - (state.solved ? 1 : 0)) {
        dot.classList.add('fail');
      }
    }
    if (state.solved) {
      const idx = Math.max(0, state.attemptsUsed - 1);
      els.attemptDots[idx].classList.remove('fail');
      els.attemptDots[idx].classList.add('win');
    } else if (!state.lockedOut && state.attemptsUsed < MAX_ATTEMPTS) {
      els.attemptDots[state.attemptsUsed].classList.add('current');
    }
    const remaining = MAX_ATTEMPTS - state.attemptsUsed;
    if (state.solved) {
      els.attemptLabel.textContent = `Solved in ${state.attemptsUsed} of ${MAX_ATTEMPTS} using a ${state.lastPromptChars} character prompt.`;
    } else if (state.lockedOut) {
      els.attemptLabel.textContent = `Out of attempts`;
    } else {
      els.attemptLabel.textContent = `Attempt ${state.attemptsUsed + 1} of ${MAX_ATTEMPTS}`;
    }
  }

  // Layout helpers. The dispatch block always stays visible during play and
  // reveal modes; only the lockout block toggles, and in reveal mode both are
  // shown together (lockout becomes a slim banner above dispatch).
  function showPlayLayout() {
    els.dispatchBlock.hidden = false;
    els.lockoutBlock.hidden = true;
  }
  function showWinLayout() {
    els.dispatchBlock.hidden = true;
    els.lockoutBlock.hidden = false;
  }
  function showRevealLayout() {
    els.dispatchBlock.hidden = false;
    els.lockoutBlock.hidden = true;
  }

  function setSpinner(on) {
    els.spinner.hidden = !on;
    els.btnLabel.textContent = on ? 'Transmitting…' : '📻 TRANSMIT';
  }

  function setTransmitDisabled(disabled) {
    els.transmitBtn.disabled = !!disabled;
  }

  function setControlsDisabled(disabled) {
    // Grid/difficulty are locked during a transmission so the maze cannot change
    // mid-route, but "Generate New Map" stays enabled so the player can bail out.
    els.gridSize.disabled = !!disabled;
    els.difficulty.disabled = !!disabled;
    els.dispatchInput.disabled = !!disabled;
  }

  function clearLog() {
    els.log.replaceChildren();
  }

  // Replaces the current driver line. Try-Again button (if present) is left
  // untouched so it stays visible across messages. Plays a random chirp for
  // regular narration (skipped on the first message of a route so the beep
  // gets clean air, and skipped on win/fail summary lines so the win.mp3 /
  // lose.mp3 plays cleanly). Every message triggers a subtle panel shake.
  function setDriverMessage({ icon, msg, kind }) {
    els.log.querySelector('.log-entry')?.remove();
    const entry = document.createElement('div');
    entry.className = 'log-entry' + (kind ? ` ${kind}` : '');
    const iEl = document.createElement('span');
    iEl.className = 'icon';
    iEl.textContent = icon || '🚗';
    const mEl = document.createElement('span');
    mEl.className = 'msg';
    mEl.textContent = msg || '';
    entry.append(iEl, mEl);
    const action = els.log.querySelector('.log-action');
    if (action) els.log.insertBefore(entry, action);
    else els.log.append(entry);

    // Subtle shake every time a new message lands. Toggling the class with a
    // forced reflow restarts the keyframe so rapid-fire messages keep shaking.
    els.log.classList.remove('msg-bump');
    void els.log.offsetWidth;
    els.log.classList.add('msg-bump');

    if (kind !== 'win' && kind !== 'fail') {
      if (state.suppressNextChirp) {
        state.suppressNextChirp = false;
      } else {
        playRandomChirp();
      }
    }
  }

  function renderActionList(actions, source) {
    if (!actions || !actions.length) {
      return '<p class="muted">No transmission yet. Send a route and the parsed instructions will appear here.</p>';
    }
    const heading = source === 'reveal'
      ? '<p class="muted">The canned solution actions for this map.</p>'
      : '<p class="muted">What your last dispatch was parsed into.</p>';
    const rows = actions.map((a, i) => {
      const num = `<span class="num">${i + 1}.</span>`;
      const icon = `<span class="icon">${escapeHtml(a.icon || '🚗')}</span>`;
      const lines = [];
      if (a.source) {
        lines.push(`<span class="source">You said: &ldquo;${escapeHtml(a.source)}&rdquo;</span>`);
      }
      lines.push(`<span class="type">Parsed to: <code>${escapeHtml(formatActionType(a))}</code></span>`);
      if (a.msg) {
        lines.push(`<span class="msg">Driver Response: &ldquo;${escapeHtml(a.msg)}&rdquo;</span>`);
      }
      return `<li>${num}${icon}<div class="action-body">${lines.join('')}</div></li>`;
    }).join('');
    return heading + `<ol class="action-list">${rows}</ol>`;
  }

  function formatActionType(a) {
    switch (a.type) {
      case 'move':        return `move ${a.count}`;
      case 'move_until':  return `move_until ${a.target}`;
      case 'take_turn':   return `take_turn ${a.dir}`;
      case 'turn':        return `turn ${a.dir}`;
      case 'follow_road': return 'follow_road';
      case 'wait_for_green': return 'wait_for_green';
      case 'wait':        return 'wait';
      case 'say':         return 'say';
      default:            return a.type;
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function playRipple() {
    return new Promise((resolve) => {
      const r = els.ripple;
      // Restart the CSS animation by toggling hidden.
      r.hidden = true;
      // Force reflow.
      void r.offsetHeight;
      r.hidden = false;
      const t = setTimeout(() => { r.hidden = true; resolve(); }, 820);
      // Failsafe if hidden was changed mid-flight.
      r.addEventListener('animationend', () => { clearTimeout(t); r.hidden = true; resolve(); }, { once: true });
    });
  }
}
