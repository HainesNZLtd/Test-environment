// Pure budget logic: periods, validation, totals. No I/O, so it is easy to test.

export const TZ = 'Pacific/Auckland';
export const CATEGORIES = ['Groceries', 'Misc'];
export const DEFAULT_SETTINGS = Object.freeze({ budget: 4000, monthStartDay: 1 });
const DAY = 86_400_000;

const round2 = (n) => Math.round(n * 100) / 100;
const parseDay = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fmtDay = (t) => new Date(t).toISOString().slice(0, 10);

/** Calendar date (YYYY-MM-DD) in New Zealand. */
export function nzDate(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/**
 * The budget period containing `today`, shifted by `offset` periods.
 * startDay (1-28) lets the month run payday to payday. End date is exclusive.
 */
export function periodFor(today, startDay = 1, offset = 0) {
  const sd = Math.min(28, Math.max(1, Math.trunc(startDay) || 1));
  let [y, m, d] = today.split('-').map(Number);
  m -= 1;
  if (d < sd) m -= 1;
  m += offset;
  const start = Date.UTC(y, m, sd);
  const end = Date.UTC(y, m + 1, sd);
  const daysTotal = Math.round((end - start) / DAY);
  const daysElapsed = Math.min(daysTotal, Math.max(0, Math.round((parseDay(today) - start) / DAY) + 1));
  return { start: fmtDay(start), end: fmtDay(end), daysTotal, daysElapsed };
}

/** Month prefixes (YYYY-MM) a period touches, for listing stored entries. */
export function monthsInPeriod(period) {
  const months = new Set([period.start.slice(0, 7)]);
  const lastDay = fmtDay(parseDay(period.end) - DAY);
  months.add(lastDay.slice(0, 7));
  return [...months];
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return fmtDay(parseDay(s)) === s;
}

/** Validate and clean an entry from the client. Returns { entry } or { error }. */
export function validateEntry(body, today = nzDate()) {
  if (!body || typeof body !== 'object') return { error: 'Missing entry' };
  const amount = Math.round(Number(body.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100_000) {
    return { error: 'Enter an amount. Use a minus sign for a refund.' };
  }
  if (!isValidDate(body.date)) return { error: 'Enter a valid date' };
  if (body.date > fmtDay(parseDay(today) + DAY)) return { error: 'That date is in the future' };
  const category = CATEGORIES.includes(body.category) ? body.category : 'Misc';
  const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  const merchant = clean(body.merchant, 80);
  if (!merchant) return { error: 'Where was it spent?' };
  const receiptId = typeof body.receiptId === 'string' && /^[a-f0-9-]{36}$/.test(body.receiptId) ? body.receiptId : null;
  return { entry: { amount, date: body.date, merchant, category, note: clean(body.note, 200), receiptId } };
}

export function validateSettings(body, current) {
  const next = { ...current };
  if (body.budget !== undefined) {
    const b = Number(body.budget);
    if (!Number.isFinite(b) || b <= 0 || b > 1_000_000) return { error: 'Budget must be a positive number' };
    next.budget = round2(b);
  }
  if (body.monthStartDay !== undefined) {
    const d = Number(body.monthStartDay);
    if (!Number.isInteger(d) || d < 1 || d > 28) return { error: 'Start day must be between 1 and 28' };
    next.monthStartDay = d;
  }
  return { settings: next };
}

/** Everything the dashboard needs for one period. */
export function summarise({ entries, settings, today = nzDate(), offset = 0 }) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const p = periodFor(today, s.monthStartDay, offset);
  const isCurrent = offset === 0;
  const daysElapsed = isCurrent ? p.daysElapsed : p.daysTotal;

  const inPeriod = entries
    .filter((e) => e.date >= p.start && e.date < p.end)
    .sort((a, b) => (a.date === b.date ? (b.createdAt || '').localeCompare(a.createdAt || '') : a.date < b.date ? 1 : -1));

  const spent = round2(inPeriod.reduce((sum, e) => sum + e.amount, 0));
  const available = round2(s.budget - spent);
  const daysLeft = isCurrent ? p.daysTotal - p.daysElapsed + 1 : 0; // including today
  const expectedByNow = round2((s.budget * daysElapsed) / p.daysTotal);
  const projected = daysElapsed > 0 ? round2((spent / daysElapsed) * p.daysTotal) : 0;

  let status = 'on-track';
  if (spent > s.budget) status = 'over';
  else if (isCurrent && spent > expectedByNow) status = 'ahead-of-pace';

  const tally = (key) => {
    const m = new Map();
    for (const e of inPeriod) m.set(e[key], round2((m.get(e[key]) || 0) + e.amount));
    return [...m.entries()].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total);
  };

  return {
    today,
    offset,
    isCurrent,
    period: { ...p, daysElapsed, daysLeft },
    budget: s.budget,
    spent,
    available,
    expectedByNow,
    projected,
    dailyAllowance: isCurrent && available > 0 ? round2(available / daysLeft) : 0,
    status,
    byCategory: CATEGORIES.map((c) => ({ name: c, total: tally('category').find((x) => x.name === c)?.total || 0 })),
    byPerson: tally('createdByName'),
    entries: inPeriod,
    settings: s,
  };
}
