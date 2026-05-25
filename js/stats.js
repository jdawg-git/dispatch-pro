// Silent stats reporter — fire-and-forget POST to /api/stats and /api/session.
// Errors are swallowed so tracking never interrupts gameplay.

export function recordSession() {
  fetch('/api/session', { method: 'POST' }).catch(() => {});
}

export function recordGame(data) {
  fetch('/api/stats', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  }).catch(() => {});
}
