// Realistic sample data so the app can be tried before connecting a bank.
// Deliberately includes the traps the real rules must handle: an Amex
// repayment from the bank, subscriptions, a power bill, salary, a refund.
import { nzDate, merchantKey, periodFor } from './budget.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const ACCOUNTS = [
  { id: 'acc_everyday', name: 'Everyday', institution: 'ANZ', type: 'CHECKING', kind: 'bank', balance: 6231.4, availableBalance: 6231.4, defaultTracked: true },
  { id: 'acc_amex', name: 'Amex Platinum', institution: 'American Express', type: 'CREDITCARD', kind: 'card', balance: -1874.22, availableBalance: 18125.78, defaultTracked: true },
  { id: 'acc_savings', name: 'Online Saver', institution: 'ANZ', type: 'SAVINGS', kind: 'bank', balance: 24100, availableBalance: 24100, defaultTracked: false },
];

const VARIABLE = [
  ['Woolworths', 'Food', 'acc_amex', 4, 140, 320],
  ['Pak’nSave', 'Food', 'acc_amex', 3, 90, 260],
  ['New World', 'Food', 'acc_everyday', 2, 25, 90],
  ['Farro Fresh', 'Food', 'acc_amex', 1, 40, 110],
  ['Kmart', 'Household', 'acc_amex', 1, 20, 140],
  ['Bunnings Warehouse', 'Household', 'acc_everyday', 1, 30, 180],
  ['Chemist Warehouse', 'Health', 'acc_amex', 1, 15, 70],
  ['Z Energy', 'Transport', 'acc_everyday', 2, 80, 130],
  ['Coffee Supreme', 'Food', 'acc_everyday', 5, 5, 14],
];

const FIXED = [
  // name, group, account, day, amount, type
  ['Netflix', 'Lifestyle', 'acc_amex', 7, 22.99, 'CREDIT CARD'],
  ['Spotify', 'Lifestyle', 'acc_amex', 12, 25.99, 'CREDIT CARD'],
  ['Les Mills', 'Lifestyle', 'acc_everyday', 3, 79, 'EFTPOS'],
  ['Mercury Energy', 'Utilities', 'acc_everyday', 18, 212.4, 'DIRECT DEBIT'],
];

function tx(fields) {
  const t = { pending: false, category: null, ...fields };
  t.accountName = ACCOUNTS.find((a) => a.id === t.accountId).name;
  t.accountKind = ACCOUNTS.find((a) => a.id === t.accountId).kind;
  t.merchantKey = merchantKey(t);
  return t;
}

export function demoData(today = nzDate(), startDay = 1) {
  const out = [];
  for (let offset = -3; offset <= 0; offset += 1) {
    const p = periodFor(today, startDay, offset);
    const rand = rng(Number(p.start.replaceAll('-', '')));
    const lastDay = offset === 0 ? p.daysElapsed : p.daysTotal;
    const dayStr = (n) => new Date(Date.parse(p.start) + (n - 1) * 86_400_000).toISOString().slice(0, 10);
    const scale = lastDay / p.daysTotal;
    let n = 0;

    for (const [name, group, accountId, perMonth, min, max] of VARIABLE) {
      const count = Math.max(offset === 0 ? 0 : 1, Math.round(perMonth * scale + rand() - 0.5));
      for (let i = 0; i < count; i += 1) {
        const day = 1 + Math.floor(rand() * lastDay);
        out.push(tx({
          id: `demo_${p.start}_${n++}`, accountId, date: dayStr(day),
          description: `${name.toUpperCase()} AUCKLAND`, merchantId: name.toLowerCase().replace(/\W/g, ''),
          merchantName: name, amount: -Math.round((min + rand() * (max - min)) * 100) / 100,
          type: accountId === 'acc_amex' ? 'CREDIT CARD' : 'EFTPOS', categoryGroup: group,
        }));
      }
    }
    for (const [name, group, accountId, day, amount, type] of FIXED) {
      if (day > lastDay) continue;
      out.push(tx({
        id: `demo_${p.start}_${n++}`, accountId, date: dayStr(day), description: name.toUpperCase(),
        merchantId: name.toLowerCase().replace(/\W/g, ''), merchantName: name, amount: -amount, type, categoryGroup: group,
      }));
    }
    if (lastDay >= 15) {
      out.push(tx({ id: `demo_${p.start}_${n++}`, accountId: 'acc_everyday', date: dayStr(15), description: 'SALARY ACME LTD', merchantId: null, merchantName: null, amount: 8200, type: 'CREDIT', categoryGroup: null }));
    }
    if (lastDay >= 20) {
      const repay = 2100 + Math.round(rand() * 600);
      out.push(tx({ id: `demo_${p.start}_${n++}`, accountId: 'acc_everyday', date: dayStr(20), description: 'AMERICAN EXPRESS PAYMENT', merchantId: null, merchantName: null, amount: -repay, type: 'PAYMENT', categoryGroup: null }));
      out.push(tx({ id: `demo_${p.start}_${n++}`, accountId: 'acc_amex', date: dayStr(21), description: 'PAYMENT RECEIVED - THANK YOU', merchantId: null, merchantName: null, amount: repay, type: 'PAYMENT', categoryGroup: null }));
    }
    if (lastDay >= 9) {
      out.push(tx({ id: `demo_${p.start}_${n++}`, accountId: 'acc_everyday', date: dayStr(9), description: 'TRANSFER TO ONLINE SAVER', merchantId: null, merchantName: null, amount: -500, type: 'TRANSFER', categoryGroup: null }));
    }
    if (offset === 0 && lastDay >= 6) {
      out.push(tx({ id: `demo_${p.start}_${n++}`, accountId: 'acc_amex', date: dayStr(lastDay - 1), description: 'KMART REFUND', merchantId: 'kmart', merchantName: 'Kmart', amount: 34.0, type: 'CREDIT CARD', categoryGroup: 'Household' }));
      out.push(tx({ id: `demo_pending_1`, accountId: 'acc_amex', date: dayStr(lastDay), description: 'WOOLWORTHS PONSONBY', merchantId: null, merchantName: null, amount: -187.35, type: 'CREDIT CARD', categoryGroup: null, pending: true }));
    }
  }
  return { accounts: ACCOUNTS, transactions: out };
}
