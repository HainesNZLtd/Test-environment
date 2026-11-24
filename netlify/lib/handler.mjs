// The API, with its dependencies passed in so it can be tested without Netlify.
//
//   GET    /api/summary?offset=0     dashboard for a month (0 = this month, -1 = last month)
//   POST   /api/entries              add an entry
//   PUT    /api/entries/:id          edit an entry
//   DELETE /api/entries/:id          delete an entry (and its receipt photo)
//   POST   /api/receipts             upload a receipt photo; returns what Claude read from it
//   GET    /api/receipts/:id         view a receipt photo
//   PUT    /api/settings             change budget or month start day
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, monthsInPeriod, nzDate, periodFor, summarise, validateEntry, validateSettings } from './budget.mjs';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ENTRY_ID = /^(\d{4}-\d{2}-\d{2})\.([a-f0-9-]{36})$/;

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (status, error) => json({ error }, status);

export function createHandler({ getUser, store, extractReceipt, allowedEmails = [], now = () => new Date(), verifyOrigin = () => {} }) {
  const allowed = allowedEmails.map((e) => e.trim().toLowerCase()).filter(Boolean);

  async function currentUser() {
    const user = await getUser();
    if (!user?.email) return null;
    const email = user.email.toLowerCase();
    if (allowed.length && !allowed.includes(email)) return null;
    const name = (typeof user.name === 'string' && user.name.trim()) || email.split('@')[0].replace(/^./, (c) => c.toUpperCase());
    return { id: user.id, email, name };
  }

  async function getSettings() {
    return { ...DEFAULT_SETTINGS, ...((await store.get('settings', { type: 'json' })) || {}) };
  }

  async function loadEntries(period) {
    const keys = [];
    for (const month of monthsInPeriod(period)) {
      const { blobs } = await store.list({ prefix: `entries/${month}` });
      keys.push(...blobs.map((b) => b.key));
    }
    const entries = await Promise.all(keys.map((k) => store.get(k, { type: 'json' })));
    return entries.filter(Boolean);
  }

  async function summary(offset) {
    const settings = await getSettings();
    const today = nzDate(now());
    const period = periodFor(today, settings.monthStartDay, offset);
    return summarise({ entries: await loadEntries(period), settings, today, offset });
  }

  const entryKey = (date, uuid) => `entries/${date}/${uuid}`;

  return async function handle(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '');
    const method = req.method;

    if (method !== 'GET') {
      try { verifyOrigin(req); } catch { return fail(403, 'Request blocked'); }
    }

    const user = await currentUser();
    if (!user) return fail(401, 'Please sign in');

    try {
      if (path === '/api/summary' && method === 'GET') {
        const offset = Math.trunc(Number(url.searchParams.get('offset') || 0));
        if (!Number.isFinite(offset) || offset > 0 || offset < -36) return fail(400, 'Invalid month');
        return json({ ...(await summary(offset)), user });
      }

      if (path === '/api/entries' && method === 'POST') {
        const { entry, error } = validateEntry(await readJson(req), nzDate(now()));
        if (error) return fail(400, error);
        const uuid = randomUUID();
        const record = {
          ...entry,
          id: `${entry.date}.${uuid}`,
          createdBy: user.email,
          createdByName: user.name,
          createdAt: now().toISOString(),
        };
        await store.setJSON(entryKey(entry.date, uuid), record);
        return json(record, 201);
      }

      const entryMatch = /^\/api\/entries\/([^/]+)$/.exec(path);
      if (entryMatch) {
        const idMatch = ENTRY_ID.exec(decodeURIComponent(entryMatch[1]));
        if (!idMatch) return fail(404, 'Entry not found');
        const [, oldDate, uuid] = idMatch;
        const existing = await store.get(entryKey(oldDate, uuid), { type: 'json' });
        if (!existing) return fail(404, 'Entry not found');

        if (method === 'DELETE') {
          await store.delete(entryKey(oldDate, uuid));
          if (existing.receiptId) await store.delete(`receipts/${existing.receiptId}`);
          return json({ ok: true });
        }
        if (method === 'PUT') {
          const { entry, error } = validateEntry(await readJson(req), nzDate(now()));
          if (error) return fail(400, error);
          const record = {
            ...existing,
            ...entry,
            receiptId: entry.receiptId ?? existing.receiptId,
            id: `${entry.date}.${uuid}`,
            updatedBy: user.email,
            updatedAt: now().toISOString(),
          };
          await store.setJSON(entryKey(entry.date, uuid), record);
          if (entry.date !== oldDate) await store.delete(entryKey(oldDate, uuid));
          return json(record);
        }
      }

      if (path === '/api/receipts' && method === 'POST') {
        const type = (req.headers.get('content-type') || '').split(';')[0].trim();
        if (!IMAGE_TYPES.has(type)) return fail(415, 'Send a JPEG, PNG or WebP photo');
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return fail(413, 'Photo is too large');
        const receiptId = randomUUID();
        await store.set(`receipts/${receiptId}`, bytes, { metadata: { contentType: type, uploadedBy: user.email } });
        let extracted = null;
        let readError = null;
        try {
          extracted = await extractReceipt({ bytes, mediaType: type, today: nzDate(now()) });
        } catch (err) {
          console.error('Receipt read failed', err);
          readError = 'Couldn’t read the receipt. Fill in the details by hand.';
        }
        return json({ receiptId, extracted, readError });
      }

      const receiptMatch = /^\/api\/receipts\/([a-f0-9-]{36})$/.exec(path);
      if (receiptMatch && method === 'GET') {
        const found = await store.getWithMetadata(`receipts/${receiptMatch[1]}`, { type: 'arrayBuffer' });
        if (!found) return fail(404, 'Receipt not found');
        return new Response(found.data, {
          headers: {
            'Content-Type': IMAGE_TYPES.has(found.metadata?.contentType) ? found.metadata.contentType : 'image/jpeg',
            'Cache-Control': 'private, max-age=86400',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }

      if (path === '/api/settings' && method === 'PUT') {
        const { settings, error } = validateSettings(await readJson(req), await getSettings());
        if (error) return fail(400, error);
        await store.setJSON('settings', settings);
        return json({ ...(await summary(0)), user });
      }

      return fail(404, 'Not found');
    } catch (err) {
      if (err.status) return fail(err.status, err.message);
      console.error(err);
      return fail(500, 'Something went wrong. Try again.');
    }
  };
}

async function readJson(req) {
  if (!(req.headers.get('content-type') || '').startsWith('application/json')) {
    throw Object.assign(new Error('Expected JSON'), { status: 415 });
  }
  const text = await req.text();
  if (text.length > 16_384) throw Object.assign(new Error('Too large'), { status: 413 });
  try { return JSON.parse(text || '{}'); } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}
