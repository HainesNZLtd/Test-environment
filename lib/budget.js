// Pure budget logic. No I/O, so it is easy to test and reason about.
//
// The hard part of this app is not adding up numbers, it is deciding which
// transactions belong in a "groceries and miscellaneous, nothing recurring"
// budget. The rules below are applied in order, and the first match wins:
//
//   1. A decision you made on that specific transaction
//   2. A rule you set for that merchant ("always include" / "always exclude")
//   3. Money in: refunds from a merchant reduce spend, everything else is ignored
//   4. Card repayments from the bank account (otherwise Amex spend counts twice)
//   5. Transaction types that are never discretionary (transfers, direct debits...)
//   6. Category groups that are regular bills (housing, utilities, insurance)
//   7. Anything that charged a near-identical amount in 2 of the last 3 months
//   8. Everything else counts

export const TZ = 'Pacific/Auckland';
const DAY = 86_400_000;

export const DEFAULTS = Object.freeze({
  budget: 4000,
  monthStartDay: 1,
  trackedAccounts: null, // null = every everyday account and credit card
  excludedTypes: ['TRANSFER', 'STANDING ORDER', 'DIRECT DEBIT', 'LOAN', 'INTEREST', 'TAX', 'PAYMENT'],
  excludedCategoryGroups: ['Housing', 'Utilities', 'Insurance'],
  repaymentPatterns: ['AMEX', 'AMERICAN EXPRESS', 'CREDIT CARD', 'CC PAYMENT'],
  merchantRules: {},
  overrides: {},
});

const TYPE_LABELS = {
  TRANSFER: 'Transfer between accounts',
  'STANDING ORDER': 'Standing order (regular payment)',
  'DIRECT DEBIT': 'Direct debit (regular bill)',
  LOAN: 'Loan payment',
  INTEREST: 'Interest',
  TAX: 'Tax',
  PAYMENT: 'Bill payment',
};

const round2 = (n) => Math.round(n * 100) / 100;
const parseDay = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fmtDay = (t) => new Date(t).toISOString().slice(0, 10);

/** Calendar date (YYYY-MM-DD) in New Zealand for an ISO timestamp or Date. */
export function nzDate(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/**
 * The budget period containing `today`, shifted by `offset` periods.
 * startDay lets you align the budget to payday (1-28). End date is exclusive.
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

/** A stable key for "the same merchant": Akahu's merchant id, else a cleaned description. */
export function merchantKey(tx) {
  if (tx.merchantId) return `m:${tx.merchantId}`;
  const cleaned = String(tx.description || '')
    .toUpperCase()
    .replace(/[^A-Z ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 3)
    .join(' ');
  return `d:${cleaned}`;
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Find subscription-like spend: a merchant charging a near-identical amount,
 * at most twice a month, in at least 2 of the previous 3 periods.
 * Deliberately strict so the supermarket (frequent, variable) is never caught.
 */
export function detectRecurring(history, today, startDay = 1) {
  const periods = [1, 2, 3].map((i) => periodFor(today, startDay, -i));
  const groups = new Map();
  for (const t of history) {
    if (t.amount >= 0) continue;
    const idx = periods.findIndex((p) => t.date >= p.start && t.date < p.end);
    if (idx < 0) continue;
    if (!groups.has(t.merchantKey)) groups.set(t.merchantKey, [[], [], []]);
    groups.get(t.merchantKey)[idx].push(-t.amount);
  }
  const recurring = new Map();
  for (const [key, byPeriod] of groups) {
    const present = byPeriod.filter((a) => a.length > 0);
    if (present.length < 2 || present.some((a) => a.length > 2)) continue;
    const all = present.flat();
    const med = median(all);
    const tolerance = Math.max(1, med * 0.1);
    if (all.every((a) => Math.abs(a - med) <= tolerance)) recurring.set(key, { median: round2(med) });
  }
  return recurring;
}

/** Decide whether one transaction counts against the budget, and say why. */
export function classify(tx, settings, recurring = new Map()) {
  const s = settings;
  const override = s.overrides?.[tx.id];
  if (override) {
    return override === 'include'
      ? { counted: true, reason: 'Included by you', source: 'override' }
      : { counted: false, reason: 'Excluded by you', source: 'override' };
  }
  const rule = s.merchantRules?.[tx.merchantKey];
  if (rule) {
    return rule.mode === 'include'
      ? { counted: true, reason: 'Merchant always included', source: 'merchant' }
      : { counted: false, reason: 'Merchant always excluded', source: 'merchant' };
  }

  const desc = String(tx.description || '').toUpperCase();

  if (tx.amount > 0) {
    if (tx.accountKind === 'card' && (!tx.merchantName || /PAYMENT|THANK YOU/.test(desc))) {
      return { counted: false, reason: 'Card repayment received', source: 'auto' };
    }
    if (tx.merchantName && !s.excludedTypes.includes(tx.type)) {
      return { counted: true, reason: 'Refund', source: 'auto' };
    }
    return { counted: false, reason: 'Money in', source: 'auto' };
  }

  if (tx.accountKind === 'bank' && s.repaymentPatterns.some((p) => desc.includes(p.toUpperCase()))) {
    return { counted: false, reason: 'Card repayment (spend already counted on the card)', source: 'auto' };
  }
  if (s.excludedTypes.includes(tx.type)) {
    return { counted: false, reason: TYPE_LABELS[tx.type] || tx.type, source: 'auto' };
  }
  if (tx.categoryGroup && s.excludedCategoryGroups.includes(tx.categoryGroup)) {
    return { counted: false, reason: `${tx.categoryGroup}: regular bill`, source: 'auto' };
  }
  const r = recurring.get(tx.merchantKey);
  if (r && Math.abs(-tx.amount - r.median) <= Math.max(2, r.median * 0.15)) {
    return { counted: false, reason: 'Looks recurring: same amount most months', source: 'auto' };
  }
  return { counted: true, reason: 'Counted', source: 'auto' };
}

/** Build everything the dashboard needs from accounts, transactions and settings. */
export function summarise({ accounts, transactions, settings, today = nzDate(), fetchedAt = null, demo = false }) {
  const s = { ...DEFAULTS, ...settings };
  const trackedIds = new Set(s.trackedAccounts ?? accounts.filter((a) => a.defaultTracked).map((a) => a.id));
  const period = periodFor(today, s.monthStartDay);

  const mine = transactions
    .filter((t) => trackedIds.has(t.accountId))
    .map((t) => ({ ...t, merchantKey: t.merchantKey || merchantKey(t) }));
  const history = mine.filter((t) => t.date < period.start && !t.pending);
  const recurring = detectRecurring(history, today, s.monthStartDay);

  const current = mine
    .filter((t) => t.date >= period.start && t.date < period.end)
    .map((t) => ({ ...t, ...classify(t, s, recurring) }))
    .sort((a, b) => (a.date === b.date ? Number(b.pending) - Number(a.pending) : a.date < b.date ? 1 : -1));

  const counted = current.filter((t) => t.counted);
  const spent = round2(-counted.reduce((sum, t) => sum + t.amount, 0));
  const pendingSpent = round2(-counted.filter((t) => t.pending).reduce((sum, t) => sum + t.amount, 0));
  const available = round2(s.budget - spent);
  const daysLeft = period.daysTotal - period.daysElapsed + 1; // including today
  const expectedByNow = round2((s.budget * period.daysElapsed) / period.daysTotal);
  const projected = period.daysElapsed > 0 ? round2((spent / period.daysElapsed) * period.daysTotal) : 0;

  let status = 'on-track';
  if (spent > s.budget) status = 'over';
  else if (spent > expectedByNow) status = 'ahead-of-pace';

  const byMerchant = new Map();
  for (const t of counted) {
    const name = t.merchantName || t.description;
    const m = byMerchant.get(t.merchantKey) || { key: t.merchantKey, name, total: 0, count: 0 };
    m.total = round2(m.total - t.amount);
    m.count += 1;
    byMerchant.set(t.merchantKey, m);
  }
  const topMerchants = [...byMerchant.values()].sort((a, b) => b.total - a.total).slice(0, 6);

  return {
    demo,
    fetchedAt,
    today,
    period: { ...period, daysLeft },
    budget: s.budget,
    spent,
    pendingSpent,
    available,
    expectedByNow,
    projected,
    dailyAllowance: available > 0 ? round2(available / daysLeft) : 0,
    status,
    topMerchants,
    accounts: accounts.map((a) => ({ ...a, tracked: trackedIds.has(a.id) })),
    transactions: current.map((t) => ({
      ...t,
      merchantRule: s.merchantRules[t.merchantKey]?.mode || null,
      override: s.overrides[t.id] || null,
    })),
    settings: {
      budget: s.budget,
      monthStartDay: s.monthStartDay,
      excludedCategoryGroups: s.excludedCategoryGroups,
      merchantRules: s.merchantRules,
    },
  };
}
