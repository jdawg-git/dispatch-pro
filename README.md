# Dispatch Pro

A natural-language city-driving puzzle. Type a route, hit TRANSMIT, watch the driver navigate. 3 attempts per generated map.

## Run locally

```sh
cp .env.example .env       # then edit .env and add your real GEMINI_API_KEY
node api/dispatch.js
```

Open <http://localhost:8787>.

## What it does

- **Map controls**: pick a grid size (5×5 → 13×13) and a difficulty (Easy/Medium/Hard) and click **Generate New Map**. Difficulty controls how twisty the maze is, not the size.
- **TRANSMIT**: your text is sent to the Gemini proxy, which returns a list of moves. The car animates the route while the driver narrates.
- **Attempts**: 3 per map. A failed transmission shows a 📋 icon that re-fills the last text into the input. After 3 fails, the input is replaced with a "Generate New Map" prompt.

## Notes

- The Gemini API key never leaves the local proxy at `api/dispatch.js`. The browser only talks to `/api/dispatch`.
- Network or upstream errors **do not** consume an attempt — you'll see a toast and can retry. Only a parseable response that fails to reach the destination counts as a used attempt.
- No persistence in this mode: refreshing the page generates a fresh map. The last attempt's text is held in `sessionStorage` only.

## File layout

```
index.html
style.css
api/dispatch.js              Node http proxy + static file server
js/
  main.js                    bootstrap + controls wiring
  maze.js                    seeded backtracker with twistiness bias
  renderer.js                canvas drawing + step animation
  game.js                    attempt loop, success/fail/lockout
  gemini.js                  prompt build, fetch, response parse
```
