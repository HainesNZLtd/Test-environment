import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthsInPeriod, nzDate, periodFor, summarise, validateEntry, validateSettings } from '../netlify/lib/budget.mjs';
import { tidy } from '../netlify/lib/receipt.mjs';

test('calendar and payday-aligned periods', () => {
  assert.deepEqual(periodFor('2026-11-24', 1), { start: '2026-11-01', end: '2026-12-01', daysTotal: 30, daysElapsed: 24 });
  assert.deepEqual(periodFor('2026-01-10', 15), { start: '2025-12-15', end: '2026-01-15', daysTotal: 31, daysElapsed: 27 });
  assert.equal(periodFor('2026-11-24', 1, -1).start, '2026-10-01');
  assert.deepEqual(monthsInPeriod(periodFor('2026-01-10', 15)), ['2025-12', '2026-01']);
});

test('NZ date uses Auckland time', () => {
  assert.equal(nzDate('2026-11-30T23:00:00Z'), '2026-12-01');
});

test('entry validation', () => {
  const ok = validateEntry({ amount: '84.456', date: '2026-11-20', merchant: ' Woolworths ', category: 'Groceries' }, '2026-11-24');
  assert.deepEqual(ok.entry, { amount: 84.46, date: '2026-11-20', merchant: 'Woolworths', category: 'Groceries', note: '', receiptId: null });
  assert.equal(validateEntry({ amount: -20, date: '2026-11-20', merchant: 'Kmart refund' }, '2026-11-24').entry.category, 'Misc');
  assert.ok(validateEntry({ amount: 0, date: '2026-11-20', merchant: 'x' }).error);
  assert.ok(validateEntry({ amount: 5, date: '2026-02-30', merchant: 'x' }).error);
  assert.ok(validateEntry({ amount: 5, date: '2026-12-20', merchant: 'x' }, '2026-11-24').error);
  assert.ok(validateEntry({ amount: 5, date: '2026-11-20', merchant: '  ' }).error);
  assert.ok(validateSettings({ monthStartDay: 31 }, {}).error);
  assert.equal(validateSettings({ budget: '4500' }, { budget: 4000 }).settings.budget, 4500);
});

test('summary: totals, refunds, pace and splits', () => {
  const entries = [
    { date: '2026-11-02', amount: 300, category: 'Groceries', createdByName: 'Jp' },
    { date: '2026-11-10', amount: 500, category: 'Misc', createdByName: 'Sam' },
    { date: '2026-11-12', amount: -50, category: 'Misc', createdByName: 'Sam' },
    { date: '2026-10-28', amount: 999, category: 'Misc', createdByName: 'Sam' },
  ];
  const s = summarise({ entries, settings: { budget: 4000 }, today: '2026-11-15' });
  assert.equal(s.spent, 750);
  assert.equal(s.available, 3250);
  assert.equal(s.period.daysLeft, 16);
  assert.equal(s.dailyAllowance, 203.13);
  assert.equal(s.status, 'on-track');
  assert.deepEqual(s.byCategory, [{ name: 'Groceries', total: 300 }, { name: 'Misc', total: 450 }]);
  assert.deepEqual(s.byPerson, [{ name: 'Sam', total: 450 }, { name: 'Jp', total: 300 }]);
  const last = summarise({ entries, settings: { budget: 900 }, today: '2026-11-15', offset: -1 });
  assert.equal(last.spent, 999);
  assert.equal(last.status, 'over');
  assert.equal(last.dailyAllowance, 0);
});

test('receipt output is sanity-checked', () => {
  const t = tidy({ is_receipt: true, merchant: 'Pak’nSave', date: '2027-01-01', total: 123.456, category: 'Groceries', summary: 'Weekly shop' }, '2026-11-24');
  assert.equal(t.date, '2026-11-24'); // future date replaced with today
  assert.equal(t.total, 123.46);
  const bad = tidy({ is_receipt: false, merchant: null, date: null, total: null, category: 'Other', summary: '' }, '2026-11-24');
  assert.equal(bad.total, null);
  assert.equal(bad.category, 'Misc');
});
