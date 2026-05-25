// Tiny zero-dependency dev server + Gemini proxy.
// Run: `node api/dispatch.js`. Reads GEMINI_API_KEY from .env next to this folder.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 8787;
const GEMINI_MODEL = 'gemini-2.5-flash';

const env = loadEnv(path.join(ROOT, '.env'));
const GEMINI_API_KEY = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';

if (!GEMINI_API_KEY) {
  console.warn('[dispatch] No GEMINI_API_KEY found. Copy .env.example to .env and add your key.');
}

// DB pool — only initialised when DATABASE_URL is present.
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

if (!pool) {
  console.warn('[dispatch] No DATABASE_URL found. Stats endpoints will be disabled.');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.md':   'text/markdown; charset=utf-8',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/dispatch') {
      return await handleDispatch(req, res);
    }
    if (req.method === 'POST' && req.url === '/api/stats') {
      return await handleStatsWrite(req, res);
    }
    if (req.method === 'POST' && req.url === '/api/session') {
      return await handleSession(req, res);
    }
    if (req.method === 'GET' && req.url === '/api/stats') {
      return await handleStatsRead(req, res);
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res);
    }
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('Method not allowed');
  } catch (err) {
    console.error('[dispatch] server error:', err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal_error', message: String(err?.message || err) }));
  }
});

server.listen(PORT, () => {
  console.log(`[dispatch] http://localhost:${PORT}`);
});

// -------- Stats endpoints --------

async function handleSession(req, res) {
  if (!pool) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no_db' }));
    return;
  }
  try {
    await pool.query('INSERT INTO sessions DEFAULT VALUES');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    console.error('[stats] session insert error:', err.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'db_error' }));
  }
}

async function handleStatsWrite(req, res) {
  if (!pool) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no_db' }));
    return;
  }
  const body = await readJson(req);
  const {
    outcome, failure_reason, difficulty, grid_size,
    path_length, prompt_chars, attempts_used, beat_supervisor, actions_count,
  } = body || {};
  if (!outcome) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad_request', message: 'outcome is required' }));
    return;
  }
  try {
    await pool.query(
      `INSERT INTO game_results
         (outcome, failure_reason, difficulty, grid_size, path_length,
          prompt_chars, attempts_used, beat_supervisor, actions_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        String(outcome).slice(0, 32),
        failure_reason ? String(failure_reason).slice(0, 64) : null,
        difficulty ? String(difficulty).slice(0, 32) : null,
        grid_size ? String(grid_size).slice(0, 16) : null,
        Number.isFinite(path_length) ? path_length : null,
        Number.isFinite(prompt_chars) ? prompt_chars : null,
        Number.isFinite(attempts_used) ? attempts_used : null,
        beat_supervisor === true,
        Number.isFinite(actions_count) ? actions_count : null,
      ],
    );
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    console.error('[stats] write error:', err.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'db_error' }));
  }
}

async function handleStatsRead(req, res) {
  if (!pool) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no_db' }));
    return;
  }
  try {
    const [
      totals,
      sessionCount,
      dailyGames,
      engagementWins,
      attemptsDistribution,
      lockouts,
      beatSupervisor,
      failureReasons,
      byDifficulty,
      byGridSize,
      recentActivity,
    ] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)                                            AS total_games,
          COUNT(*) FILTER (WHERE outcome = 'win')            AS total_wins,
          COUNT(*) FILTER (WHERE outcome = 'fail')           AS total_fails,
          COUNT(*) FILTER (WHERE outcome = 'lockout')        AS total_lockouts
        FROM game_results
      `),
      pool.query('SELECT COUNT(*) AS total FROM sessions'),
      pool.query(`
        SELECT
          DATE_TRUNC('day', created_at AT TIME ZONE 'UTC')::date AS day,
          COUNT(*) AS count
        FROM game_results
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY 1
        ORDER BY 1 ASC
      `),
      pool.query(`
        SELECT
          ROUND(AVG(attempts_used), 2) AS avg_attempts_per_win
        FROM game_results
        WHERE outcome = 'win' AND attempts_used IS NOT NULL
      `),
      pool.query(`
        SELECT attempts_used, COUNT(*) AS count
        FROM game_results
        WHERE attempts_used IS NOT NULL
        GROUP BY attempts_used
        ORDER BY attempts_used ASC
      `),
      pool.query(`
        SELECT COUNT(*) AS lockout_count
        FROM game_results
        WHERE outcome = 'lockout'
      `),
      pool.query(`
        SELECT
          COUNT(*)                                           AS beat_count,
          COUNT(*) FILTER (WHERE outcome = 'win')           AS win_count
        FROM game_results
        WHERE beat_supervisor = true
      `),
      pool.query(`
        SELECT failure_reason, COUNT(*) AS count
        FROM game_results
        WHERE outcome IN ('fail', 'lockout') AND failure_reason IS NOT NULL
        GROUP BY failure_reason
        ORDER BY count DESC
      `),
      pool.query(`
        SELECT difficulty, COUNT(*) AS count
        FROM game_results
        WHERE difficulty IS NOT NULL
        GROUP BY difficulty
        ORDER BY count DESC
      `),
      pool.query(`
        SELECT grid_size, COUNT(*) AS count
        FROM game_results
        WHERE grid_size IS NOT NULL
        GROUP BY grid_size
        ORDER BY count DESC
      `),
      pool.query(`
        SELECT
          id, created_at, outcome, failure_reason, difficulty,
          grid_size, prompt_chars, attempts_used, beat_supervisor
        FROM game_results
        ORDER BY created_at DESC
        LIMIT 20
      `),
    ]);

    const t = totals.rows[0];
    const totalGames = Number(t.total_games);
    const totalWins  = Number(t.total_wins);
    const winRate    = totalGames > 0 ? Math.round((totalWins / totalGames) * 100) : 0;

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      totals: {
        games:    totalGames,
        wins:     totalWins,
        fails:    Number(t.total_fails),
        lockouts: Number(t.total_lockouts),
        winRate,
      },
      sessions:   Number(sessionCount.rows[0].total),
      dailyGames: dailyGames.rows.map(r => ({ day: r.day, count: Number(r.count) })),
      engagement: {
        avgAttemptsPerWin: engagementWins.rows[0]?.avg_attempts_per_win
          ? Number(engagementWins.rows[0].avg_attempts_per_win) : null,
        attemptsDistribution: attemptsDistribution.rows.map(r => ({
          attempts: Number(r.attempts_used),
          count: Number(r.count),
        })),
        lockoutCount: Number(lockouts.rows[0].lockout_count),
        beatSupervisorCount: Number(beatSupervisor.rows[0].beat_count),
        beatSupervisorWinCount: Number(beatSupervisor.rows[0].win_count),
      },
      failureReasons: failureReasons.rows.map(r => ({
        reason: r.failure_reason,
        count: Number(r.count),
      })),
      byDifficulty: byDifficulty.rows.map(r => ({
        difficulty: r.difficulty,
        count: Number(r.count),
      })),
      byGridSize: byGridSize.rows.map(r => ({
        gridSize: r.grid_size,
        count: Number(r.count),
      })),
      recentActivity: recentActivity.rows,
    }));
  } catch (err) {
    console.error('[stats] read error:', err.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'db_error', message: err.message }));
  }
}

// -------- Gemini proxy --------

async function handleDispatch(req, res) {
  if (!GEMINI_API_KEY) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing_key', message: 'Server is missing GEMINI_API_KEY. Copy .env.example to .env and add your key.' }));
    return;
  }
  const body = await readJson(req);
  const { systemPrompt, userText } = body || {};
  if (typeof systemPrompt !== 'string' || typeof userText !== 'string' || !userText.trim()) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad_request', message: 'systemPrompt and userText are required' }));
    return;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const payload = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0.4,
      response_mime_type: 'application/json',
      // gemini-2.5-flash enables reasoning ("thinking") by default, which adds
      // 5-15s of latency. Disable it so the player gets a snappy response;
      // the system prompt's turn table + worked examples carry the reasoning.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream_unreachable', message: String(err?.message || err) }));
    return;
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    const body = safeJson(text);
    const retryAfterSeconds = extractRetryAfterSeconds(upstream, body);
    const quotaScope = extractQuotaScope(body);
    console.error('[dispatch] gemini error', upstream.status, 'retryAfter=', retryAfterSeconds, 'quotaScope=', quotaScope, '\n', text.slice(0, 1500));
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: 'upstream_error',
      status: upstream.status,
      retryAfterSeconds,
      quotaScope,
      body,
    }));
    return;
  }

  const data = safeJson(text);
  const reply = extractReplyText(data);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ reply, raw: data }));
}

function extractReplyText(data) {
  try {
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts.map(p => p?.text || '').join('').trim();
  } catch {
    return '';
  }
}

// -------- Static file server --------

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let rel;
  if (urlPath === '/') rel = '/index.html';
  else if (urlPath === '/stats') rel = '/stats.html';
  else rel = urlPath;
  // Prevent directory traversal
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

// -------- Shared utilities --------

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error('invalid json: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return text; }
}

// Walks the QuotaFailure violations and returns 'per_minute' | 'per_day' | null
// based on which quota bucket was exhausted. Used to tell the user whether
// waiting the retryDelay will actually help (per-minute = yes, per-day = no).
function extractQuotaScope(body) {
  try {
    const details = body?.error?.details;
    if (!Array.isArray(details)) return null;
    let scope = null;
    for (const d of details) {
      const type = typeof d?.['@type'] === 'string' ? d['@type'] : '';
      if (!type.endsWith('QuotaFailure')) continue;
      const violations = Array.isArray(d.violations) ? d.violations : [];
      for (const v of violations) {
        const id = String(v?.quotaId || '');
        if (/PerDay/i.test(id)) return 'per_day'; // hard fail today — prefer this over per-minute if both present
        if (/PerMinute/i.test(id)) scope = 'per_minute';
      }
    }
    return scope;
  } catch {
    return null;
  }
}

// Extract a retry hint in seconds from an upstream error response. Prefers the
// HTTP `Retry-After` header (standard) and falls back to Gemini's structured
// RetryInfo in error.details[]. Returns null if neither is present.
function extractRetryAfterSeconds(response, body) {
  try {
    const header = response.headers.get('retry-after');
    if (header) {
      const n = Number(header);
      if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
      // Some servers send an HTTP-date; parse and diff with now.
      const t = Date.parse(header);
      if (Number.isFinite(t)) return Math.max(0, Math.ceil((t - Date.now()) / 1000));
    }
  } catch {}
  try {
    const details = body?.error?.details;
    if (Array.isArray(details)) {
      for (const d of details) {
        const type = typeof d?.['@type'] === 'string' ? d['@type'] : '';
        if (type.endsWith('RetryInfo') && typeof d.retryDelay === 'string') {
          // retryDelay is a duration string, e.g. "32s" or "1.5s".
          const m = /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay);
          if (m) return Math.max(1, Math.ceil(Number(m[1])));
        }
      }
    }
  } catch {}
  return null;
}
