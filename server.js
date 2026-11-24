import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './lib/store.js';
import { createAuth } from './lib/auth.js';
import { createAkahuClient, normaliseTransaction } from './lib/akahu.js';
import { DEFAULTS, nzDate, periodFor, summarise } from './lib/budget.js';
import { demoData } from './lib/demo.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const env = process.env;
const DEMO = env.DEMO === '1' || !env.AKAHU_USER_TOKEN;
const PRODUCTION = env.PRODUCTION === '1';
const CACHE_MS = 10 * 60 * 1000;

const store = createStore(env.DATA_DIR || join(ROOT, 'data'));
const auth = createAuth(store, { secureCookies: PRODUCTION });
const akahu = DEMO ? null : createAkahuClient({ appToken: env.AKAHU_APP_TOKEN, userToken: env.AKAHU_USER_TOKEN });

if (Object.keys(store.data.users).length === 0) {
  console.warn('No users yet. Create one with: npm run add-user');
}
if (DEMO) console.warn('Running in DEMO mode on sample data. Set AKAHU_APP_TOKEN and AKAHU_USER_TOKEN to connect real accounts.');

// ---- data loading with an in-memory cache --------------------------------

let cache = null;
let inflight = null;

async function loadData(force) {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const settings = { ...DEFAULTS, ...store.data.settings };
    const today = nzDate();
    if (DEMO) {
      cache = { ...demoData(today, settings.monthStartDay), fetchedAt: Date.now() };
      return cache;
    }
    if (force) await akahu.refresh();
    // Fetch the current period plus three previous ones for recurring-charge detection.
    const from = periodFor(today, settings.monthStartDay, -3).start;
    const startISO = new Date(Date.parse(from) - 86_400_000).toISOString();
    const [accounts, posted, pending] = await Promise.all([
      akahu.getAccounts(),
      akahu.getTransactions(startISO, new Date().toISOString()),
      akahu.getPending().catch(() => []),
    ]);
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const transactions = [
      ...posted.map((t) => normaliseTransaction(t, byId, false)),
      ...pending.map((t) => normaliseTransaction(t, byId, true)),
    ];
    cache = { accounts, transactions, fetchedAt: Date.now() };
    return cache;
  })();
  try { return await inflight; } finally { inflight = null; }
}

function buildSummary(data) {
  return summarise({
    accounts: data.accounts,
    transactions: data.transactions,
    settings: store.data.settings,
    fetchedAt: new Date(data.fetchedAt).toISOString(),
    demo: DEMO,
  });
}

// ---- http helpers ---------------------------------------------------------

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  ...(PRODUCTION ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    throw Object.assign(new Error('Expected JSON'), { status: 415 });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function clientIp(req) {
  if (env.TRUST_PROXY === '1') {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon',
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  try {
    const body = await readFile(file);
    return send(res, 200, body, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  } catch {
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  }
}

// ---- routes ---------------------------------------------------------------

const MODES = new Set(['include', 'exclude']);

async function handleApi(req, res, url) {
  const { pathname } = url;

  if (pathname === '/api/login' && req.method === 'POST') {
    const { username, password } = await readJson(req);
    const result = auth.login(username, password, clientIp(req));
    if (!result.ok) return send(res, result.status, { error: result.error });
    return send(res, 200, { ok: true }, { 'Set-Cookie': result.cookie });
  }

  const user = auth.currentUser(req);
  if (!user) return send(res, 401, { error: 'Not signed in' });

  if (pathname === '/api/logout' && req.method === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': auth.logout(req) });
  }
  if (pathname === '/api/me' && req.method === 'GET') {
    return send(res, 200, { username: user, demo: DEMO });
  }
  if (pathname === '/api/summary' && req.method === 'GET') {
    const data = await loadData(url.searchParams.get('refresh') === '1');
    return send(res, 200, buildSummary(data));
  }
  if (pathname === '/api/settings' && req.method === 'PUT') {
    const body = await readJson(req);
    const patch = {};
    if (body.budget !== undefined) {
      const b = Number(body.budget);
      if (!Number.isFinite(b) || b <= 0 || b > 1_000_000) return send(res, 400, { error: 'Budget must be a positive number' });
      patch.budget = Math.round(b * 100) / 100;
    }
    if (body.monthStartDay !== undefined) {
      const d = Number(body.monthStartDay);
      if (!Number.isInteger(d) || d < 1 || d > 28) return send(res, 400, { error: 'Start day must be 1 to 28' });
      patch.monthStartDay = d;
    }
    if (body.trackedAccounts !== undefined) {
      if (!Array.isArray(body.trackedAccounts) || body.trackedAccounts.some((x) => typeof x !== 'string')) {
        return send(res, 400, { error: 'trackedAccounts must be a list of ids' });
      }
      patch.trackedAccounts = body.trackedAccounts.slice(0, 50);
    }
    if (body.excludedCategoryGroups !== undefined) {
      if (!Array.isArray(body.excludedCategoryGroups)) return send(res, 400, { error: 'Invalid category groups' });
      patch.excludedCategoryGroups = body.excludedCategoryGroups.map(String).slice(0, 30);
    }
    const startDayChanged = patch.monthStartDay !== undefined && patch.monthStartDay !== store.data.settings.monthStartDay;
    store.update((d) => { d.settings = { ...d.settings, ...patch }; });
    if (startDayChanged) cache = null; // period moved, so the fetch window moves too
    return send(res, 200, buildSummary(await loadData(false)));
  }
  if (pathname === '/api/override' && req.method === 'POST') {
    const { txId, mode } = await readJson(req);
    if (typeof txId !== 'string' || txId.length > 100) return send(res, 400, { error: 'Invalid transaction' });
    if (mode !== null && !MODES.has(mode)) return send(res, 400, { error: 'Invalid mode' });
    store.update((d) => {
      d.settings.overrides = { ...(d.settings.overrides || {}) };
      if (mode) d.settings.overrides[txId] = mode; else delete d.settings.overrides[txId];
    });
    return send(res, 200, buildSummary(await loadData(false)));
  }
  if (pathname === '/api/merchant-rule' && req.method === 'POST') {
    const { key, name, mode } = await readJson(req);
    if (typeof key !== 'string' || key.length > 200) return send(res, 400, { error: 'Invalid merchant' });
    if (mode !== null && !MODES.has(mode)) return send(res, 400, { error: 'Invalid mode' });
    store.update((d) => {
      d.settings.merchantRules = { ...(d.settings.merchantRules || {}) };
      if (mode) d.settings.merchantRules[key] = { mode, name: String(name || '').slice(0, 100) };
      else delete d.settings.merchantRules[key];
    });
    return send(res, 200, buildSummary(await loadData(false)));
  }
  return send(res, 404, { error: 'Not found' });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain' });
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    const message = status === 500
      ? (String(err.message).startsWith('Akahu') ? 'Could not reach the bank feed. Try again shortly.' : 'Something went wrong.')
      : err.message;
    return send(res, status, { error: message });
  }
});

const port = Number(env.PORT) || 3000;
server.listen(port, () => console.log(`Budget app listening on http://localhost:${port}${DEMO ? ' (demo data)' : ''}`));
