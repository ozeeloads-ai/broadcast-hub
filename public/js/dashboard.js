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

(async function initUser() {
  try {
    const me = await api('/api/auth/me');
    if (!me.authenticated) return (window.location.href = '/');
    document.getElementById('whoami').textContent = me.username;
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
    show(document.getElementById('tgConnectedBlock'));
    hide(document.getElementById('tgLoginBlock'));
  } else {
    hide(document.getElementById('tgConnectedBlock'));
    show(document.getElementById('tgLoginBlock'));
  }
}

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

(async function loadHardPullTemplate() {
  try {
    const { text } = await api('/api/telegram/hardpull/template');
    document.getElementById('hardPullTemplateText').textContent = text;
  } catch {
    // fall back to the hard-coded default already shown in the HTML
  }
})();

async function hardPullGroups(groupIds) {
  const errEl = document.getElementById('hardPullError');
  const okEl = document.getElementById('hardPullSuccess');
  hide(errEl); hide(okEl);
  if (!groupIds.length) return flash(errEl, 'Выберите хотя бы одну группу.', true);

  const delaySeconds = Number(document.getElementById('hardPullDelay').value) || 0;

  try {
    const { results } = await api('/api/telegram/hardpull', {
      method: 'POST',
      body: JSON.stringify({ groupIds, delaySeconds }),
    });
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      flash(errEl, `С ошибками: ${failed.map((f) => `${f.title}: ${f.error}`).join('; ')}`, true);
    }
    const okResults = results.filter((r) => r.ok);
    if (okResults.length) {
      const total = okResults.reduce((sum, r) => sum + (r.mentioned || 0), 0);
      flash(okEl, `Hard Pull отправлен в ${okResults.length} групп(у), упомянуто участников: ${total}.`);
    }
  } catch (err) {
    flash(errEl, err.message, true);
  }
}

document.getElementById('hardPullSelectedBtn').addEventListener('click', () => {
  const ids = [...document.querySelectorAll('.caplist-group-checkbox:checked')].map((cb) => Number(cb.value));
  hardPullGroups(ids);
});
document.getElementById('hardPullAllBtn').addEventListener('click', () => {
  hardPullGroups(groups.map((g) => g.id));
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

async function refreshMailStatus() {
  const status = await api('/api/email/status');
  if (status.connected) {
    document.getElementById('mailAccountEmail').textContent = status.email;
    show(document.getElementById('mailConnectedBlock'));
    hide(document.getElementById('mailConnectForm'));
  } else {
    hide(document.getElementById('mailConnectedBlock'));
    show(document.getElementById('mailConnectForm'));
  }
}

document.getElementById('mailConnectBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('mailError');
  hide(errEl);
  const payload = {
    email: document.getElementById('mailEmail').value.trim(),
    smtpUser: document.getElementById('mailUser').value.trim() || document.getElementById('mailEmail').value.trim(),
    smtpPass: document.getElementById('mailPass').value,
    smtpHost: document.getElementById('mailHost').value.trim(),
    smtpPort: document.getElementById('mailPort').value.trim(),
    smtpSecure: document.getElementById('mailSecure').checked,
  };
  try {
    await api('/api/email/connect', { method: 'POST', body: JSON.stringify(payload) });
    flash(document.getElementById('mailSuccess'), 'Почта подключена!');
    await refreshMailStatus();
  } catch (err) {
    flash(errEl, err.message, true);
  }
});

document.getElementById('mailDisconnectBtn').addEventListener('click', async () => {
  await api('/api/email/disconnect', { method: 'POST' });
  await refreshMailStatus();
});

async function refreshBrokers() {
  brokers = await api('/api/email/brokers');
  const tbody = document.getElementById('brokersTableBody');
  tbody.innerHTML = '';
  document.getElementById('brokersEmptyMsg').style.display = brokers.length ? 'none' : 'block';

  for (const b of brokers) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="checkbox-cell"><input type="checkbox" class="broker-checkbox" value="${b.id}" /></td>
      <td>${escapeHtml(b.first_name)}</td>
      <td>${escapeHtml(b.last_name)}</td>
      <td>${escapeHtml(b.work_hours || '')}</td>
      <td>${escapeHtml(b.email)}</td>
      <td><button class="btn-secondary remove-broker-btn" data-id="${b.id}">Удалить</button></td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('.remove-broker-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/email/brokers/${btn.dataset.id}`, { method: 'DELETE' });
      await refreshBrokers();
    });
  });
}

document.getElementById('addBrokerBtn').addEventListener('click', async () => {
  const payload = {
    firstName: document.getElementById('brokerFirstName').value.trim(),
    lastName: document.getElementById('brokerLastName').value.trim(),
    workHours: document.getElementById('brokerWorkHours').value.trim(),
    email: document.getElementById('brokerEmail').value.trim(),
  };
  try {
    await api('/api/email/brokers', { method: 'POST', body: JSON.stringify(payload) });
    ['brokerFirstName', 'brokerLastName', 'brokerWorkHours', 'brokerEmail'].forEach(
      (id) => (document.getElementById(id).value = '')
    );
    await refreshBrokers();
  } catch (err) {
    flash(document.getElementById('mailError'), err.message, true);
  }
});

document.getElementById('selectAllBrokers').addEventListener('change', (e) => {
  document.querySelectorAll('.broker-checkbox').forEach((cb) => (cb.checked = e.target.checked));
});
document.getElementById('selectAllBrokersSendBtn').addEventListener('click', () => {
  document.querySelectorAll('.broker-checkbox').forEach((cb) => (cb.checked = true));
  document.getElementById('selectAllBrokers').checked = true;
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

  const delaySeconds = Number(document.getElementById('mailSendDelay').value) || 0;

  try {
    const { results } = await api('/api/email/send', {
      method: 'POST',
      body: JSON.stringify({ brokerIds, subject, text, delaySeconds }),
    });
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      flash(errEl, `Отправлено с ошибками: ${failed.map((f) => `${f.email}: ${f.error}`).join('; ')}`, true);
    } else {
      flash(okEl, `Письмо отправлено ${results.length} брокер(ам).`);
    }
  } catch (err) {
    flash(errEl, err.message, true);
  }
}

document.getElementById('sendToSelectedBrokersBtn').addEventListener('click', () => sendMail(getSelectedBrokerIds()));
document.getElementById('sendToAllBrokersBtn').addEventListener('click', () => sendMail(brokers.map((b) => b.id)));

// ---------- init ----------

(async function init() {
  await Promise.all([refreshTgStatus(), refreshGroups(), refreshMessages(), refreshMailStatus(), refreshBrokers(), loadCapList()]);
})();
