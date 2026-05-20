# Dispatch Pro — Product Specification

## Overview

Dispatch Pro is a mobile-first daily web game. The player is a dispatcher who must radio a complete driving route to their driver in a single transmission. An LLM translates the natural language instructions into moves, and the driver narrates the journey in real time. The game resets every 24 hours with a new city maze, shared by all players worldwide.

---

## Core Concept

- The player sees a top-down city grid: roads, city blocks, a car at the start, and a destination marker  
- The player types route instructions in natural language into a radio dispatch input  
- On submission, the Gemini API translates those instructions into a sequence of move steps  
- The car animates through the city block by block, with the driver narrating each move  
- If the car hits a building or dead end, it returns to start  
- The player has 3 attempts per day. After 3 failures, they are locked out until midnight

---

## Game Modes

### Daily Mode (primary)

- One new maze per day, identical for all players worldwide  
- Determined by date — `DISPATCH_SEED = YYYY-MM-DD` fed into a seeded PRNG to generate the maze  
- Streak tracking persists in localStorage  
- Share card generated on completion or lockout  
- Resets at midnight local time

### Training Mode (secondary)

- 8 fixed, hand-crafted mazes, always available  
- Ordered easy to hard  
- No streak, no share card, unlimited attempts  
- Accessible from the main menu at any time  
- Intended for new players learning the mechanic

---

## Maze Generation

### Algorithm

Use a seeded recursive backtracker to guarantee every maze is solvable. The seed for the daily maze is derived from the current date string (`YYYY-MM-DD`). The same seed always produces the same maze.

function seededRandom(seed) — a simple deterministic PRNG (e.g. mulberry32)

function generateMaze(cols, rows, seed) — recursive backtracker using seededRandom

Every cell tracks open passages in four directions (N, S, E, W). The result is a perfect maze: every cell is reachable, exactly one path exists between any two cells, no loops.

### Grid Sizes by Difficulty

| Day of Week | Grid Size | Approx. Complexity |
| :---- | :---- | :---- |
| Monday | 7×7 | Easy |
| Tuesday | 8×8 | Easy-Medium |
| Wednesday | 9×9 | Medium |
| Thursday | 9×9 | Medium |
| Friday | 10×10 | Medium-Hard |
| Saturday | 11×11 | Hard |
| Sunday | 11×11 | Hard |

Training mazes are hand-defined as static cell passage arrays (not generated).

### Start and End

- Start: always top-left cell (0,0)  
- Destination: always bottom-right cell (cols-1, rows-1)

---

## Rendering — Canvas (HTML5)

All rendering is done on an HTML5 Canvas element. No external image assets in v1.

### Cell Types

| Type | Visual |
| :---- | :---- |
| Road (passable) | Dark asphalt fill (\#2a2a2a light: \#d6d3cc) with sidewalk border and dashed centre line |
| City block (wall) | Building with coloured facade, window grid, and roofline |
| Start cell | Road tile with a subtle blue highlight border and "START" label |
| Destination cell | Green-tinted cell with a ★ and "DEST" label |

### Road Drawing Details

- Each road cell has a thin sidewalk band on all edges (4px inset)  
- Dashed lane markings drawn between adjacent road cells  
- Intersections (road cell with road on all 4 sides) get a plain road fill — no dashes

### Building Drawing Details

- Building fills the cell minus a small sidewalk margin  
- Facade colour varies by block position (use position hash to pick from a palette of 4–5 muted colours)  
- Window grid: evenly spaced small rectangles, lit or dark randomly per building (seeded by position)  
- Roofline: a darker band across the top of the facade

### Car Drawing Details

- Drawn with Canvas shapes — no external sprite  
- Top-down rectangle body with rounded corners  
- Windshield rectangle (lighter fill)  
- Four small wheel rectangles at corners  
- Headlights (front) and tail lights (rear, red)  
- Car rotates to face its direction of travel  
- Colour: blue (\#2563eb body, \#1d4ed8 roof)  
- Size: approximately 60% of cell width

### Canvas Sizing

- Cell size: 48px on mobile, 56px on desktop (detect via viewport width)  
- Canvas sized to `cols × cellSize` by `rows × cellSize`  
- Canvas is horizontally centred in viewport  
- On mobile, if the maze is wider than the viewport, allow horizontal scroll on the canvas wrapper

---

## Instruction Input UI

### Layout (mobile-first)

┌─────────────────────────────────────┐

│  DISPATCH PRO          Day 47 🔥 3  │  ← header: title, day number, streak

├─────────────────────────────────────┤

│                                     │

│         \[city grid canvas\]          │

│                                     │

├─────────────────────────────────────┤

│  ● ● ●  Attempt 1 of 3             │  ← attempt indicator

├─────────────────────────────────────┤

│  📻 Dispatch                        │

│  ┌───────────────────────────────┐  │

│  │ Type your route here…         │  │

│  └───────────────────────────────┘  │

│  \[        TRANSMIT        \]         │  ← disappears after submit

└─────────────────────────────────────┘

### Attempt Indicator

- 3 dots/slots shown horizontally  
- Empty slot: unfilled circle  
- Failed attempt: ❌ or red filled dot  
- Current attempt: pulsing or highlighted  
- Successful attempt: ✅ or green filled dot

### Transmit Button

- Large, full-width, labelled "TRANSMIT" with a 📻 icon  
- After the player taps Transmit, the button disappears for the duration of that attempt  
- If the attempt fails, the button reappears for the next attempt (with paste icon — see below)  
- On the third failure, the button is replaced with the lockout state

### Paste Last Instructions

- On failure (attempt 2 or 3), a small paste icon (📋) appears above the textarea  
- Tapping it restores the previous attempt's text into the textarea  
- This saves the player from retyping and encourages iteration

### Transmission Animation

- When TRANSMIT is tapped, show a brief animation before the car starts moving  
- Suggested: a radio wave ripple emanating from the dispatch box toward the car, lasting \~0.8s  
- After animation completes, car begins moving

---

## LLM Integration — Gemini API

### API

- Provider: Google Gemini  
- Model: `gemini-2.0-flash` (or latest stable equivalent)  
- Called client-side via the Gemini REST API  
- API key stored in a `.env` file as `GEMINI_API_KEY` and injected at build time (not exposed in client bundle in production — use a lightweight proxy or environment variable approach appropriate to the hosting setup)

### System Prompt

The system prompt sent with every request:

You are a navigation interpreter for a city driving game called Dispatch Pro.

The player is a dispatcher sending route instructions to a driver navigating a city grid.

Your job is to convert the player's natural language instructions into a precise sequence of moves.

GRID INFO:

\- Grid is {cols} columns × {rows} rows

\- Coordinates are (col, row), with (0,0) at top-left

\- Right \= \+col, Left \= −col, Down \= \+row, Up \= −row

\- Start: (0,0). Destination: ({cols-1},{rows-1})

\- Passages (open roads): {passage list}

RULES:

\- Output ONLY a valid JSON array. No markdown, no explanation, no preamble.

\- Each element: { "dx": number, "dy": number, "msg": string, "icon": string }

  \- dx/dy: movement delta, one cell at a time (max ±1 per step)

  \- msg: what the driver says, first person, max 60 characters, with personality

  \- icon: a single relevant emoji

\- "Go right 3" \= three steps with dx:1, dy:0

\- "Until the wall" or "until you can't" \= repeat up to 20 steps in that direction

\- "Keep going in each direction until a wall" \= apply that rule to every subsequent direction

\- Be charitable. If instructions are ambiguous, pick the most plausible interpretation.

\- The driver has a calm, professional radio-operator personality with occasional dry humour.

\- When approaching the destination, the driver should acknowledge seeing it.

### Passage List Format

Describe open passages compactly for the prompt:

(0,0)→E, (0,0)→S, (1,0)→W, (1,0)→S, ...

This tells the model exactly which moves are legal without listing walls.

### Response Parsing

- Strip any markdown fences (`json ...` ) before parsing  
- Extract the first `[...]` array found in the response  
- Validate that each step has dx, dy (numbers), msg (string), icon (string)  
- If parsing fails, surface an error to the player: "Couldn't read that transmission — try again"

### Complex Instruction Support

The system prompt explicitly handles:

- Persistent rules: "keep going until a wall" applies to all subsequent directions  
- Conditional logic: "if you hit a wall, turn right"  
- Relative directions: "turn left" interpreted relative to current heading  
- Distance phrases: "a bit", "a few blocks" → 2–3 steps  
- Landmark references: "go until the intersection" → move until a cell with 3+ open passages

---

## Driver Narration

The driver speaks after each move step. Messages come from the LLM response (`msg` field).

### Tone Guidelines (included in system prompt)

- Calm and professional, like a real radio operator  
- Occasional dry humour, never silly  
- Notices landmarks: "Passing a big intersection here…"  
- Reacts to walls: "Copy that — wall ahead, stopping."  
- Reacts to failure: "Had to abort the route, dispatch. Returning to base." (never rude or frustrated beyond mild professionalism)  
- Reacts to success: "Destination reached. Good navigation, dispatch."

### Narration Display

- Messages appear in a scrollable log above the input area  
- Each entry shows: icon \+ driver message  
- Auto-scrolls to latest message  
- Log clears on new attempt

---

## Attempt & Lockout Logic

maxAttempts \= 3

attemptsUsed \= loaded from localStorage keyed by today's date

On TRANSMIT:

  attemptsUsed++

  save to localStorage

  run the route

  if success → show success state, generate share card

  if fail and attemptsUsed \< 3 → show failure state, enable next attempt

  if fail and attemptsUsed \=== 3 → show lockout state

On page load:

  if today's date has attemptsUsed \=== 3 and no success → show lockout state

  if today's date has success → show already-solved state

---

## State & Persistence (localStorage)

All state is stored in localStorage. Keys:

| Key | Value | Description |
| :---- | :---- | :---- |
| `dp_daily_{YYYY-MM-DD}` | `{ attempts: number, solved: bool, shareText: string }` | Per-day state |
| `dp_streak` | `number` | Current daily streak |
| `dp_streak_last` | `"YYYY-MM-DD"` | Last date streak was updated |
| `dp_training_{n}` | `{ solved: bool }` | Training maze completion (0–7) |

Streak logic: if `dp_streak_last` is yesterday, increment streak. If it is today, no change. If it is older, reset to 1\.

---

## Share Card

Generated on completion (win or 3-attempt lockout). Copyable text string.

### Format

Dispatch Pro \#47 🏆          ← solved first attempt

Dispatch Pro \#47 ❌🏆        ← solved second attempt

Dispatch Pro \#47 ❌❌🏆      ← solved third attempt

Dispatch Pro \#47 ❌❌❌       ← failed all three

- `#47` is the sequential day number since launch (Day 1 \= launch date, hardcoded)  
- A "Copy result" button copies the text to clipboard  
- Optional: append streak to share text — e.g. `🔥 5 day streak`

---

## Progression & Achievements

No hard gates. All content is always accessible. Achievements are cosmetic recognition only.

### Rank Titles (based on total daily mazes solved)

| Solves | Rank |
| :---- | :---- |
| 0 | Rookie Dispatcher |
| 5 | Junior Dispatcher |
| 15 | Dispatcher |
| 30 | Senior Dispatcher |
| 60 | Lead Dispatcher |
| 100 | Dispatch Pro |

Rank shown in the header or profile area.

### Achievements (examples)

| Achievement | Trigger |
| :---- | :---- |
| First Transmission | Solve your first daily maze |
| One-Call Wonder | Solve a daily maze on the first attempt |
| Flawless Week | Solve 7 daily mazes in a row on first attempt |
| 🔥 On Fire | 7-day streak |
| 🔥🔥 Unstoppable | 30-day streak |
| Wordsmith | Solve a maze with a prompt under 10 words |
| Veteran | 100 total daily solves |

Achievements stored in localStorage. A subtle toast notification appears when one is unlocked.

---

## Screens & Navigation

### Screen Flow

Launch

  → if first visit: Training Mode intro

  → else: Daily Mode (today's maze)

Main nav (bottom tab bar on mobile):

  📍 Daily     — today's maze

  🎓 Training  — 8 practice mazes

  🏆 Stats     — streak, rank, achievements

### Daily Mode Screen

- Header: "Dispatch Pro" \+ day number \+ streak flame \+ streak count  
- City grid canvas  
- Attempt indicator  
- Driver log  
- Dispatch input \+ TRANSMIT button  
- Post-solve: share card \+ "Come back tomorrow" message

### Training Mode Screen

- List of 8 mazes with labels: "Training 1 — Straight Shot", "Training 2 — First Turn", etc.  
- Checkmark on completed mazes  
- Tap to play; unlimited attempts, no share card

### Stats Screen

- Current rank \+ title  
- Streak display  
- Total solves  
- Achievement grid (locked achievements shown as silhouettes)

---

## Technical Stack

| Concern | Choice |
| :---- | :---- |
| Framework | Vanilla HTML/CSS/JS — no framework |
| Rendering | HTML5 Canvas |
| LLM | Google Gemini API (`gemini-2.0-flash`) |
| State | localStorage |
| Hosting | Static file hosting (Netlify, Vercel, or GitHub Pages) |
| Build | None required for v1 — single HTML file or simple file structure |
| API key | Environment variable injected at build, or thin serverless proxy function to avoid client exposure |

---

## File Structure

dispatch-pro/

├── index.html

├── style.css

├── js/

│   ├── main.js          — app init, screen routing

│   ├── maze.js          — maze generation (seeded backtracker)

│   ├── renderer.js      — canvas drawing (grid, car, animations)

│   ├── game.js          — attempt logic, state management

│   ├── gemini.js        — Gemini API call, prompt construction, response parsing

│   ├── share.js         — share card generation

│   ├── storage.js       — localStorage read/write helpers

│   └── training.js      — hardcoded training maze definitions

├── api/

│   └── dispatch.js      — optional serverless proxy for Gemini API key

└── .env                 — GEMINI\_API\_KEY (not committed)

---

## Training Mazes (Hand-Crafted)

8 mazes defined as static passage arrays. Suggested progression:

| \# | Name | Grid | Teaches |
| :---- | :---- | :---- | :---- |
| 1 | Straight Shot | 5×5 | Single direction |
| 2 | First Turn | 5×5 | One turn |
| 3 | The L | 6×6 | Two turns |
| 4 | Zigzag | 7×7 | Multiple turns |
| 5 | Until the Wall | 7×7 | "Keep going" instruction |
| 6 | The Long Way Round | 8×8 | Route planning |
| 7 | Rush Hour | 9×9 | Complex multi-step route |
| 8 | Night Shift | 9×9 | Full difficulty warm-up |

---

## Out of Scope (v1)

- User accounts or server-side state  
- Leaderboards  
- Multiplayer or shared prompts  
- Kenney tileset integration (planned v2 visual upgrade)  
- Sound effects  
- Accessibility beyond semantic HTML (planned post-launch)  
- Dark mode (planned post-launch)

