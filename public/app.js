const $ = (id) => document.getElementById(id);
const nzd = new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' });
const nzd0 = new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD', maximumFractionDigits: 0 });
const money = (n) => nzd.format(n);

let state = null;
let filter = 'counted';
let activeTx = null;

/** Build DOM nodes without innerHTML, so bank text can never inject markup. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error('Signed out');
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ---- auth -----------------------------------------------------------------

function showLogin() {
  $('app').hidden = true;
  $('login').hidden = false;
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  $('login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { username: form.get('username'), password: form.get('password') } });
    e.target.reset();
    await start();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
  showLogin();
});

// ---- rendering ------------------------------------------------------------

const fmtDay = (iso, opts) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-NZ', opts);

function render(s) {
  state = s;
  const last = new Date(Date.parse(s.period.end) - 86_400_000).toISOString().slice(0, 10);
  $('period-label').textContent = `${fmtDay(s.period.start, { day: 'numeric', month: 'short' })} to ${fmtDay(last, { day: 'numeric', month: 'short' })}`;
  $('updated').textContent = `Updated ${new Date(s.fetchedAt).toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' })}`;
  $('demo-banner').hidden = !s.demo;

  const over = s.available < 0;
  $('available').textContent = over ? `-${money(-s.available)}` : money(s.available);
  $('available').classList.toggle('over', over);
  $('of-budget').textContent = over ? `Over the ${nzd0.format(s.budget)} budget` : `left of ${nzd0.format(s.budget)}`;

  const pct = Math.min(100, (s.spent / s.budget) * 100);
  const pacePct = (s.period.daysElapsed / s.period.daysTotal) * 100;
  $('bar-fill').style.width = `${Math.max(0, pct)}%`;
  $('bar-fill').className = `bar-fill ${s.status}`;
  $('bar-marker').style.left = `${pacePct}%`;
  $('bar-label').setAttribute('aria-label', `${Math.round(pct)}% of budget spent, ${Math.round(pacePct)}% of the month gone`);
  $('spent-label').textContent = `${money(s.spent)} spent`;
  $('pace-label').textContent = `Day ${s.period.daysElapsed} of ${s.period.daysTotal}`;

  $('daily').textContent = money(s.dailyAllowance);
  $('daily-label').textContent = `a day for the next ${s.period.daysLeft} day${s.period.daysLeft === 1 ? '' : 's'}`;
  $('projected').textContent = s.period.daysElapsed >= 5 ? nzd0.format(s.projected) : 'Too early';

  const gap = Math.abs(s.spent - s.expectedByNow);
  $('status').textContent = {
    'on-track': `On track. ${nzd0.format(gap)} under where an even pace would put you.`,
    'ahead-of-pace': `Running ${nzd0.format(gap)} ahead of an even pace. Still inside the budget.`,
    over: `Over budget by ${money(-s.available)}.`,
  }[s.status];

  $('pending-note').hidden = !s.pendingSpent;
  $('pending-note').textContent = `Includes ${money(s.pendingSpent)} still pending with the bank.`;

  renderMerchants(s);
  renderTransactions();
}

function renderMerchants(s) {
  const max = s.topMerchants[0]?.total || 1;
  $('merchants').replaceChildren(
    ...(s.topMerchants.length ? s.topMerchants.map((m) => {
      const fill = h('div');
      fill.style.width = `${(m.total / max) * 100}%`;
      return h('li', {},
        h('span', {}, m.name, h('span', { class: 'muted small' }, ` · ${m.count}×`)),
        h('strong', {}, money(m.total)),
        h('div', { class: 'm-bar' }, fill));
    }) : [h('li', { class: 'empty' }, 'Nothing spent yet this month.')]),
  );
}

function renderTransactions() {
  const list = state.transactions.filter((t) => (filter === 'all' ? true : filter === 'counted' ? t.counted : !t.counted));
  const nodes = [];
  let lastDate = null;
  for (const t of list) {
    if (t.date !== lastDate) {
      lastDate = t.date;
      nodes.push(h('li', { class: 'day' }, fmtDay(t.date, { weekday: 'short', day: 'numeric', month: 'short' })));
    }
    const name = t.merchantName || t.description;
    const youChip = t.source !== 'auto' ? h('span', { class: 'chip you' }, 'rule') : null;
    nodes.push(h('li', {}, h('button', { class: `tx ${t.counted ? '' : 'excluded'}`, onclick: () => openTx(t) },
      h('span', { class: 'tx-name' }, name),
      h('span', { class: `tx-amt ${t.amount > 0 ? 'credit' : ''}` }, t.amount > 0 ? `+${money(t.amount)}` : money(-t.amount)),
      h('span', { class: 'tx-meta' }, t.accountName, t.pending ? h('span', { class: 'chip' }, 'pending') : null,
        t.counted && t.reason === 'Counted' ? null : h('span', { class: 'chip' }, t.reason), youChip),
    )));
  }
  if (!nodes.length) nodes.push(h('li', { class: 'empty' }, filter === 'excluded' ? 'Nothing excluded this month.' : 'No transactions yet.'));
  $('tx-list').replaceChildren(...nodes);
}

document.querySelectorAll('.tabs button').forEach((btn) => btn.addEventListener('click', () => {
  filter = btn.dataset.filter;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
  renderTransactions();
}));

// ---- transaction actions --------------------------------------------------

function openTx(t) {
  activeTx = t;
  const name = t.merchantName || t.description;
  $('tx-title').textContent = `${name}  ${t.amount > 0 ? '+' : ''}${money(Math.abs(t.amount))}`;
  $('tx-meta').textContent = `${fmtDay(t.date, { weekday: 'long', day: 'numeric', month: 'long' })} · ${t.accountName}${t.description !== name ? ` · ${t.description}` : ''}`;
  $('tx-reason').textContent = t.counted ? `Counts toward the budget. ${t.reason === 'Counted' ? '' : t.reason}` : `Not counted: ${t.reason}.`;

  const act = (label, fn) => h('button', { type: 'button', onclick: async () => { await fn(); $('tx-dialog').close(); } }, label);
  const override = (mode) => () => update('/api/override', { txId: t.id, mode });
  const rule = (mode) => () => update('/api/merchant-rule', { key: t.merchantKey, name, mode });

  const buttons = [];
  if (t.override) buttons.push(act('Undo my change to this one', override(null)));
  else if (t.counted) buttons.push(act('Don’t count this one', override('exclude')));
  else buttons.push(act('Count this one', override('include')));

  if (t.merchantRule) buttons.push(act(`Remove rule for ${name}`, rule(null)));
  else {
    buttons.push(act(`Never count ${name}`, rule('exclude')));
    buttons.push(act(`Always count ${name}`, rule('include')));
  }
  $('tx-actions').replaceChildren(...buttons);
  $('tx-dialog').showModal();
}

async function update(path, body) {
  try {
    render(await api(path, { method: 'POST', body }));
  } catch (err) {
    alert(err.message);
  }
}

// ---- settings -------------------------------------------------------------

$('open-settings').addEventListener('click', () => {
  const f = $('settings-form');
  f.budget.value = state.settings.budget;
  f.monthStartDay.value = state.settings.monthStartDay;
  $('account-list').replaceChildren(...state.accounts.map((a) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', name: 'account', value: a.id, checked: a.tracked }),
    h('span', {}, `${a.name} `, h('span', { class: 'muted small' }, `${a.institution} · ${a.type.toLowerCase()}`)))));

  const rules = Object.entries(state.settings.merchantRules);
  $('rule-list').replaceChildren(...(rules.length ? rules.map(([key, r]) => h('div', { class: 'rule' },
    h('span', {}, `${r.mode === 'include' ? 'Always count' : 'Never count'} ${r.name || key}`),
    h('button', { type: 'button', class: 'link', onclick: async (e) => { await update('/api/merchant-rule', { key, mode: null }); e.target.closest('.rule').remove(); } }, 'Remove'),
  )) : ['None yet. Add them by tapping a transaction.']));
  $('settings-error').textContent = '';
  $('settings-dialog').showModal();
});
$('close-settings').addEventListener('click', () => $('settings-dialog').close());

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const trackedAccounts = [...f.querySelectorAll('input[name=account]:checked')].map((i) => i.value);
  try {
    render(await api('/api/settings', {
      method: 'PUT',
      body: { budget: Number(f.budget.value), monthStartDay: Number(f.monthStartDay.value), trackedAccounts },
    }));
    $('settings-dialog').close();
  } catch (err) {
    $('settings-error').textContent = err.message;
  }
});

// ---- boot -----------------------------------------------------------------

async function load(refresh = false) {
  $('refresh').disabled = true;
  try {
    render(await api(`/api/summary${refresh ? '?refresh=1' : ''}`));
  } catch (err) {
    if (err.message !== 'Signed out') $('updated').textContent = err.message;
  } finally {
    $('refresh').disabled = false;
  }
}
$('refresh').addEventListener('click', () => load(true));

async function start() {
  const me = await api('/api/me');
  $('whoami').textContent = `Signed in as ${me.username}`;
  $('login').hidden = true;
  $('app').hidden = false;
  await load();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state) load();
});

start().catch(() => showLogin());
