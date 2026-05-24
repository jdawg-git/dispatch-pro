// Tiny sound-effect helper. Preloads the four one-shot clips and the 17
// driver-chirp clips; exposes named plays + a random chirp.
//
// Browser autoplay policy: the first user gesture (clicking TRANSMIT) unlocks
// programmatic audio. After that every play() call works. Errors are
// swallowed so a missing file or an autoplay block never breaks the UI.

const ONE_SHOTS = {
  beepbeep: '/sfx/beepbeep.mp3',
  win:      '/sfx/win.mp3',
  lose:     '/sfx/lose.mp3',
};

const CHIRP_COUNT = 6;
const CHIRP_URLS = Array.from(
  { length: CHIRP_COUNT },
  (_, i) => `/sfx/chirps/${i + 1}.mp3`,
);

const cache = new Map();

function get(url) {
  let a = cache.get(url);
  if (!a) {
    a = new Audio(url);
    a.preload = 'auto';
    cache.set(url, a);
  }
  return a;
}

function safePlay(a) {
  try {
    a.currentTime = 0;
    const p = a.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* no-op */ }
}

// Preload every clip so the first play has zero latency.
export function preloadAll() {
  for (const url of Object.values(ONE_SHOTS)) get(url);
  for (const url of CHIRP_URLS) get(url);
}

// Play a named one-shot ("beepbeep" | "win" | "lose"). Unknown names are a no-op.
export function play(name) {
  const url = ONE_SHOTS[name];
  if (!url) return;
  safePlay(get(url));
}

// Play a random chirp from /sfx/chirps/1..17.mp3.
export function playRandomChirp() {
  const url = CHIRP_URLS[Math.floor(Math.random() * CHIRP_URLS.length)];
  safePlay(get(url));
}
