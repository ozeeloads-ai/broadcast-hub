// ---------- helpers ----------

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка запроса (${res.status})`);
  return data;
}

function show(el) { el.style.display = 'block'; }
function hide(el) { el.style.display = 'none'; }

function flash(el, message, isError = false) {
  el.textContent = message;
  el.style.display = 'block';
  if (!isError) setTimeout(() => (el.style.display = 'none'), 4000);
}

// ---------- auth / tabs ----------

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  window.location.href = '/';
});

let currentUser = { email: '', isAdmin: false };

(async function initUser() {
  try {
    const me = await api('/api/auth/me');
    if (!me.authenticated) return (window.location.href = '/');
    currentUser = { email: me.email, isAdmin: !!me.isAdmin };
    document.getElementById('whoami').textContent = me.email;
    if (currentUser.isAdmin) {
      document.getElementById('adminTabBtn').style.display = '';
      document.getElementById('brokerAdminActions').style.display = '';
      await refreshUsers();
    }
  } catch {
    window.location.href = '/';
  }
})();

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ---------- collapsible cards ----------

function setupCollapsible(headerId, bodyId, hintId) {
  const header = document.getElementById(headerId);
  const body = document.getElementById(bodyId);
  const hint = document.getElementById(hintId);
  if (!header || !body || !hint) return;
  header.addEventListener('click', () => {
    const collapsed = body.classList.toggle('collapsed');
    hint.textContent = collapsed ? 'Показать ▾' : 'Скрыть ▴';
  });
}

setupCollapsible('groupsCardToggle', 'groupsCardBody', 'groupsCardToggleHint');
setupCollapsible('mailCardToggle', 'mailCardBody', 'mailCardToggleHint');

// ---------- US time zone clocks ----------

function formatZoneMoment(date, tz) {
  const timeParts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);

  const hour = timeParts.find((p) => p.type === 'hour')?.value || '--';
  const minute = timeParts.find((p) => p.type === 'minute')?.value || '--';
  const ampm = (timeParts.find((p) => p.type === 'dayPeriod')?.value || '').toUpperCase();

  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).formatToParts(date);

  const weekday = dateParts.find((p) => p.type === 'weekday')?.value || '';
  const month = dateParts.find((p) => p.type === 'month')?.value || '';
  const day = dateParts.find((p) => p.type === 'day')?.value || '';

  return { hm: `${hour}:${minute}`, ampm, dateLabel: `${weekday} ${month} ${day}`.toUpperCase() };
}

function updateTimeZoneClocks() {
  const now = new Date();

  document.querySelectorAll('.tz-card').forEach((card) => {
    const moment = formatZoneMoment(now, card.dataset.tz);
    card.querySelector('.tz-hm').textContent = moment.hm;
    card.querySelector('.tz-ampm').textContent = moment.ampm;
    card.querySelector('.tz-date').textContent = moment.dateLabel;
  });

  document.querySelectorAll('.tz-pro-card').forEach((card) => {
    const tz = card.dataset.tz;
    card.querySelectorAll('.tz-pro-row').forEach((row) => {
      const offsetHours = Number(row.dataset.offset) || 0;
      const future = new Date(now.getTime() + offsetHours * 60 * 60 * 1000);
      const moment = formatZoneMoment(future, tz);
      row.querySelector('.tz-pro-time').textContent = `${moment.hm} ${moment.ampm}`;
      row.querySelector('.tz-pro-date').textContent = moment.dateLabel;
    });
  });
}

updateTimeZoneClocks();
setInterval(updateTimeZoneClocks, 1000);

// ================= TG SENDER =================

let groups = [];
let sentMessages = [];
let pendingLoginToken = null;

async function refreshTgStatus() {
  const status = await api('/api/telegram/status');
  if (status.connected) {
    document.getElementById('tgAccountName').textContent = `${status.displayName} (${status.phone})`;
    document.getElementById('tgSignature').value = status.signature || '';
    show(document.getElementById('tgConnectedBlock'));
    hide(document.getElementById('tgLoginBlock'));
  } else {
    hide(document.getElementById('tgConnectedBlock'));
    show(document.getElementById('tgLoginBlock'));
  }
}

document.getElementById('tgSignatureSaveBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('tgError');
  hide(errEl);
  try {
    await api('/api/telegram/signature', {
      method: 'POST',
      body: JSON.stringify({ signature: document.getElementById('tgSignature').value }),
    });
    flash(document.getElementById('tgSuccess'), 'Подпись сохранена.');
  } catch (err) {
    flash(errEl, err.message, true);
  }
});

document.getElementById('tgSendCodeBtn').addEventListener('click', async () => {
  const phone = document.getElementById('tgPhone').value.trim();
  const errEl = document.getElementById('tgError');
  hide(errEl);
  try {
    const result = await api('/api/telegram/login/start', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    });
    pendingLoginToken = result.token;
    document.getElementById('tgStepPhone').style.display = 'none';
    show(document.getElementById('tgStepCode'));
    flash(document.getElementById('tgSuccess'), 'Код отправлен в Telegram.');
  } catch (err) {
    flash(errEl, err.message, true);
  }
});

document.getElementById('tgVerifyCodeBtn').addEventListener('click', async () => {
  const code = document.getElementById('tgCode').value.trim();
  const errEl = document.getElementById('tgError');
  hide(errEl);
  try {
    const result = await api('/api/telegram/login/code', {
      method: 'POST',
      body: JSON.stringify({ token: pendingLoginToken, code }),
    });
    if (result.needsPassword) {
      document.getElementById('tgStepCode').style.display = 'none';
      show(document.getElementById('tgStepPassword'));
      return;
    }
    flash(document.getElementById('tgSuccess'), 'Telegram подключён!');
    await refreshTgStatus();
    await refreshGroups();
  } catch (err) {
    flash(errEl, err.message, true);
  }
});

document.getElementById('tgVerifyPasswordBtn').addEventListener('click', async () => {
  const password = document.getElementById('tgPassword').value;
  const errEl = document.getElementById('tgError');
  hide(errEl);
  try {
    await api('/api/telegram/login/password', {
      method: 'POST',
      body: JSON.stringify({ token: pendingLoginToken, password }),
    });
    flash(document.getElementById('tgSuccess'), 'Telegram подключён!');
    await refreshTgStatus();
    await refreshGroups();
  } catch (err) {
    flash(errEl, err.message, true);
  }
});

document.getElementById('tgDisconnectBtn').addEventListener('click', async () => {
  await api('/api/telegram/disconnect', { method: 'POST' });
  await refreshTgStatus();
});

async function refreshGroups() {
  groups = await api('/api/telegram/groups');
  const tbody = document.getElementById('groupsTableBody');
  tbody.innerHTML = '';
  document.getElementById('groupsEmptyMsg').style.display = groups.length ? 'none' : 'block';

  for (const g of groups) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="checkbox-cell"><input type="checkbox" class="group-checkbox" value="${g.id}" /></td>
      <td>${escapeHtml(g.title || '(без названия)')}</td>
      <td>${g.peer_type === 'channel' ? 'Канал/супергруппа' : 'Группа'}</td>
      <td>${g.added_at}</td>
      <td><button class="btn-secondary remove-group-btn" data-id="${g.id}">Удалить</button></td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('.remove-group-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/telegram/groups/${btn.dataset.id}`, { method: 'DELETE' });
      await refreshGroups();
    });
  });

  renderCapListGroups();
}

document.getElementById('addGroupBtn').addEventListener('click', async () => {
  const identifier = document.getElementById('groupIdentifier').value.trim();
  const errEl = document.getElementById('tgError');
  hide(errEl);
  if (!identifier) return;
  try {
    await api('/api/telegram/groups', { method: 'POST', body: JSON.stringify({ identifier }) });
    document.getElementById('groupIdentifier').value = '';
    await refreshGroups();
  } catch (err) {
    flash(errEl, err.message, true);
  }
});

document.getElementById('selectAllGroups').addEventListener('change', (e) => {
  document.querySelectorAll('.group-checkbox').forEach((cb) => (cb.checked = e.target.checked));
});

// ---------- Telegram dialogs picker (browse existing chats) ----------

let dialogsKind = 'groups';
let allDialogs = [];

function setDialogsKind(kind) {
  dialogsKind = kind;
  document.getElementById('dialogsKindGroups').classList.toggle('active', kind === 'groups');
  document.getElementById('dialogsKindPrivate').classList.toggle('active', kind === 'private');
  loadDialogs();
}

async function loadDialogs() {
  const errEl = document.getElementById('dialogsError');
  const okEl = document.getElementById('dialogsSuccess');
  hide(errEl); hide(okEl);
  const btn = document.getElementById('refreshDialogsBtn');
  btn.disabled = true;
  try {
    allDialogs = await api(`/api/telegram/dialogs?kind=${dialogsKind}`);
    document.getElementById('dialogsSearch').value = '';
    renderDialogsList();
  } catch (err) {
    allDialogs = [];
    renderDialogsList();
    flash(errEl, err.message, true);
  } finally {
    btn.disabled = false;
  }
}

function renderDialogsList() {
  const search = document.getElementById('dialogsSearch').value.trim().toLowerCase();
  const listEl = document.getElementById('dialogsList');
  const emptyEl = document.getElementById('dialogsEmptyMsg');
  const countEl = document.getElementById('dialogsFoundCount');

  const filtered = search
    ? allDialogs.filter((d) => (d.title || '').toLowerCase().includes(search))
    : allDialogs;

  listEl.innerHTML = '';

  if (!allDialogs.length) {
    emptyEl.textContent = 'Ничего не загружено. Нажмите «Обновить список», чтобы загрузить чаты из вашего Telegram.';
    show(emptyEl);
    hide(countEl);
    return;
  }

  countEl.textContent = `Найдено: ${filtered.length} из ${allDialogs.length}`;
  show(countEl);

  if (!filtered.length) {
    emptyEl.textContent = 'Ничего не найдено по вашему запросу.';
    show(emptyEl);
    return;
  }
  hide(emptyEl);

  for (const d of filtered) {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" class="dialog-checkbox" value="${d.id}" /><span>${escapeHtml(d.title || '(без названия)')}</span>`;
    listEl.appendChild(label);
  }
}

document.getElementById('dialogsKindGroups').addEventListener('click', () => setDialogsKind('groups'));
document.getElementById('dialogsKindPrivate').addEventListener('click', () => setDialogsKind('private'));
document.getElementById('refreshDialogsBtn').addEventListener('click', loadDialogs);
document.getElementById('dialogsSearch').addEventListener('input', renderDialogsList);

document.getElementById('selectAllDialogsBtn').addEventListener('click', () => {
  document.querySelectorAll('.dialog-checkbox').forEach((cb) => (cb.checked = true));
});

document.getElementById('importDialogsBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('dialogsError');
  const okEl = document.getElementById('dialogsSuccess');
  hide(errEl); hide(okEl);
  const ids = [...document.querySelectorAll('.dialog-checkbox:checked')].map((cb) => cb.value);
  if (!ids.length) return flash(errEl, 'Выберите хотя бы один чат.', true);
  try {
    const { results } = await api('/api/telegram/dialogs/import', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
    const failed = results.filter((r) => !r.ok);
    const okCount = results.length - failed.length;
    if (failed.length) {
      flash(errEl, `Добавлено: ${okCount}. Ошибки: ${failed.map((f) => f.error).join('; ')}`, true);
    } else {
      flash(okEl, `Добавлено чатов: ${okCount}. Их можно найти в разделе «Группы (управление вручную)».`);
    }
    await refreshGroups();
  } catch (err) {
    flash(errEl, err.message, true);
  }
});

document.getElementById('selectAllGroupsSendBtn').addEventListener('click', () => {
  document.querySelectorAll('.group-checkbox').forEach((cb) => (cb.checked = true));
  document.getElementById('selectAllGroups').checked = true;
});

function getSelectedGroupIds() {
  return [...document.querySelectorAll('.group-checkbox:checked')].map((cb) => Number(cb.value));
}

async function sendTg(groupIds) {
  const errEl = document.getElementById('sendError');
  const okEl = document.getElementById('sendSuccess');
  hide(errEl); hide(okEl);

  const text = document.getElementById('tgMessageText').value.trim();
  if (!text) return flash(errEl, 'Введите текст сообщения.', true);
  if (!groupIds.length) return flash(errEl, 'Выберите хотя бы одну группу.', true);

  const autoDeleteOn = document.getElementById('autoDeleteToggle').checked;
  const autoDeleteMinutes = autoDeleteOn ? Number(document.getElementById('autoDeleteMinutes').value || 15) : null;

  try {
    const { results } = await api('/api/telegram/send', {
      method: 'POST',
      body: JSON.stringify({ groupIds, text, autoDeleteMinutes }),
    });
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      flash(errEl, `Отправлено с ошибками: ${failed.map((f) => `${f.title}: ${f.error}`).join('; ')}`, true);
    } else {
      flash(okEl, `Отправлено в ${results.length} групп(у).`);
    }
    await refreshMessages();
  } catch (err) {
    flash(errEl, err.message, true);
  }
}

document.getElementById('sendToSelectedBtn').addEventListener('click', () => sendTg(getSelectedGroupIds()));
document.getElementById('sendToAllBtn').addEventListener('click', () => sendTg(groups.map((g) => g.id)));

async function refreshMessages() {
  sentMessages = await api('/api/telegram/messages');
  const tbody = document.getElementById('messagesTableBody');
  tbody.innerHTML = '';
  document.getElementById('messagesEmptyMsg').style.display = sentMessages.length ? 'none' : 'block';

  for (const m of sentMessages) {
    const status = m.deleted_at
      ? '<span class="badge deleted">удалено</span>'
      : m.auto_delete_at
      ? `<span class="badge scheduled">авто-удаление ${new Date(m.auto_delete_at).toLocaleTimeString()}</span>`
      : '<span class="badge">активно</span>';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="checkbox-cell">${m.deleted_at ? '' : `<input type="checkbox" class="message-checkbox" value="${m.id}" />`}</td>
      <td>${escapeHtml(m.title || '')}</td>
      <td>${escapeHtml((m.text || '').slice(0, 80))}</td>
      <td>${m.sent_at}</td>
      <td>${status}</td>
    `;
    tbody.appendChild(tr);
  }
}

document.getElementById('refreshMessagesBtn').addEventListener('click', refreshMessages);

document.getElementById('selectAllMessagesHeader').addEventListener('change', (e) => {
  document.querySelectorAll('.message-checkbox').forEach((cb) => (cb.checked = e.target.checked));
});
document.getElementById('selectAllMessagesBtn').addEventListener('click', () => {
  document.querySelectorAll('.message-checkbox').forEach((cb) => (cb.checked = true));
});

document.getElementById('deleteSelectedMessagesBtn').addEventListener('click', async () => {
  const ids = [...document.querySelectorAll('.message-checkbox:checked')].map((cb) => Number(cb.value));
  if (!ids.length) return;
  await api('/api/telegram/messages/delete', { method: 'POST', body: JSON.stringify({ messageDbIds: ids }) });
  await refreshMessages();
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ================= CAP LIST =================

let capListTemplateText = 'Please share updated cap list  TEAM , SOLO';
let capListKind = 'all'; // 'all' | 'team' | 'solo' | 'log'
let capListSearchTimer = null;

(async function loadCapListTemplate() {
  try {
    const { text } = await api('/api/telegram/caplist/template');
    capListTemplateText = text;
    document.getElementById('capListTemplateText').textContent = text;
  } catch {
    // fall back to the hard-coded default already shown in the HTML
  }
})();

function renderCapListGroups() {
  const listEl = document.getElementById('capListGroupsList');
  const emptyEl = document.getElementById('capListGroupsEmptyMsg');
  if (!listEl) return;
  listEl.innerHTML = '';
  emptyEl.style.display = groups.length ? 'none' : 'block';

  for (const g of groups) {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" class="caplist-group-checkbox" value="${g.id}" /><span>${escapeHtml(g.title || '(без названия)')}</span>`;
    listEl.appendChild(label);
  }
}

document.getElementById('capListSelectAllBtn').addEventListener('click', () => {
  document.querySelectorAll('.caplist-group-checkbox').forEach((cb) => (cb.checked = true));
});

async function requestCapList(groupIds) {
  const errEl = document.getElementById('capListRequestError');
  const okEl = document.getElementById('capListRequestSuccess');
  hide(errEl); hide(okEl);
  if (!groupIds.length) return flash(errEl, 'Выберите хотя бы одну группу.', true);

  try {
    const { results } = await api('/api/telegram/send', {
      method: 'POST',
      body: JSON.stringify({ groupIds, text: capListTemplateText, autoDeleteMinutes: null }),
    });
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      flash(errEl, `Отправлено с ошибками: ${failed.map((f) => `${f.title}: ${f.error}`).join('; ')}`, true);
    } else {
      flash(okEl, `Запрос cap list отправлен в ${results.length} групп(у).`);
    }
    await refreshCapListSentMessages();
  } catch (err) {
    flash(errEl, err.message, true);
  }
}

document.getElementById('capListRequestSelectedBtn').addEventListener('click', () => {
  const ids = [...document.querySelectorAll('.caplist-group-checkbox:checked')].map((cb) => Number(cb.value));
  requestCapList(ids);
});
document.getElementById('capListRequestAllBtn').addEventListener('click', () => {
  requestCapList(groups.map((g) => g.id));
});

function formatCapListLocation(entry) {
  return entry.city ? `${entry.city}, ${entry.state}` : entry.state;
}

async function loadCapList() {
  const kindParam = capListKind === 'team' || capListKind === 'solo' ? `kind=${capListKind}` : '';
  const search = document.getElementById('capListSearch').value.trim();
  const searchParam = search ? `search=${encodeURIComponent(search)}` : '';
  const query = [kindParam, searchParam].filter(Boolean).join('&');
  const endpoint = capListKind === 'log' ? '/api/telegram/caplist/log' : '/api/telegram/caplist';

  try {
    const { entries, counts } = await api(`${endpoint}${query ? '?' + query : ''}`);

    document.getElementById('capListCountAll').textContent = counts.all;
    document.getElementById('capListCountTeam').textContent = counts.team;
    document.getElementById('capListCountSolo').textContent = counts.solo;
    document.getElementById('capListCountLog').textContent = counts.log;

    const tbody = document.getElementById('capListTableBody');
    tbody.innerHTML = '';
    document.getElementById('capListEmptyMsg').style.display = entries.length ? 'none' : 'block';

    for (const entry of entries) {
      const tr = document.createElement('tr');
      const who = [entry.chat_title, entry.sender_name].filter(Boolean).join(' — ');
      tr.innerHTML = `
        <td>${escapeHtml(formatCapListLocation(entry))}</td>
        <td><span class="badge ${entry.truck_type === 'team' ? '' : 'scheduled'}">${entry.truck_type.toUpperCase()}</span></td>
        <td>${escapeHtml(who)}</td>
        <td>${entry.created_at}</td>
      `;
      tbody.appendChild(tr);
    }
  } catch (err) {
    flash(document.getElementById('capListRequestError'), err.message, true);
  }
}

document.querySelectorAll('#tab-caplist .tab-toggle-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    capListKind = btn.dataset.kind;
    document.querySelectorAll('#tab-caplist .tab-toggle-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    loadCapList();
  });
});

document.getElementById('capListRefreshBtn').addEventListener('click', loadCapList);
document.getElementById('capListClearBtn').addEventListener('click', async () => {
  if (!confirm('Очистить весь список и историю Cap List? Это действие необратимо.')) return;
  await api('/api/telegram/caplist/clear', { method: 'POST' });
  await loadCapList();
});
document.getElementById('capListSearch').addEventListener('input', () => {
  clearTimeout(capListSearchTimer);
  capListSearchTimer = setTimeout(loadCapList, 350);
});

// Keep the cap list showing fresh data on its own, without needing a manual
// "Обновить" click — picks up anything the passive live listener captures
// from new incoming group messages.
setInterval(loadCapList, 60 * 1000);

// ---- Cap List Puller (scans message history for the past 1-3 hours) ----

function formatClockTime(iso) {
  if (!iso) return null;
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString();
}

async function refreshPullStatus() {
  let status;
  try {
    status = await api('/api/telegram/caplist/pull/status');
  } catch {
    return;
  }
  const statusEl = document.getElementById('autopullStatus');
  if (status.lastPulledAt) {
    const when = formatClockTime(status.lastPulledAt);
    statusEl.textContent = `Последний пул: за ${status.lastHours} ч., в ${when}, найдено записей: ${status.lastFoundCount}.`;
  } else {
    statusEl.textContent = 'Пул ещё не запускался.';
  }
}

document.querySelectorAll('.autopull-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const errEl = document.getElementById('capListRequestError');
    const okEl = document.getElementById('capListRequestSuccess');
    hide(errEl); hide(okEl);
    btn.disabled = true;
    try {
      const result = await api('/api/telegram/caplist/pull', {
        method: 'POST',
        body: JSON.stringify({ hours: Number(btn.dataset.hours) }),
      });
      flash(okEl, `Просканировано за последние ${result.hours} ч., найдено новых записей: ${result.totalFound}.`);
      await refreshPullStatus();
      await loadCapList();
    } catch (err) {
      flash(errEl, err.message, true);
    } finally {
      btn.disabled = false;
    }
  });
});

// ---- Sent Cap List requests (from the "Запросить" buttons above) ----

async function refreshCapListSentMessages() {
  let all;
  try {
    all = await api('/api/telegram/messages');
  } catch {
    return;
  }
  const filtered = all.filter((m) => m.text && m.text.startsWith(capListTemplateText));
  const tbody = document.getElementById('capListSentTableBody');
  tbody.innerHTML = '';
  document.getElementById('capListSentEmptyMsg').style.display = filtered.length ? 'none' : 'block';

  for (const m of filtered) {
    const status = m.deleted_at
      ? '<span class="badge deleted">удалено</span>'
      : m.auto_delete_at
      ? `<span class="badge scheduled">авто-удаление ${new Date(m.auto_delete_at).toLocaleTimeString()}</span>`
      : '<span class="badge">активно</span>';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="checkbox-cell">${m.deleted_at ? '' : `<input type="checkbox" class="caplist-message-checkbox" value="${m.id}" />`}</td>
      <td>${escapeHtml(m.title || '')}</td>
      <td>${m.sent_at}</td>
      <td>${status}</td>
    `;
    tbody.appendChild(tr);
  }
}

document.getElementById('capListSentRefreshBtn').addEventListener('click', refreshCapListSentMessages);
document.getElementById('capListSentSelectAllBtn').addEventListener('click', () => {
  document.querySelectorAll('.caplist-message-checkbox').forEach((cb) => (cb.checked = true));
});
document.getElementById('capListSentSelectAllHeader').addEventListener('change', (e) => {
  document.querySelectorAll('.caplist-message-checkbox').forEach((cb) => (cb.checked = e.target.checked));
});
document.getElementById('capListSentDeleteBtn').addEventListener('click', async () => {
  const ids = [...document.querySelectorAll('.caplist-message-checkbox:checked')].map((cb) => Number(cb.value));
  if (!ids.length) return;
  await api('/api/telegram/messages/delete', { method: 'POST', body: JSON.stringify({ messageDbIds: ids }) });
  await refreshCapListSentMessages();
});

// ================= DISTANCE =================

let lastDistanceResult = null;

document.getElementById('distanceCalcBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('distanceError');
  const resultEl = document.getElementById('distanceResult');
  hide(errEl);
  hide(resultEl);

  const from = document.getElementById('distanceFrom').value.trim();
  const to = document.getElementById('distanceTo').value.trim();
  if (!from || !to) return flash(errEl, 'Укажите обе точки маршрута.', true);

  try {
    const result = await api('/api/distance/calculate', {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    });
    lastDistanceResult = result;

    document.getElementById('distanceFromLabel').textContent = result.fromLabel;
    document.getElementById('distanceToLabel').textContent = result.toLabel;
    document.getElementById('distanceMiles').textContent = result.miles;
    const timeText = result.hours > 0 ? `${result.hours} ч ${result.minutes} мин` : `${result.minutes} мин`;
    document.getElementById('distanceTime').textContent = timeText;

    const mapsUrl = `https://www.google.com/maps/dir/?api=1&origin=${result.fromLat},${result.fromLon}&destination=${result.toLat},${result.toLon}&travelmode=driving`;
    document.getElementById('distanceMapsLink').href = mapsUrl;

    hide(document.getElementById('distanceCopySuccess'));
    show(resultEl);
  } catch (err) {
    flash(errEl, err.message, true);
  }
});

document.getElementById('distanceCopyBtn').addEventListener('click', async () => {
  if (!lastDistanceResult) return;
  const r = lastDistanceResult;
  const timeText = r.hours > 0 ? `${r.hours} ч ${r.minutes} мин` : `${r.minutes} мин`;
  const mapsUrl = `https://www.google.com/maps/dir/?api=1&origin=${r.fromLat},${r.fromLon}&destination=${r.toLat},${r.toLon}&travelmode=driving`;
  const text = `${r.fromLabel} → ${r.toLabel}\n${r.miles} миль · ${timeText}\n${mapsUrl}`;

  const okEl = document.getElementById('distanceCopySuccess');
  try {
    await navigator.clipboard.writeText(text);
    flash(okEl, 'Скопировано в буфер обмена.');
  } catch {
    flash(okEl, 'Не удалось скопировать автоматически — выделите и скопируйте текст вручную.', true);
  }
});

// ================= EMAIL SENDER =================

let brokers = [];
let mailboxes = [];
let editingBrokerId = null;
const brokerFilters = { rating: 'all', shift: 'all', shuttle: false, notBroker: false, online: false };
let brokerSearchTimer = null;

const smtpPresets = {
  gmail: { host: 'smtp.gmail.com', port: 587, secure: false },
  outlook: { host: 'smtp.office365.com', port: 587, secure: false },
  custom: { host: '', port: 587, secure: false },
};

document.querySelectorAll('[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const preset = smtpPresets[btn.dataset.preset];
    document.getElementById('mailHost').value = preset.host;
    document.getElementById('mailPort').value = preset.port;
    document.getElementById('mailSecure').checked = preset.secure;
  });
});

// ---- Mailboxes (up to 5 per user) ----

async function refreshMailboxes() {
  mailboxes = await api('/api/email/mailboxes');
  const listEl = document.getElementById('mailboxList');
  const sendFromSel = document.getElementById('mailSendFrom');
  listEl.innerHTML = '';
  sendFromSel.innerHTML = '';
  document.getElementById('mailboxEmptyMsg').style.display = mailboxes.length ? 'none' : 'block';

  for (const mb of mailboxes) {
    const row = document.createElement('div');
    row.className = 'mailbox-row';
    row.innerHTML = `
      <span class="mailbox-label">${escapeHtml(mb.label)}</span>
      <span class="mailbox-email">${escapeHtml(mb.email)}</span>
      ${mb.isDefault ? '<span class="badge">по умолчанию</span>' : `<button class="btn-secondary set-default-btn" data-id="${mb.id}">Сделать основным</button>`}
      <button class="btn-danger remove-mailbox-btn" data-id="${mb.id}" style="margin-left:auto;">Удалить</button>
    `;
    listEl.appendChild(row);

    const opt = document.createElement('option');
    opt.value = mb.id;
    opt.textContent = `${mb.label} (${mb.email})`;
    if (mb.isDefault) opt.selected = true;
    sendFromSel.appendChild(opt);
  }

  listEl.querySelectorAll('.set-default-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/email/mailboxes/${btn.dataset.id}/default`, { method: 'POST' });
      await refreshMailboxes();
    });
  });
  listEl.querySelectorAll('.remove-mailbox-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/email/mailboxes/${btn.dataset.id}`, { method: 'DELETE' });
      await refreshMailboxes();
    });
  });

  document.getElementById('mailConnectBtn').disabled = mailboxes.length >= 5;
}

document.getElementById('mailConnectBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('mailError');
  hide(errEl);
  const payload = {
    label: document.getElementById('mailLabel').value.trim(),
    email: document.getElementById('mailEmail').value.trim(),
    smtpUser: document.getElementById('mailUser').value.trim() || document.getElementById('mailEmail').value.trim(),
    smtpPass: document.getElementById('mailPass').value,
    smtpHost: document.getElementById('mailHost').value.trim(),
    smtpPort: document.getElementById('mailPort').value.trim(),
    smtpSecure: document.getElementById('mailSecure').checked,
  };
  try {
    await api('/api/email/mailboxes', { method: 'POST', body: JSON.stringify(payload) });
    flash(document.getElementById('mailSuccess'), 'Почтовый ящик подключён!');
    ['mailLabel', 'mailEmail', 'mailUser', 'mailPass', 'mailHost', 'mailPort'].forEach(
      (id) => (document.getElementById(id).value = '')
    );
    document.getElementById('mailSecure').checked = false;
    await refreshMailboxes();
  } catch (err) {
    flash(errEl, err.message, true);
  }
});

// ---- Brokers (shared/global list) ----

function starsHtml(rating) {
  if (rating === null || rating === undefined) return '<span class="broker-stars">☆☆☆☆☆</span>';
  if (rating >= 5) return '<span class="broker-stars elite">★★★★★</span>';
  return `<span class="broker-stars has-rating">${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}</span>`;
}

function pctClass(pct) {
  if (pct >= 50) return 'pct-high';
  if (pct >= 25) return 'pct-mid';
  return 'pct-low';
}

function brokerDisplayName(b) {
  return b.lastName ? `${b.lastName}, ${b.firstName}` : b.firstName;
}

function brokerMatchesFilters(b) {
  if (brokerFilters.rating !== 'all') {
    const want = Number(brokerFilters.rating);
    const have = b.rating === null || b.rating === undefined ? 0 : b.rating;
    if (want !== have) return false;
  }
  if (brokerFilters.shift !== 'all' && b.shift !== brokerFilters.shift) return false;
  if (brokerFilters.shuttle && !b.shuttle) return false;
  if (brokerFilters.online && !b.isOnline) return false;

  const search = document.getElementById('brokerSearch').value.trim().toLowerCase();
  if (search) {
    const scope = document.getElementById('brokerSearchScope').value;
    const name = brokerDisplayName(b).toLowerCase();
    const email = b.email.toLowerCase();
    const hit =
      scope === 'name' ? name.includes(search) : scope === 'email' ? email.includes(search) : name.includes(search) || email.includes(search);
    if (!hit) return false;
  }
  return true;
}

function renderBrokerRow(b) {
  const wrap = document.createElement('div');
  wrap.className = 'broker-row';
  const name = brokerDisplayName(b);
  wrap.innerHTML = `
    <div class="broker-row-main">
      <input type="checkbox" class="broker-checkbox" value="${b.id}" />
      <span class="broker-online-dot ${b.isOnline ? 'online' : ''}"></span>
      <span class="broker-name" data-id="${b.id}" title="Нажмите, чтобы ${currentUser.isAdmin ? 'редактировать' : 'посмотреть детали'}: ${escapeHtml(name)}">${escapeHtml(name)}</span>
      ${b.isNew ? '<span class="broker-badge-new">NEW</span>' : ''}
      <span class="broker-badge-pct ${pctClass(b.percentage)}">${b.percentage}%</span>
      ${starsHtml(b.rating)}
      <button class="btn-primary broker-mail-btn" data-id="${b.id}" title="Выбрать для отправки">✉ Mail</button>
      <button class="broker-expand-btn" data-id="${b.id}">▾</button>
    </div>
    <div class="broker-row-details" id="brokerDetails-${b.id}">
      <dl>
        <dt>Email</dt><dd>${escapeHtml(b.email)}</dd>
        <dt>Часы</dt><dd>${b.hoursFrom && b.hoursTo ? `${b.hoursFrom}–${b.hoursTo}` : '—'}</dd>
        <dt>Дни</dt><dd>${b.workingDays.length ? b.workingDays.join(', ') : '—'}</dd>
        <dt>Shuttle</dt><dd>${b.shuttle ? 'Да' : 'Нет'}</dd>
        <dt>День рождения</dt><dd>${b.birthday || '—'}</dd>
        <dt>Заметки</dt><dd>${escapeHtml(b.notes || '—')}</dd>
        <dt>Успешность рассылок</dt><dd>${b.percentage}% (${b.sendCount} писем)</dd>
      </dl>
      ${
        currentUser.isAdmin
          ? `<p class="muted" style="margin:6px 0 0;">Нажмите на имя брокера выше, чтобы отредактировать.</p>
      <div class="toolbar">
        <button class="btn-secondary toggle-online-btn" data-id="${b.id}" data-online="${b.isOnline ? 0 : 1}">${
              b.isOnline ? 'Отметить оффлайн' : 'Отметить онлайн'
            }</button>
        <button class="btn-danger remove-broker-btn" data-id="${b.id}">Удалить</button>
      </div>`
          : `<label class="hint" style="display:block;margin-top:8px;">Указать/обновить email брокера</label>
      <div class="toolbar" style="margin-top:4px;">
        <input type="email" class="broker-email-input" id="brokerEmailInput-${b.id}" value="${escapeHtml(
              b.email || ''
            )}" placeholder="email@example.com" />
        <button class="btn-primary broker-email-save-btn" data-id="${b.id}">Сохранить email</button>
      </div>
      <p class="muted" id="brokerEmailMsg-${b.id}" style="display:none;"></p>`
      }
    </div>
  `;
  return wrap;
}

function wireBrokerRowEvents() {
  document.querySelectorAll('.broker-expand-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById(`brokerDetails-${btn.dataset.id}`).classList.toggle('open');
    });
  });
  document.querySelectorAll('.broker-mail-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.broker-checkbox').forEach((cb) => (cb.checked = cb.value === btn.dataset.id));
      document.getElementById('mailSubject').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
  document.querySelectorAll('.broker-name').forEach((el) => {
    el.addEventListener('click', () => {
      if (currentUser.isAdmin) {
        openBrokerModal(brokers.find((b) => b.id === Number(el.dataset.id)));
      } else {
        document.getElementById(`brokerDetails-${el.dataset.id}`).classList.toggle('open');
      }
    });
  });
  document.querySelectorAll('.toggle-online-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/email/brokers/${btn.dataset.id}/online`, {
        method: 'POST',
        body: JSON.stringify({ online: btn.dataset.online === '1' }),
      });
      await refreshBrokers();
    });
  });
  document.querySelectorAll('.remove-broker-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Удалить брокера?')) return;
      await api(`/api/email/brokers/${btn.dataset.id}`, { method: 'DELETE' });
      await refreshBrokers();
    });
  });
  document.querySelectorAll('.broker-email-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const input = document.getElementById(`brokerEmailInput-${id}`);
      const msgEl = document.getElementById(`brokerEmailMsg-${id}`);
      try {
        await api(`/api/email/brokers/${id}/email`, {
          method: 'POST',
          body: JSON.stringify({ email: input.value.trim() }),
        });
        flash(msgEl, 'Email обновлён.');
        await refreshBrokers();
      } catch (err) {
        flash(msgEl, err.message, true);
      }
    });
  });
}

function renderBrokers() {
  const filtered = brokers.filter(brokerMatchesFilters);
  const dayList = document.getElementById('brokerListDay');
  const nightList = document.getElementById('brokerListNight');
  dayList.innerHTML = '';
  nightList.innerHTML = '';

  const dayBrokers = filtered.filter((b) => b.shift !== 'night');
  const nightBrokers = filtered.filter((b) => b.shift === 'night');

  document.getElementById('brokerCountDay').textContent = dayBrokers.length;
  document.getElementById('brokerCountNight').textContent = nightBrokers.length;

  for (const b of dayBrokers) dayList.appendChild(renderBrokerRow(b));
  for (const b of nightBrokers) nightList.appendChild(renderBrokerRow(b));

  document.getElementById('brokersEmptyMsg').style.display = brokers.length ? 'none' : 'block';
  wireBrokerRowEvents();
}

async function refreshBrokers() {
  brokers = await api('/api/email/brokers');
  renderBrokers();
}

document.querySelectorAll('#brokerRatingFilters .tab-toggle-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#brokerRatingFilters .tab-toggle-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    brokerFilters.rating = btn.dataset.rating;
    renderBrokers();
  });
});
document.querySelectorAll('#brokerShiftFilters .tab-toggle-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#brokerShiftFilters .tab-toggle-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    brokerFilters.shift = btn.dataset.shift;
    renderBrokers();
    // Clicking DAY or NIGHT is meant as a one-click "pick this shift to send
    // to" shortcut: auto-check every broker the filter just left visible, so
    // there's no separate select-all click needed. "Все смены" only narrows
    // the view and doesn't touch the current selection.
    if (btn.dataset.shift === 'day' || btn.dataset.shift === 'night') {
      document.querySelectorAll('.broker-checkbox').forEach((cb) => (cb.checked = true));
    }
  });
});
document.querySelectorAll('#brokerToggleFilters .tab-toggle-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    btn.classList.toggle('active');
    brokerFilters[btn.dataset.toggle] = btn.classList.contains('active');
    renderBrokers();
  });
});
document.getElementById('brokerSearch').addEventListener('input', () => {
  clearTimeout(brokerSearchTimer);
  brokerSearchTimer = setTimeout(renderBrokers, 200);
});
document.getElementById('brokerSearchScope').addEventListener('change', renderBrokers);

// ---- Add/edit broker modal ----

function setSegmented(containerId, dataAttr, value) {
  document.querySelectorAll(`#${containerId} .segmented-btn`).forEach((btn) => {
    btn.classList.toggle('active', btn.dataset[dataAttr] === String(value ?? ''));
  });
}

document.querySelectorAll('#brokerShiftPicker .segmented-btn').forEach((btn) => {
  btn.addEventListener('click', () => setSegmented('brokerShiftPicker', 'shift', btn.dataset.shift));
});
document.querySelectorAll('#brokerRatingPicker .segmented-btn').forEach((btn) => {
  btn.addEventListener('click', () => setSegmented('brokerRatingPicker', 'rating', btn.dataset.rating));
});
document.querySelectorAll('#brokerDaysPicker .segmented-btn').forEach((btn) => {
  btn.addEventListener('click', () => btn.classList.toggle('active'));
});

function resetBrokerModal() {
  editingBrokerId = null;
  document.getElementById('brokerModalTitle').textContent = 'Добавить брокера';
  document.getElementById('brokerName').value = '';
  document.getElementById('brokerEmailInput').value = '';
  setSegmented('brokerShiftPicker', 'shift', '');
  document.getElementById('brokerHoursFrom').value = '09:00';
  document.getElementById('brokerHoursTo').value = '21:00';
  document.querySelectorAll('#brokerDaysPicker .segmented-btn').forEach((b) => b.classList.remove('active'));
  setSegmented('brokerRatingPicker', 'rating', '');
  document.getElementById('brokerShuttle').checked = false;
  document.getElementById('brokerBirthday').value = '';
  document.getElementById('brokerNotes').value = '';
  hide(document.getElementById('brokerModalError'));
}

function openBrokerModal(broker) {
  resetBrokerModal();
  if (broker) {
    editingBrokerId = broker.id;
    document.getElementById('brokerModalTitle').textContent = 'Редактировать брокера';
    document.getElementById('brokerName').value = brokerDisplayName(broker);
    document.getElementById('brokerEmailInput').value = broker.email;
    setSegmented('brokerShiftPicker', 'shift', broker.shift || '');
    document.getElementById('brokerHoursFrom').value = broker.hoursFrom || '09:00';
    document.getElementById('brokerHoursTo').value = broker.hoursTo || '21:00';
    document.querySelectorAll('#brokerDaysPicker .segmented-btn').forEach((b) => {
      b.classList.toggle('active', broker.workingDays.includes(b.dataset.day));
    });
    setSegmented('brokerRatingPicker', 'rating', broker.rating ?? '');
    document.getElementById('brokerShuttle').checked = broker.shuttle;
    document.getElementById('brokerBirthday').value = broker.birthday || '';
    document.getElementById('brokerNotes').value = broker.notes || '';
  }
  document.getElementById('brokerModalOverlay').style.display = 'flex';
}

document.getElementById('addBrokerOpenBtn').addEventListener('click', () => openBrokerModal(null));
document.getElementById('brokerModalCancelBtn').addEventListener('click', () => {
  document.getElementById('brokerModalOverlay').style.display = 'none';
});

document.getElementById('brokerModalSaveBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('brokerModalError');
  hide(errEl);
  const nameRaw = document.getElementById('brokerName').value.trim();
  const email = document.getElementById('brokerEmailInput').value.trim();
  if (!nameRaw || !email) return flash(errEl, 'Укажите имя и email.', true);

  let lastName = '';
  let firstName = nameRaw;
  if (nameRaw.includes(',')) {
    const [last, first] = nameRaw.split(',');
    lastName = last.trim();
    firstName = (first || '').trim();
  }

  const shiftBtn = document.querySelector('#brokerShiftPicker .segmented-btn.active');
  const ratingBtn = document.querySelector('#brokerRatingPicker .segmented-btn.active');
  const days = [...document.querySelectorAll('#brokerDaysPicker .segmented-btn.active')].map((b) => b.dataset.day);

  const payload = {
    firstName,
    lastName,
    email,
    shift: shiftBtn && shiftBtn.dataset.shift ? shiftBtn.dataset.shift : null,
    hoursFrom: document.getElementById('brokerHoursFrom').value,
    hoursTo: document.getElementById('brokerHoursTo').value,
    workingDays: days,
    rating: ratingBtn && ratingBtn.dataset.rating ? Number(ratingBtn.dataset.rating) : null,
    shuttle: document.getElementById('brokerShuttle').checked,
    birthday: document.getElementById('brokerBirthday').value || null,
    notes: document.getElementById('brokerNotes').value.trim(),
  };

  try {
    if (editingBrokerId) {
      await api(`/api/email/brokers/${editingBrokerId}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api('/api/email/brokers', { method: 'POST', body: JSON.stringify(payload) });
    }
    document.getElementById('brokerModalOverlay').style.display = 'none';
    await refreshBrokers();
  } catch (err) {
    flash(errEl, err.message, true);
  }
});

// ---- CSV import ----

document.getElementById('importCsvBtn').addEventListener('click', () => {
  document.getElementById('importCsvFile').click();
});
document.getElementById('importCsvFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const errEl = document.getElementById('brokerActionError');
  const okEl = document.getElementById('brokerActionSuccess');
  hide(errEl); hide(okEl);
  try {
    const result = await api('/api/email/brokers/import', { method: 'POST', body: JSON.stringify({ csv: text }) });
    if (result.errors.length) {
      flash(errEl, `Импортировано: ${result.imported}. Ошибки: ${result.errors.join('; ')}`, true);
    } else {
      flash(okEl, `Импортировано брокеров: ${result.imported}.`);
    }
    await refreshBrokers();
  } catch (err) {
    flash(errEl, err.message, true);
  } finally {
    e.target.value = '';
  }
});

// ---- Selecting + sending ----

document.getElementById('selectAllBrokersSendBtn').addEventListener('click', () => {
  document.querySelectorAll('.broker-checkbox').forEach((cb) => (cb.checked = true));
});

document.querySelectorAll('.column-select-all').forEach((cb) => {
  cb.addEventListener('change', () => {
    const listEl = document.getElementById(cb.dataset.column === 'day' ? 'brokerListDay' : 'brokerListNight');
    listEl.querySelectorAll('.broker-checkbox').forEach((rowCb) => (rowCb.checked = cb.checked));
  });
});

function getSelectedBrokerIds() {
  return [...document.querySelectorAll('.broker-checkbox:checked')].map((cb) => Number(cb.value));
}

async function sendMail(brokerIds) {
  const errEl = document.getElementById('mailSendError');
  const okEl = document.getElementById('mailSendSuccess');
  hide(errEl); hide(okEl);

  const subject = document.getElementById('mailSubject').value.trim();
  const text = document.getElementById('mailBody').value.trim();
  if (!subject || !text) return flash(errEl, 'Заполните тему и текст письма.', true);
  if (!brokerIds.length) return flash(errEl, 'Выберите хотя бы одного брокера.', true);

  const mailboxId = Number(document.getElementById('mailSendFrom').value) || undefined;
  const delaySeconds = Math.max(2, Number(document.getElementById('mailSendDelay').value) || 2);

  try {
    const { results } = await api('/api/email/send', {
      method: 'POST',
      body: JSON.stringify({ mailboxId, brokerIds, subject, text, delaySeconds }),
    });
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      flash(errEl, `Отправлено с ошибками: ${failed.map((f) => `${f.email}: ${f.error}`).join('; ')}`, true);
    } else {
      flash(okEl, `Письмо отправлено ${results.length} брокер(ам).`);
    }
    await refreshBrokers();
  } catch (err) {
    flash(errEl, err.message, true);
  }
}

document.getElementById('sendMailBtn').addEventListener('click', () => sendMail(getSelectedBrokerIds()));

// ================= ADMIN =================

async function refreshUsers() {
  let users;
  try {
    users = await api('/api/admin/users');
  } catch {
    return;
  }
  const tbody = document.getElementById('usersTableBody');
  tbody.innerHTML = '';
  for (const u of users) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(u.email)}</td>
      <td>${u.isAdmin ? '<span class="badge">admin</span>' : ''}</td>
      <td>${u.createdAt}</td>
      <td>
        <button class="btn-secondary reset-pass-btn" data-id="${u.id}">Сбросить пароль</button>
        ${!u.isAdmin ? `<button class="btn-danger remove-user-btn" data-id="${u.id}">Удалить</button>` : ''}
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('.reset-pass-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { email, password } = await api(`/api/admin/users/${btn.dataset.id}/reset-password`, { method: 'POST' });
      showNewUserResult(email, password);
    });
  });
  tbody.querySelectorAll('.remove-user-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Удалить доступ этого пользователя?')) return;
      try {
        await api(`/api/admin/users/${btn.dataset.id}`, { method: 'DELETE' });
        await refreshUsers();
      } catch (err) {
        flash(document.getElementById('adminError'), err.message, true);
      }
    });
  });
}

function showNewUserResult(email, password) {
  const el = document.getElementById('newUserResult');
  el.innerHTML = `Логин: <b>${escapeHtml(email)}</b> — Пароль: <b>${escapeHtml(password)}</b> (скопируйте сейчас, повторно не показывается)`;
  show(el);
}

document.getElementById('addUserBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('adminError');
  hide(errEl);
  const email = document.getElementById('newUserEmail').value.trim();
  if (!email) return;
  try {
    const { email: createdEmail, password } = await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    document.getElementById('newUserEmail').value = '';
    showNewUserResult(createdEmail, password);
    await refreshUsers();
  } catch (err) {
    flash(errEl, err.message, true);
  }
});

// ---------- init ----------

(async function init() {
  await Promise.all([
    refreshTgStatus(),
    refreshGroups(),
    refreshMessages(),
    refreshMailboxes(),
    refreshBrokers(),
    loadCapList(),
    refreshPullStatus(),
    refreshCapListSentMessages(),
  ]);
})();
