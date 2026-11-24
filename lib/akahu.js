// Read-only Akahu client. Akahu is NZ's open banking aggregator: you connect
// your bank and Amex once in Akahu, and this app reads accounts and
// transactions with a personal app token. Tokens never leave the server.
import { createHash } from 'node:crypto';
import { nzDate, merchantKey } from './budget.js';

const BASE = 'https://api.akahu.io/v1';
const TRACKED_BY_DEFAULT = new Set(['CHECKING', 'CREDITCARD']);

export function createAkahuClient({ appToken, userToken, fetchImpl = fetch }) {
  if (!appToken || !userToken) throw new Error('AKAHU_APP_TOKEN and AKAHU_USER_TOKEN are required');
  const headers = {
    Authorization: `Bearer ${userToken}`,
    'X-Akahu-Id': appToken,
    Accept: 'application/json',
  };

  async function request(method, path, params = {}) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
    const res = await fetchImpl(url, { method, headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Akahu ${method} ${path} failed: ${res.status} ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  async function getAccounts() {
    const { items = [] } = await request('GET', '/accounts');
    return items.map((a) => ({
      id: a._id,
      name: a.name,
      institution: a.connection?.name || '',
      type: a.type,
      kind: a.type === 'CREDITCARD' ? 'card' : 'bank',
      balance: a.balance?.current ?? null,
      availableBalance: a.balance?.available ?? null,
      defaultTracked: TRACKED_BY_DEFAULT.has(a.type),
    }));
  }

  async function getTransactions(startISO, endISO) {
    const out = [];
    let cursor;
    for (let page = 0; page < 50; page += 1) {
      const res = await request('GET', '/transactions', { start: startISO, end: endISO, cursor });
      out.push(...(res.items || []));
      cursor = res.cursor?.next;
      if (!cursor) break;
    }
    return out;
  }

  async function getPending() {
    const { items = [] } = await request('GET', '/transactions/pending');
    return items;
  }

  /** Ask Akahu to pull fresh data from the banks. Rate limited by Akahu, so failures are ignored. */
  async function refresh() {
    try { await request('POST', '/refresh'); } catch { /* best effort */ }
  }

  return { getAccounts, getTransactions, getPending, refresh };
}

export function normaliseTransaction(t, accountsById, pending = false) {
  const acc = accountsById.get(t._account);
  const id = t._id || `p:${createHash('sha256')
    .update([t._account, t.date, t.amount, t.description].join('|'))
    .digest('hex')
    .slice(0, 24)}`;
  const tx = {
    id,
    accountId: t._account,
    accountName: acc?.name || 'Unknown account',
    accountKind: acc?.kind || 'bank',
    date: nzDate(t.date),
    description: t.description || '',
    merchantId: t.merchant?._id || null,
    merchantName: t.merchant?.name || null,
    amount: Number(t.amount),
    type: t.type || '',
    category: t.category?.name || null,
    categoryGroup: t.category?.groups?.personal_finance?.name || null,
    pending,
  };
  tx.merchantKey = merchantKey(tx);
  return tx;
}
