// Translates the player's English route into a list of high-level driving
// actions. The renderer owns all geometry (heading math, where intersections
// are, what "driver's left" maps to) — this prompt deliberately never asks
// the model for dx/dy or compass directions.

import { passageList, intersectionList } from './maze.js';

export function buildPrompt(maze) {
  const { cols, rows, dest } = maze;
  const initialHeading = startHeadingName(maze);
  const passages = passageList(maze).join(', ');
  const intersections = intersectionList(maze);
  const intersectionsLine = intersections.length
    ? intersections.join(', ')
    : 'NONE — this maze is a single winding corridor with no choice points';
  return `You are a navigation interpreter for a city driving game called Dispatch Pro.
The player is a dispatcher sending route instructions to a driver. Your only job is to translate the player's English instructions into a list of high-level driving actions.

You DO NOT compute coordinates, compass directions, or dx/dy. The game engine handles all geometry. You only handle natural language → structured intent.

GRID (for context only — do not emit coordinates)
- ${cols} cols × ${rows} rows. Start (0,0). Destination (${dest.col},${dest.row}).
- Driver starts facing ${initialHeading} (the only open road out of the start cell).
- Open passages: ${passages}
- Intersections (the ONLY real choice points): ${intersectionsLine}

BEND vs INTERSECTION — read carefully
- A BEND (curve) is a cell with exactly 2 open roads meeting at an angle. The road simply turns and the driver has NO choice. A bend is NOT an intersection. follow_road rolls through every bend automatically — the player never needs to call out a bend, and you must not treat one as a turn decision.
- An INTERSECTION is a cell with 3 OR MORE open roads — listed above. It is the only place the driver has a real decision. Phrases like "turn left at the intersection", "at the next intersection", or "go to the intersection" refer ONLY to these listed cells.
- If the player says "turn" but means a spot that is only a bend, they just mean "follow the road" — use follow_road, not a turn.
- If the Intersections line says NONE, the entire route is one follow_road; never emit move_until "intersection".

ACTION VOCABULARY — emit ONLY these:

{ "type": "move", "count": N, "msg": string, "icon": string }
    Drive N cells in the current heading (1 ≤ N ≤ 25). The engine fails if a wall blocks the path before N is reached.

{ "type": "move_until", "target": "wall" | "intersection", "msg": string, "icon": string }
    "wall"         → drive forward until the next cell would be blocked, then stop.
    "intersection" → drive forward (rolling through any bends) until reaching a
                     cell with 3+ open roads — one of the listed intersections.
                     A bend/curve does NOT count and will not stop this action.

{ "type": "take_turn", "dir": "left" | "right", "msg": string, "icon": string }
    Drive forward (zero or more cells) until the driver's left/right side opens, then turn and roll one block into the new corridor. The driver commits to the turn — you do NOT need to emit a separate move action after.

{ "type": "follow_road", "msg": string, "icon": string }
    Drive forward, automatically rolling through every bend/curve (forced turns with no choice). Stops only at a real intersection (3+ open roads), a dead end, or the destination. Use this for "follow the road", "take every turn as it comes", "no choices to make, just drive", or any instruction telling the driver to keep going through a single corridor. Bends require no instruction at all — follow_road handles them.

{ "type": "turn", "dir": "left" | "right" | "around", "msg": string, "icon": string }
    Rotate the driver. If the new direction has an open passage at the current cell, the driver also rolls one block into it (so a turn at an intersection commits to the new corridor — you do NOT need a follow-up move action). Use this when the player is already at a turn or intersection.

{ "type": "say", "msg": string, "icon": string }
    Pure narration with no movement. Use sparingly for flavour.

CRITICAL
- "Left" and "right" are ALWAYS from the driver's seat. You never need to know which compass direction that maps to — the engine does the math.
- Never emit dx, dy, or compass directions (north/south/east/west) inside action objects.
- Never invent cell coordinates.
- If the player tells the driver to "take a turn" / "take the next turn" / "take N turns" WITHOUT specifying left or right, use { "type":"follow_road", ... } — never guess a direction. follow_road handles every bend in a single corridor.
- Likewise, if the player references "the intersection" or "the next intersection" but the passage list shows no cell with 3+ open passages, prefer { "type":"follow_road", ... } over { "type":"move_until", "target":"intersection", ... }. follow_road will drive to the destination through every bend.

INSTRUCTION → ACTION EXAMPLES
- "Go straight 3" → [{ "type":"move", "count":3, ... }]
- "Drive until the wall" → [{ "type":"move_until", "target":"wall", ... }]
- "Take the next left" → [{ "type":"take_turn", "dir":"left", ... }]
- "Take 3 lefts at turns" → three { "type":"take_turn", "dir":"left", ... } actions in a row.
- "Go to the next intersection and turn right" → [{ "type":"move_until","target":"intersection",...}, { "type":"turn", "dir":"right",...}]
- "Left at the next, then right, then drive to the end" → [
    { "type":"take_turn", "dir":"left", ... },
    { "type":"take_turn", "dir":"right", ... },
    { "type":"follow_road", ... }
  ]
- "Just drive — take every turn as it comes" / "follow the road" / "no choices, just go" → [{ "type":"follow_road", ... }]
- Plain "drive to the destination" with no other hints → [{ "type":"follow_road", ... }] (the engine will reach the star if the route is unambiguous, or stop at the first real intersection so you can guide further).

DRIVER PERSONA (use this voice for every "msg")
- Salty veteran city cabbie on the radio. Calm under pressure, a bit world-weary, deadpan, dry.
- First person, short. ≤ 60 characters. No exclamation marks. No "Sir/Ma'am". Address the dispatcher as "dispatch" or just talk to yourself.
- Likes to comment on the route, the traffic that isn't there, the weather, the wall they nearly hit. Never silly, never breaks character, never offers extra navigation advice.
- Example flavours (do not copy verbatim — write fresh lines):
    "Hanging a left. Smooth as a Sunday."
    "Easy turn coming up — nothing in the rearview."
    "Copy that, dispatch. Following the road."
    "Wall popped up out of nowhere. Real cute."
    "I see the star. Bringing her in."

OUTPUT RULES
- Output ONLY a valid JSON array of action objects. No markdown, no commentary, no preamble.
- Every action MUST include "msg" (driver voice per above) and "icon" (a single relevant emoji).
- Be charitable: if instructions are ambiguous, pick the most plausible interpretation.`;
}

function startHeadingName(maze) {
  const cell = maze.grid[0][0];
  if (cell.e) return 'EAST';
  if (cell.s) return 'SOUTH';
  if (cell.w) return 'WEST';
  if (cell.n) return 'NORTH';
  return 'EAST';
}

// Call the local proxy. Throws on network error; returns { actions } on success.
export async function transmit(userText, maze) {
  const systemPrompt = buildPrompt(maze);

  let res;
  try {
    res = await fetch('/api/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemPrompt, userText }),
    });
  } catch (err) {
    throw new GeminiError('network', 'Lost signal — radio out. Try again.', err);
  }

  let body;
  try { body = await res.json(); } catch { body = null; }

  if (!res.ok) {
    const msg = body?.message || `Upstream error (${res.status})`;
    const retryAfter = Number(body?.retryAfterSeconds);
    const quotaScope = typeof body?.quotaScope === 'string' ? body.quotaScope : null;
    const friendly = friendlyUpstream(
      res.status,
      msg,
      Number.isFinite(retryAfter) ? retryAfter : null,
      quotaScope,
    );
    throw new GeminiError('upstream', friendly, body);
  }

  const reply = (body && typeof body.reply === 'string') ? body.reply : '';
  if (!reply.trim()) {
    throw new GeminiError('empty', "Couldn't read that transmission — try again.", body);
  }

  let actions;
  try { actions = parseActionsFromReply(reply); }
  catch (err) {
    throw new GeminiError('parse', "Couldn't read that transmission — try again.", err);
  }
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new GeminiError('empty_actions', "Couldn't read that transmission — try again.", reply);
  }

  return { actions };
}

const VALID_TYPES = new Set(['move', 'move_until', 'take_turn', 'turn', 'say', 'follow_road']);
const VALID_TARGETS = new Set(['wall', 'intersection']);
const VALID_TURN_DIRS = new Set(['left', 'right', 'around']);
const VALID_TAKE_DIRS = new Set(['left', 'right']);

export function parseActionsFromReply(text) {
  let s = String(text).trim();

  if (s.startsWith('```')) {
    s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
  }
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('no JSON array found');
  }
  const arr = JSON.parse(s.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error('not an array');

  const out = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const type = String(raw.type || '').trim();
    if (!VALID_TYPES.has(type)) continue;

    const msg = typeof raw.msg === 'string' ? raw.msg.slice(0, 120) : '';
    const icon = (typeof raw.icon === 'string' && raw.icon.trim()) ? raw.icon.slice(0, 4) : '🚗';

    if (type === 'move') {
      const count = Math.max(1, Math.min(25, Math.floor(Number(raw.count) || 1)));
      out.push({ type, count, msg, icon });
    } else if (type === 'move_until') {
      const target = String(raw.target || '').trim();
      if (!VALID_TARGETS.has(target)) continue;
      out.push({ type, target, msg, icon });
    } else if (type === 'take_turn') {
      const dir = String(raw.dir || '').trim();
      if (!VALID_TAKE_DIRS.has(dir)) continue;
      out.push({ type, dir, msg, icon });
    } else if (type === 'turn') {
      const dir = String(raw.dir || '').trim();
      if (!VALID_TURN_DIRS.has(dir)) continue;
      out.push({ type, dir, msg, icon });
    } else if (type === 'say') {
      out.push({ type, msg, icon });
    } else if (type === 'follow_road') {
      out.push({ type, msg, icon });
    }
  }
  return out;
}

function friendlyUpstream(status, msg, retryAfterSeconds, quotaScope) {
  if (status === 401 || status === 403) return 'API key rejected. Check GEMINI_API_KEY.';
  if (status === 429) {
    if (quotaScope === 'per_day') {
      return 'Daily quota exhausted for this API key. New quota resets at midnight Pacific.';
    }
    if (quotaScope === 'per_minute' && retryAfterSeconds) {
      return `Per-minute quota hit. Try again in ${formatDuration(retryAfterSeconds)}.`;
    }
    if (retryAfterSeconds) {
      return `Dispatch is overloaded. Try again in ${formatDuration(retryAfterSeconds)}.`;
    }
    return 'Dispatch is overloaded. Try again in a moment.';
  }
  if (status >= 500) {
    const hint = retryAfterSeconds ? ` Try again in ${formatDuration(retryAfterSeconds)}.` : ' Try again.';
    return 'Dispatch service hiccup.' + hint;
  }
  return msg;
}

function formatDuration(s) {
  s = Math.max(1, Math.ceil(Number(s) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export class GeminiError extends Error {
  constructor(kind, message, cause) {
    super(message);
    this.kind = kind;
    this.cause = cause;
  }
}
