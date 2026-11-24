// Password login with scrypt hashes, opaque session cookies stored hashed,
// and rate limiting on login attempts.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_DAYS = 30;
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

export function createAuth(store, { secureCookies }) {
  const attempts = new Map(); // key -> [timestamps]
  // A fixed dummy user so failed lookups cost the same time as real ones.
  const dummy = hashPassword(randomBytes(16).toString('hex'));

  function limited(key) {
    const now = Date.now();
    const recent = (attempts.get(key) || []).filter((t) => now - t < WINDOW_MS);
    attempts.set(key, recent);
    return recent.length >= MAX_ATTEMPTS;
  }
  function recordFailure(key) {
    attempts.set(key, [...(attempts.get(key) || []), Date.now()]);
  }

  function login(username, password, ip) {
    const name = String(username || '').trim().toLowerCase();
    const keys = [`ip:${ip}`, `user:${name}`];
    if (keys.some(limited)) return { ok: false, status: 429, error: 'Too many attempts. Try again in 15 minutes.' };
    const user = store.data.users[name];
    const ok = verifyPassword(String(password || ''), user || dummy) && Boolean(user);
    if (!ok) {
      keys.forEach(recordFailure);
      return { ok: false, status: 401, error: 'Wrong username or password.' };
    }
    keys.forEach((k) => attempts.delete(k));
    const token = randomBytes(32).toString('base64url');
    const expires = Date.now() + SESSION_DAYS * 86_400_000;
    store.update((d) => {
      for (const [k, s] of Object.entries(d.sessions)) if (s.expires < Date.now()) delete d.sessions[k];
      d.sessions[sha(token)] = { username: name, expires };
    });
    return { ok: true, cookie: cookie(token, SESSION_DAYS * 86400) };
  }

  function cookie(value, maxAge) {
    return [`sid=${value}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAge}`, secureCookies ? 'Secure' : null]
      .filter(Boolean).join('; ');
  }

  function tokenFrom(req) {
    const match = /(?:^|;\s*)sid=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
    return match ? match[1] : null;
  }

  function currentUser(req) {
    const token = tokenFrom(req);
    if (!token) return null;
    const session = store.data.sessions[sha(token)];
    if (!session || session.expires < Date.now()) return null;
    return session.username;
  }

  function logout(req) {
    const token = tokenFrom(req);
    if (token) store.update((d) => { delete d.sessions[sha(token)]; });
    return cookie('', 0);
  }

  return { login, logout, currentUser };
}
