import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, classify, detectRecurring, merchantKey, nzDate, periodFor, summarise } from '../lib/budget.js';
import { normaliseTransaction } from '../lib/akahu.js';
import { demoData } from '../lib/demo.js';

const S = { ...DEFAULTS, merchantRules: {}, overrides: {} };
const tx = (o) => {
  const t = { id: 'x', accountId: 'a', accountKind: 'card', date: '2026-11-10', description: '', merchantName: null, merchantId: null, amount: -10, type: 'CREDIT CARD', categoryGroup: null, pending: false, ...o };
  t.merchantKey = merchantKey(t);
  return t;
};

test('calendar month period', () => {
  assert.deepEqual(periodFor('2026-11-24', 1), { start: '2026-11-01', end: '2026-12-01', daysTotal: 30, daysElapsed: 24 });
});

test('payday-aligned period rolls back before start day and across years', () => {
  assert.deepEqual(periodFor('2026-01-10', 15), { start: '2025-12-15', end: '2026-01-15', daysTotal: 31, daysElapsed: 27 });
  assert.equal(periodFor('2026-01-10', 15, -1).start, '2025-11-15');
});

test('NZ date uses Auckland time, not UTC', () => {
  // 11pm UTC on 30 Nov is 12pm 1 Dec in NZ (daylight time)
  assert.equal(nzDate('2026-11-30T23:00:00Z'), '2026-12-01');
});

test('Amex repayment from the bank is not double counted', () => {
  const bank = tx({ accountKind: 'bank', description: 'AMERICAN EXPRESS PAYMENT', amount: -2400, type: 'PAYMENT' });
  assert.equal(classify(bank, S).counted, false);
  const cardSide = tx({ description: 'PAYMENT RECEIVED - THANK YOU', amount: 2400, type: 'PAYMENT' });
  assert.equal(classify(cardSide, S).counted, false);
});

test('merchant refund reduces spend, salary does not', () => {
  assert.equal(classify(tx({ merchantName: 'Kmart', merchantId: 'k', amount: 34 }), S).reason, 'Refund');
  assert.equal(classify(tx({ accountKind: 'bank', description: 'SALARY', amount: 8000, type: 'CREDIT' }), S).counted, false);
});

test('transfers, direct debits and utility categories are excluded', () => {
  assert.equal(classify(tx({ accountKind: 'bank', type: 'TRANSFER' }), S).counted, false);
  assert.equal(classify(tx({ accountKind: 'bank', type: 'DIRECT DEBIT' }), S).counted, false);
  assert.equal(classify(tx({ categoryGroup: 'Utilities' }), S).counted, false);
});

test('subscriptions are detected, variable supermarket spend is not', () => {
  const hist = [];
  for (const [m, amts] of [['2026-08', [22.99]], ['2026-09', [22.99]], ['2026-10', [22.99]]]) {
    for (const a of amts) hist.push(tx({ merchantId: 'netflix', merchantName: 'Netflix', date: `${m}-07`, amount: -a }));
  }
  for (const [d, a] of [['2026-09-03', 210], ['2026-09-17', 145], ['2026-10-02', 260], ['2026-10-20', 98]]) {
    hist.push(tx({ merchantId: 'ww', merchantName: 'Woolworths', date: d, amount: -a }));
  }
  const rec = detectRecurring(hist, '2026-11-24', 1);
  assert.ok(rec.has('m:netflix'));
  assert.ok(!rec.has('m:ww'));
  assert.equal(classify(tx({ merchantId: 'netflix', merchantName: 'Netflix', amount: -22.99 }), S, rec).counted, false);
  // A one-off bigger purchase at the same merchant still counts
  assert.equal(classify(tx({ merchantId: 'netflix', merchantName: 'Netflix', amount: -120 }), S, rec).counted, true);
});

test('your overrides beat every automatic rule', () => {
  const t = tx({ id: 't1', accountKind: 'bank', type: 'TRANSFER' });
  assert.equal(classify(t, { ...S, overrides: { t1: 'include' } }).counted, true);
  const g = tx({ id: 't2', merchantId: 'ww', merchantName: 'Woolworths' });
  assert.equal(classify(g, { ...S, merchantRules: { 'm:ww': { mode: 'exclude' } } }).counted, false);
});

test('Akahu payloads normalise correctly', () => {
  const accounts = new Map([['acc_1', { id: 'acc_1', name: 'Amex', kind: 'card' }]]);
  const t = normaliseTransaction({
    _id: 'trans_1', _account: 'acc_1', date: '2026-11-10T02:00:00Z', description: 'COUNTDOWN PONSONBY', amount: -84.5,
    type: 'CREDIT CARD', merchant: { _id: 'merchant_1', name: 'Woolworths' },
    category: { name: 'Supermarkets', groups: { personal_finance: { name: 'Food' } } },
  }, accounts);
  assert.equal(t.accountKind, 'card');
  assert.equal(t.categoryGroup, 'Food');
  assert.equal(t.merchantKey, 'm:merchant_1');
  const p = normaliseTransaction({ _account: 'acc_1', date: '2026-11-10T02:00:00Z', description: 'X', amount: -5 }, accounts, true);
  assert.match(p.id, /^p:/);
});

test('demo month summarises sensibly', () => {
  const today = '2026-11-24';
  const { accounts, transactions } = demoData(today);
  const s = summarise({ accounts, transactions, settings: {}, today });
  assert.equal(s.budget, 4000);
  assert.ok(s.spent > 500 && s.spent < 6000, `spent ${s.spent}`);
  const reasons = new Set(s.transactions.filter((t) => !t.counted).map((t) => t.reason));
  assert.ok([...reasons].some((r) => r.startsWith('Card repayment')));
  assert.ok(reasons.has('Looks recurring: same amount most months'));
  assert.ok(!s.transactions.some((t) => t.accountId === 'acc_savings'));
});
