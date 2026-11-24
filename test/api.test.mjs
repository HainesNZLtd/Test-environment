import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../netlify/lib/handler.mjs';
import { memoryStore } from './memory-store.mjs';

function setup({ user = { id: 'u1', email: 'JP@example.com' }, allowedEmails = ['jp@example.com', 'sam@example.com'], extract } = {}) {
  const store = memoryStore();
  let current = user;
  const handle = createHandler({
    getUser: async () => current,
    store,
    allowedEmails,
    now: () => new Date('2026-11-24T01:00:00Z'),
    extractReceipt: extract || (async () => ({ isReceipt: true, merchant: 'Woolworths', date: '2026-11-23', total: 87.4, category: 'Groceries', note: 'Weekly shop' })),
  });
  const call = async (method, path, body, headers = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined && !(body instanceof Uint8Array)) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    } else if (body) init.body = body;
    const res = await handle(new Request(`https://budget.example${path}`, init));
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.arrayBuffer(), headers: res.headers };
  };
  return { call, store, setUser: (u) => { current = u; } };
}

test('rejects signed-out and non-allowlisted users', async () => {
  const a = setup({ user: null });
  assert.equal((await a.call('GET', '/api/summary')).status, 401);
  const b = setup({ user: { id: 'x', email: 'stranger@example.com' } });
  assert.equal((await b.call('GET', '/api/summary')).status, 401);
});

test('add, edit (including date move), list and delete entries', async () => {
  const { call, setUser } = setup();
  const created = await call('POST', '/api/entries', { amount: 120.5, merchant: 'New World', category: 'Groceries', date: '2026-11-20' });
  assert.equal(created.status, 201);
  assert.equal(created.body.createdByName, 'Jp');

  setUser({ id: 'u2', email: 'sam@example.com', name: 'Sam' });
  await call('POST', '/api/entries', { amount: 60, merchant: 'Kmart', category: 'Misc', date: '2026-11-21' });

  let s = (await call('GET', '/api/summary')).body;
  assert.equal(s.spent, 180.5);
  assert.equal(s.user.name, 'Sam');
  assert.deepEqual(s.byPerson.map((p) => p.name), ['Jp', 'Sam']);

  const moved = await call('PUT', `/api/entries/${created.body.id}`, { amount: 100, merchant: 'New World', category: 'Groceries', date: '2026-10-30' });
  assert.equal(moved.status, 200);
  s = (await call('GET', '/api/summary')).body;
  assert.equal(s.spent, 60);
  const last = (await call('GET', '/api/summary?offset=-1')).body;
  assert.equal(last.spent, 100);

  assert.equal((await call('DELETE', `/api/entries/${moved.body.id}`)).status, 200);
  assert.equal((await call('GET', '/api/summary?offset=-1')).body.spent, 0);
  assert.equal((await call('DELETE', `/api/entries/${moved.body.id}`)).status, 404);
});

test('validation errors come back as 400 with a message', async () => {
  const { call } = setup();
  const r = await call('POST', '/api/entries', { amount: 'abc', merchant: 'x', date: '2026-11-20' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /amount/i);
  assert.equal((await call('GET', '/api/summary?offset=3')).status, 400);
});

test('receipt upload stores the photo, returns what was read, and deleting the entry removes it', async () => {
  const { call, store } = setup();
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const up = await call('POST', '/api/receipts', jpeg, { 'content-type': 'image/jpeg' });
  assert.equal(up.status, 200);
  assert.equal(up.body.extracted.total, 87.4);
  const img = await call('GET', `/api/receipts/${up.body.receiptId}`);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal(new Uint8Array(img.body).length, jpeg.length);

  const e = await call('POST', '/api/entries', { amount: 87.4, merchant: 'Woolworths', category: 'Groceries', date: '2026-11-23', receiptId: up.body.receiptId });
  await call('DELETE', `/api/entries/${e.body.id}`);
  assert.equal(store.data.has(`receipts/${up.body.receiptId}`), false);
});

test('a failed receipt read still keeps the photo and lets you type it in', async () => {
  const { call } = setup({ extract: async () => { throw new Error('boom'); } });
  const up = await call('POST', '/api/receipts', new Uint8Array([1, 2, 3]), { 'content-type': 'image/png' });
  assert.equal(up.status, 200);
  assert.equal(up.body.extracted, null);
  assert.match(up.body.readError, /by hand/);
  assert.equal((await call('POST', '/api/receipts', new Uint8Array([1]), { 'content-type': 'text/html' })).status, 415);
});

test('settings change the budget', async () => {
  const { call } = setup();
  const r = await call('PUT', '/api/settings', { budget: 4500, monthStartDay: 15 });
  assert.equal(r.body.budget, 4500);
  assert.equal(r.body.period.start, '2026-11-15');
  assert.equal((await call('PUT', '/api/settings', { budget: -1 })).status, 400);
});
