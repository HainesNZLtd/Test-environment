import {
  acceptInvite, getUser, handleAuthCallback, login, logout,
  refreshSession, requestPasswordRecovery, updateUser,
} from '@netlify/identity';

const $ = (id) => document.getElementById(id);
const nzd = new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' });
const nzd0 = new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD', maximumFractionDigits: 0 });
const money = (n) => (n < 0 ? `-${nzd.format(-n)}` : nzd.format(n));

let state = null;
let offset = 0;
let editing = null; // entry being edited, or null for a new one
let pendingReceiptId = null;
let passwordMode = null; // { kind: 'invite', token } | { kind: 'recovery' }

/** Build DOM nodes without innerHTML, so typed or receipt text can never inject markup. */
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

const errorText = (err) => (err && err.message ? err.message : 'Something went wrong. Try again.');

// ---- API --------------------------------------------------------------------

async function api(path, { method = 'GET', body, raw, contentType } = {}, retried = false) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (raw) headers['Content-Type'] = contentType;
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    body: raw || (body !== undefined ? JSON.stringify(body) : undefined),
  });
  if (res.status === 401 && !retried) {
    // Access tokens are short-lived; refresh once before giving up.
    await refreshSession().catch(() => null);
    return api(path, { method, body, raw, contentType }, true);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showAuth('login-form');
    throw new Error('Please sign in');
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ---- auth screens -------------------------------------------------------------

function showAuth(view, message) {
  $('app').hidden = true;
  $('auth').hidden = false;
  document.querySelectorAll('.auth-view').forEach((f) => { f.hidden = f.id !== view; });
  const form = $(view);
  form.querySelector('.error').textContent = message || '';
  const ok = form.querySelector('.ok');
  if (ok) ok.textContent = '';
  form.querySelector('input')?.focus();
}

document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => showAuth(b.dataset.view)));

async function withBusy(form, fn) {
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  form.querySelector('.error').textContent = '';
  try { await fn(); } catch (err) { form.querySelector('.error').textContent = errorText(err); } finally { btn.disabled = false; }
}

$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  withBusy(f, async () => {
    try {
      await login(f.email.value.trim(), f.password.value);
    } catch {
      throw new Error('That email and password don’t match.');
    }
    f.reset();
    await startApp();
  });
});

$('forgot-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  withBusy(f, async () => {
    await requestPasswordRecovery(f.email.value.trim()).catch(() => {});
    // Same message either way, so the form can't be used to discover who has an account.
    f.querySelector('.ok').textContent = 'If that email has an account, a reset link is on its way. Check your inbox.';
  });
});

$('password-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  withBusy(f, async () => {
    if (f.password.value !== f.confirm.value) throw new Error('The two passwords don’t match.');
    if (passwordMode?.kind === 'invite') await acceptInvite(passwordMode.token, f.password.value);
    else await updateUser({ password: f.password.value });
    passwordMode = null;
    f.reset();
    await startApp();
  });
});

function showPasswordForm(mode) {
  passwordMode = mode;
  $('password-intro').textContent = mode.kind === 'invite'
    ? 'Welcome. Choose a password to finish setting up your account.'
    : 'Choose a new password.';
  showAuth('password-form');
}

$('logout').addEventListener('click', async () => {
  await logout().catch(() => {});
  state = null;
  showAuth('login-form');
});

// ---- dashboard ----------------------------------------------------------------

const fmtDay = (iso, opts) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-NZ', opts);

function periodTitle(p) {
  const last = new Date(Date.parse(p.end) - 86_400_000).toISOString().slice(0, 10);
  if (p.start.endsWith('-01')) return { title: fmtDay(p.start, { month: 'long', year: 'numeric' }), sub: '' };
  return {
    title: `${fmtDay(p.start, { day: 'numeric', month: 'short' })} – ${fmtDay(last, { day: 'numeric', month: 'short' })}`,
    sub: fmtDay(last, { year: 'numeric' }),
  };
}

function render(s) {
  state = s;
  const { title, sub } = periodTitle(s.period);
  $('period-label').textContent = title;
  $('period-sub').textContent = s.isCurrent ? (sub ? `${sub} · this month` : 'This month') : sub;
  $('next-month').disabled = s.isCurrent;
  $('whoami').textContent = `Signed in as ${s.user.name}`;
  $('add-row').hidden = !s.isCurrent;

  const over = s.available < 0;
  $('hero-label').textContent = s.isCurrent ? 'Available this month' : (over ? 'Went over by' : 'Left over');
  $('available').textContent = over ? money(-s.available) : money(s.available);
  $('available').classList.toggle('over', over);
  $('of-budget').textContent = s.isCurrent
    ? (over ? `Over the ${nzd0.format(s.budget)} budget` : `left of ${nzd0.format(s.budget)}`)
    : `${money(s.spent)} spent of ${nzd0.format(s.budget)}`;

  const pct = Math.min(100, Math.max(0, (s.spent / s.budget) * 100));
  const pacePct = (s.period.daysElapsed / s.period.daysTotal) * 100;
  $('bar-fill').style.width = `${pct}%`;
  $('bar-fill').className = `bar-fill ${s.status}`;
  $('bar-marker').hidden = !s.isCurrent;
  $('bar-marker').style.left = `${pacePct}%`;
  $('bar-label').setAttribute('aria-label', `${Math.round(pct)}% of budget spent`);
  $('spent-label').textContent = `${money(s.spent)} spent`;
  $('pace-label').textContent = s.isCurrent ? `Day ${s.period.daysElapsed} of ${s.period.daysTotal}` : '';

  $('stats').hidden = !s.isCurrent;
  $('daily').textContent = money(s.dailyAllowance);
  $('daily-label').textContent = `a day for the next ${s.period.daysLeft} day${s.period.daysLeft === 1 ? '' : 's'}`;
  $('projected').textContent = s.period.daysElapsed >= 5 ? nzd0.format(s.projected) : 'Too early';

  const gap = Math.abs(s.spent - s.expectedByNow);
  $('status').hidden = !s.isCurrent;
  $('status').textContent = {
    'on-track': `On track: ${nzd0.format(gap)} under an even pace.`,
    'ahead-of-pace': `Running ${nzd0.format(gap)} ahead of an even pace. Still inside the budget.`,
    over: `Over budget by ${money(-s.available)}.`,
  }[s.status];

  const mini = (items) => (items.length
    ? items.map((i) => h('li', {}, h('span', {}, i.name), h('span', {}, money(i.total))))
    : [h('li', { class: 'muted' }, 'Nothing yet')]);
  $('by-category').replaceChildren(...mini(s.byCategory));
  $('by-person').replaceChildren(...mini(s.byPerson));

  renderEntries(s.entries);
}

function renderEntries(entries) {
  const nodes = [];
  let lastDate = null;
  for (const e of entries) {
    if (e.date !== lastDate) {
      lastDate = e.date;
      nodes.push(h('li', { class: 'day' }, fmtDay(e.date, { weekday: 'short', day: 'numeric', month: 'short' })));
    }
    nodes.push(h('li', {}, h('button', { class: 'tx', onclick: () => openEntry(e) },
      h('span', { class: 'tx-name' }, e.merchant),
      h('span', { class: `tx-amt ${e.amount < 0 ? 'credit' : ''}` }, e.amount < 0 ? `+${nzd.format(-e.amount)}` : nzd.format(e.amount)),
      h('span', { class: 'tx-meta' },
        h('span', { class: 'tx-who', title: e.createdByName }, (e.createdByName || '?').slice(0, 1).toUpperCase()),
        e.category,
        e.note ? ` · ${e.note}` : '',
        e.receiptId ? h('span', { class: 'chip' }, 'receipt') : null,
        e.amount < 0 ? h('span', { class: 'chip' }, 'refund') : null),
    )));
  }
  if (!nodes.length) nodes.push(h('li', { class: 'empty' }, 'Nothing added yet.'));
  $('tx-list').replaceChildren(...nodes);
}

async function load() {
  try {
    render(await api(`/api/summary?offset=${offset}`));
  } catch (err) {
    if ($('app').hidden === false) $('period-sub').textContent = errorText(err);
  }
}

$('prev-month').addEventListener('click', () => { offset -= 1; load(); });
$('next-month').addEventListener('click', () => { if (offset < 0) { offset += 1; load(); } });

// ---- add / edit entries ----------------------------------------------------------

const entryForm = $('entry-form');

function resetEntryForm() {
  entryForm.reset();
  entryForm.querySelector('.error').textContent = '';
  entryForm.date.value = state?.today || new Date().toISOString().slice(0, 10);
  entryForm.date.max = state?.today || '';
  $('reading').hidden = true;
  $('read-note').hidden = true;
  $('receipt-preview').hidden = true;
  $('receipt-preview').removeAttribute('src');
  $('entry-delete').hidden = true;
  $('entry-delete').dataset.armed = '';
  $('entry-delete').textContent = 'Delete';
  $('entry-save').disabled = false;
  pendingReceiptId = null;
  editing = null;
}

function setCategory(value) {
  entryForm.querySelectorAll('input[name=category]').forEach((r) => { r.checked = r.value === value; });
}

async function showReceipt(receiptId) {
  try {
    const res = await fetch(`/api/receipts/${receiptId}`, { credentials: 'same-origin' });
    if (!res.ok) return;
    $('receipt-preview').src = URL.createObjectURL(await res.blob());
    $('receipt-preview').hidden = false;
  } catch { /* photo is optional */ }
}

function openEntry(e) {
  resetEntryForm();
  editing = e;
  $('entry-title').textContent = 'Edit spending';
  entryForm.amount.value = e.amount.toFixed(2);
  entryForm.merchant.value = e.merchant;
  entryForm.date.value = e.date;
  entryForm.note.value = e.note || '';
  setCategory(e.category);
  if (e.receiptId) showReceipt(e.receiptId);
  $('entry-delete').hidden = false;
  $('entry-dialog').showModal();
}

$('add-manual').addEventListener('click', () => {
  resetEntryForm();
  $('entry-title').textContent = 'Add spending';
  $('entry-dialog').showModal();
  entryForm.amount.focus();
});

$('entry-cancel').addEventListener('click', () => $('entry-dialog').close());

entryForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  withBusy(entryForm, async () => {
    const body = {
      amount: Number(entryForm.amount.value),
      merchant: entryForm.merchant.value,
      category: entryForm.querySelector('input[name=category]:checked')?.value || 'Misc',
      date: entryForm.date.value,
      note: entryForm.note.value,
      receiptId: pendingReceiptId || editing?.receiptId || null,
    };
    if (editing) await api(`/api/entries/${encodeURIComponent(editing.id)}`, { method: 'PUT', body });
    else await api('/api/entries', { method: 'POST', body });
    $('entry-dialog').close();
    offset = 0;
    await load();
  });
});

// Two taps to delete, in the page itself (no browser pop-up).
$('entry-delete').addEventListener('click', async () => {
  const btn = $('entry-delete');
  if (!editing) return;
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = `Tap again to delete ${nzd.format(editing.amount)}`;
    return;
  }
  try {
    await api(`/api/entries/${encodeURIComponent(editing.id)}`, { method: 'DELETE' });
    $('entry-dialog').close();
    await load();
  } catch (err) {
    entryForm.querySelector('.error').textContent = errorText(err);
  }
});

// ---- receipt capture ------------------------------------------------------------------

/** Shrink phone photos to something quick to upload and plenty for reading text. */
async function prepareImage(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process photo'))), 'image/jpeg', 0.85));
}

$('receipt-input').addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file) return;

  resetEntryForm();
  $('entry-title').textContent = 'Add from receipt';
  $('reading').hidden = false;
  $('entry-save').disabled = true;
  $('entry-dialog').showModal();

  try {
    const blob = await prepareImage(file);
    $('receipt-preview').src = URL.createObjectURL(blob);
    $('receipt-preview').hidden = false;
    const { receiptId, extracted, readError } = await api('/api/receipts', { method: 'POST', raw: blob, contentType: 'image/jpeg' });
    pendingReceiptId = receiptId;
    const note = $('read-note');
    note.hidden = false;
    if (extracted?.isReceipt && extracted.total != null) {
      entryForm.amount.value = extracted.total.toFixed(2);
      entryForm.merchant.value = extracted.merchant;
      entryForm.date.value = extracted.date;
      entryForm.note.value = extracted.note;
      setCategory(extracted.category);
      note.textContent = 'Check the details, then save.';
    } else {
      note.textContent = readError || 'That doesn’t look like a receipt we can read. Fill in the details by hand.';
    }
  } catch (err) {
    entryForm.querySelector('.error').textContent = `${errorText(err)} You can still enter it by hand.`;
  } finally {
    $('reading').hidden = true;
    $('entry-save').disabled = false;
  }
});

// ---- settings ----------------------------------------------------------------------

$('open-settings').addEventListener('click', () => {
  const f = $('settings-form');
  f.budget.value = state.settings.budget;
  f.monthStartDay.value = state.settings.monthStartDay;
  f.querySelector('.error').textContent = '';
  $('settings-dialog').showModal();
});
$('settings-cancel').addEventListener('click', () => $('settings-dialog').close());
$('settings-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const f = ev.target;
  withBusy(f, async () => {
    offset = 0;
    render(await api('/api/settings', { method: 'PUT', body: { budget: Number(f.budget.value), monthStartDay: Number(f.monthStartDay.value) } }));
    $('settings-dialog').close();
  });
});

// ---- boot ---------------------------------------------------------------------------

async function startApp() {
  $('auth').hidden = true;
  $('app').hidden = false;
  offset = 0;
  await load();
}

document.addEventListener('visibilitychange', () => {
  // Pick up what the other person added while the app was in the background.
  if (document.visibilityState === 'visible' && state && !$('entry-dialog').open) load();
});

async function boot() {
  try {
    const result = await handleAuthCallback();
    if (result?.type === 'invite' && result.token) return showPasswordForm({ kind: 'invite', token: result.token });
    if (result?.type === 'recovery') return showPasswordForm({ kind: 'recovery' });
  } catch {
    return showAuth('login-form', 'That link has expired or was already used. Sign in, or ask for a new link.');
  }
  const user = await getUser();
  if (user) await startApp();
  else showAuth('login-form');
}

boot();
