// Wraps GramJS (the "telegram" npm package) to let each web-app user log in
// with THEIR OWN personal Telegram account (phone number + code, optionally
// 2FA password) and then send/delete messages in groups that account belongs
// to. One shared api_id/api_hash pair (from https://my.telegram.org) is used
// for every user, exactly like any third-party Telegram client.
//
// IMPORTANT: automating a personal Telegram account carries a real risk of
// rate limits or account restrictions if used for aggressive bulk/unsolicited
// messaging. This tool is intended for sending updates to groups the account
// already owns/administers. See README.md for details.

const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { Api } = require('teleproto');
const { computeCheck } = require('teleproto/Password');
const { NewMessage } = require('teleproto/events');
const { encrypt, decrypt } = require('../crypto');
const db = require('../db');

const API_ID = parseInt(process.env.TELEGRAM_API_ID, 10);
const API_HASH = process.env.TELEGRAM_API_HASH;

// userId -> connected TelegramClient (kept warm so we don't reconnect on every action)
const activeClients = new Map();

// userIds that already have a "Cap List" incoming-message listener attached to
// their client, so we never double-attach when getClient() is called again.
const capListListenerAttached = new Set();

// loginToken -> { client, phoneNumber, phoneCodeHash, userId, createdAt }
const pendingLogins = new Map();

const LOGIN_TTL_MS = 10 * 60 * 1000; // 10 minutes to finish phone/code/2FA flow

function assertConfigured() {
  if (!API_ID || !API_HASH) {
    throw new Error(
      'TELEGRAM_API_ID / TELEGRAM_API_HASH не заданы в .env. Получите их бесплатно на https://my.telegram.org'
    );
  }
}

function cleanupExpiredLogins() {
  const now = Date.now();
  for (const [token, entry] of pendingLogins.entries()) {
    if (now - entry.createdAt > LOGIN_TTL_MS) {
      entry.client.destroy().catch(() => {});
      pendingLogins.delete(token);
    }
  }
}
setInterval(cleanupExpiredLogins, 60 * 1000).unref();

function newClient(sessionString = '') {
  assertConfigured();
  return new TelegramClient(new StringSession(sessionString), API_ID, API_HASH, {
    connectionRetries: 3,
  });
}

// ---- Login flow (phone -> code -> optional 2FA password) ----

async function startLogin(userId, phone) {
  const client = newClient('');
  await client.connect();

  const result = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone);

  const token = `${userId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  pendingLogins.set(token, {
    client,
    phone,
    phoneCodeHash: result.phoneCodeHash,
    userId,
    createdAt: Date.now(),
  });

  return { token };
}

async function submitCode(token, code) {
  const entry = pendingLogins.get(token);
  if (!entry) throw new Error('Сессия входа истекла, начните заново.');

  try {
    await entry.client.invoke(
      new Api.auth.SignIn({
        phoneNumber: entry.phone,
        phoneCodeHash: entry.phoneCodeHash,
        phoneCode: code,
      })
    );
  } catch (err) {
    if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
      return { needsPassword: true };
    }
    throw err;
  }

  return finishLogin(entry);
}

async function submitPassword(token, password) {
  const entry = pendingLogins.get(token);
  if (!entry) throw new Error('Сессия входа истекла, начните заново.');

  const passwordInfo = await entry.client.invoke(new Api.account.GetPassword());
  const srpCheck = await computeCheck(passwordInfo, password);
  await entry.client.invoke(new Api.auth.CheckPassword({ password: srpCheck }));

  return finishLogin(entry);
}

async function finishLogin(entry) {
  const me = await entry.client.getMe();
  const sessionString = entry.client.session.save();

  db.prepare(
    `INSERT INTO telegram_accounts (user_id, phone, session_string, display_name, connected_at)
     VALUES (@userId, @phone, @sessionString, @displayName, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       phone=excluded.phone, session_string=excluded.session_string,
       display_name=excluded.display_name, connected_at=excluded.connected_at`
  ).run({
    userId: entry.userId,
    phone: entry.phone,
    sessionString: encrypt(sessionString),
    displayName: [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || entry.phone,
  });

  activeClients.set(entry.userId, entry.client);
  pendingLogins.delete(
    [...pendingLogins.entries()].find(([, v]) => v === entry)?.[0]
  );
  attachCapListListener(entry.userId, entry.client);

  return { connected: true, displayName: [me.firstName, me.lastName].filter(Boolean).join(' ') };
}

// ---- Getting a connected client for an already-logged-in user ----

async function getClient(userId) {
  if (activeClients.has(userId)) {
    const c = activeClients.get(userId);
    if (c.connected) return c;
  }

  const row = db.prepare('SELECT session_string FROM telegram_accounts WHERE user_id = ?').get(userId);
  if (!row || !row.session_string) {
    throw new Error('Telegram-аккаунт не подключён.');
  }

  const client = newClient(decrypt(row.session_string));
  await client.connect();
  activeClients.set(userId, client);
  attachCapListListener(userId, client);
  return client;
}

function getStatus(userId) {
  const row = db.prepare('SELECT phone, display_name, connected_at FROM telegram_accounts WHERE user_id = ?').get(userId);
  if (!row) return { connected: false };
  return { connected: true, phone: row.phone, displayName: row.display_name, connectedAt: row.connected_at };
}

async function disconnect(userId) {
  const c = activeClients.get(userId);
  if (c) {
    await c.destroy().catch(() => {});
    activeClients.delete(userId);
  }
  db.prepare('DELETE FROM telegram_accounts WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM telegram_groups WHERE user_id = ?').run(userId);
}

// ---- Resolving a group the user typed in manually ----

function parseIdentifier(raw) {
  const value = raw.trim();
  let m = value.match(/t\.me\/(?:joinchat\/|\+)([\w-]+)/i);
  if (m) return { type: 'invite', hash: m[1] };
  m = value.match(/^\+([\w-]+)$/);
  if (m) return { type: 'invite', hash: m[1] };
  m = value.match(/t\.me\/([A-Za-z0-9_]+)/i);
  if (m) return { type: 'username', username: m[1] };
  if (value.startsWith('@')) return { type: 'username', username: value.slice(1) };
  if (/^-?\d+$/.test(value)) return { type: 'id', id: value };
  return { type: 'username', username: value };
}

function chatFromEntity(entity) {
  // entity is an Api.Channel, Api.Chat or Api.User instance
  if (entity.className === 'Channel') {
    return { chatId: entity.id.toString(), accessHash: entity.accessHash?.toString() || null, peerType: 'channel', title: entity.title };
  }
  if (entity.className === 'Chat' || entity.className === 'ChatForbidden') {
    return { chatId: entity.id.toString(), accessHash: null, peerType: 'chat', title: entity.title };
  }
  if (entity.className === 'User') {
    const name = [entity.firstName, entity.lastName].filter(Boolean).join(' ') || (entity.username ? '@' + entity.username : 'Без имени');
    return { chatId: entity.id.toString(), accessHash: entity.accessHash?.toString() || null, peerType: 'user', title: name };
  }
  throw new Error('Указанный адрес не является группой, каналом или личным чатом.');
}

// ---- Browsing the account's existing Telegram dialogs (groups/channels or DMs) ----

async function listDialogs(userId, kind) {
  const client = await getClient(userId);
  const dialogs = await client.getDialogs({ limit: 300 });

  const results = [];
  for (const d of dialogs) {
    const entity = d.entity;
    if (!entity) continue;
    const cls = entity.className;
    const isGroupOrChannel = cls === 'Chat' || cls === 'ChatForbidden' || cls === 'Channel';
    const isPrivateUser = cls === 'User' && !entity.bot && !entity.self;

    if (kind === 'private' && !isPrivateUser) continue;
    if (kind !== 'private' && !isGroupOrChannel) continue;

    let title;
    if (cls === 'User') {
      title = [entity.firstName, entity.lastName].filter(Boolean).join(' ') || (entity.username ? '@' + entity.username : 'Без имени');
    } else {
      title = entity.title || (entity.username ? '@' + entity.username : 'Без названия');
    }

    results.push({ id: entity.id.toString(), title, type: cls });
  }
  return results;
}

async function importDialogs(userId, ids) {
  const client = await getClient(userId);
  const results = [];
  for (const rawId of ids) {
    try {
      const idValue = /^\d+$/.test(rawId) && rawId.length > 15 ? BigInt(rawId) : Number(rawId);
      const entity = await client.getEntity(idValue);
      const chat = chatFromEntity(entity);

      const info = db.prepare(
        `INSERT INTO telegram_groups (user_id, chat_id, access_hash, peer_type, title, identifier)
         VALUES (@userId, @chatId, @accessHash, @peerType, @title, @identifier)
         ON CONFLICT(user_id, chat_id) DO UPDATE SET
           access_hash=excluded.access_hash, peer_type=excluded.peer_type,
           title=excluded.title, identifier=excluded.identifier`
      ).run({ userId, identifier: 'telegram-dialog', ...chat });

      results.push({ ok: true, id: rawId, dbId: info.lastInsertRowid, title: chat.title });
    } catch (err) {
      results.push({ ok: false, id: rawId, error: err.message });
    }
  }
  return results;
}

async function addGroup(userId, rawIdentifier) {
  const client = await getClient(userId);
  const parsed = parseIdentifier(rawIdentifier);
  let chat;

  if (parsed.type === 'invite') {
    const info = await client.invoke(new Api.messages.CheckChatInvite({ hash: parsed.hash }));
    if (info.className === 'ChatInviteAlready' || info.className === 'ChatInvitePeek') {
      chat = chatFromEntity(info.chat);
    } else {
      const joined = await client.invoke(new Api.messages.ImportChatInvite({ hash: parsed.hash }));
      const entity = joined.chats && joined.chats[0];
      if (!entity) throw new Error('Не удалось вступить в группу по этой ссылке.');
      chat = chatFromEntity(entity);
    }
  } else if (parsed.type === 'username') {
    const entity = await client.getEntity(parsed.username);
    chat = chatFromEntity(entity);
  } else {
    const entity = await client.getEntity(parsed.id);
    chat = chatFromEntity(entity);
  }

  const info = db.prepare(
    `INSERT INTO telegram_groups (user_id, chat_id, access_hash, peer_type, title, identifier)
     VALUES (@userId, @chatId, @accessHash, @peerType, @title, @identifier)
     ON CONFLICT(user_id, chat_id) DO UPDATE SET
       access_hash=excluded.access_hash, peer_type=excluded.peer_type,
       title=excluded.title, identifier=excluded.identifier`
  ).run({ userId, identifier: rawIdentifier, ...chat });

  return { id: info.lastInsertRowid, ...chat };
}

function listGroups(userId) {
  return db.prepare('SELECT * FROM telegram_groups WHERE user_id = ? ORDER BY added_at DESC').all(userId);
}

function removeGroup(userId, groupId) {
  db.prepare('DELETE FROM telegram_groups WHERE user_id = ? AND id = ?').run(userId, groupId);
}

function buildInputPeer(group) {
  if (group.peer_type === 'channel') {
    return new Api.InputPeerChannel({
      channelId: BigInt(group.chat_id),
      accessHash: BigInt(group.access_hash),
    });
  }
  if (group.peer_type === 'chat') {
    return new Api.InputPeerChat({ chatId: BigInt(group.chat_id) });
  }
  if (group.peer_type === 'user') {
    return new Api.InputPeerUser({ userId: BigInt(group.chat_id), accessHash: BigInt(group.access_hash) });
  }
  throw new Error('Неизвестный тип группы.');
}

// ---- Sending & deleting messages ----

async function sendToGroups(userId, groupIds, text, autoDeleteMinutes) {
  const client = await getClient(userId);
  const groups = db
    .prepare(`SELECT * FROM telegram_groups WHERE user_id = ? AND id IN (${groupIds.map(() => '?').join(',')})`)
    .all(userId, ...groupIds);

  const results = [];
  for (const group of groups) {
    try {
      const peer = buildInputPeer(group);
      const message = await client.sendMessage(peer, { message: text });
      const autoDeleteAt =
        autoDeleteMinutes && autoDeleteMinutes > 0
          ? new Date(Date.now() + autoDeleteMinutes * 60 * 1000).toISOString()
          : null;

      db.prepare(
        `INSERT INTO sent_messages (user_id, group_id, chat_id, message_id, text, auto_delete_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(userId, group.id, group.chat_id, message.id, text, autoDeleteAt);

      results.push({ groupId: group.id, title: group.title, ok: true });
    } catch (err) {
      results.push({ groupId: group.id, title: group.title, ok: false, error: err.message });
    }
  }
  return results;
}

function listSentMessages(userId, groupId) {
  if (groupId) {
    return db
      .prepare(
        `SELECT sm.*, g.title FROM sent_messages sm JOIN telegram_groups g ON g.id = sm.group_id
         WHERE sm.user_id = ? AND sm.group_id = ? ORDER BY sm.sent_at DESC`
      )
      .all(userId, groupId);
  }
  return db
    .prepare(
      `SELECT sm.*, g.title FROM sent_messages sm JOIN telegram_groups g ON g.id = sm.group_id
       WHERE sm.user_id = ? ORDER BY sm.sent_at DESC`
    )
    .all(userId);
}

async function deleteMessagesByDbIds(userId, dbIds) {
  const client = await getClient(userId);
  const rows = db
    .prepare(
      `SELECT sm.*, g.peer_type, g.access_hash FROM sent_messages sm
       JOIN telegram_groups g ON g.id = sm.group_id
       WHERE sm.user_id = ? AND sm.id IN (${dbIds.map(() => '?').join(',')}) AND sm.deleted_at IS NULL`
    )
    .all(userId, ...dbIds);

  // group by chat so we can batch-delete per chat
  const byChat = new Map();
  for (const row of rows) {
    if (!byChat.has(row.group_id)) byChat.set(row.group_id, { group: row, ids: [] });
    byChat.get(row.group_id).ids.push(row.message_id);
  }

  const results = [];
  for (const { group, ids } of byChat.values()) {
    try {
      const peer = buildInputPeer(group);
      await client.deleteMessages(peer, ids, { revoke: true });
      const dbIdsForChat = rows.filter((r) => r.group_id === group.group_id).map((r) => r.id);
      db.prepare(
        `UPDATE sent_messages SET deleted_at = datetime('now') WHERE id IN (${dbIdsForChat.map(() => '?').join(',')})`
      ).run(...dbIdsForChat);
      results.push({ groupId: group.group_id, ok: true, count: ids.length });
    } catch (err) {
      results.push({ groupId: group.group_id, ok: false, error: err.message });
    }
  }
  return results;
}

// ---- Cap List: scan incoming group messages for truck-availability lines ----
// Example lines dispatchers post in reply to a "share updated cap list" request:
//   "LAS VEGAS NV Solo", "Chicago IL team", "CA team", "SC solo"

const CAP_LIST_REQUEST_TEXT = 'Please share updated cap list  TEAM , SOLO';

const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
  'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

function parseCapListLine(line) {
  const trimmed = line.trim().replace(/[.;]+$/, '');
  if (!trimmed || trimmed.length > 80) return null;

  const m = trimmed.match(/^(?:(.+?)[,]?\s+)?([A-Za-z]{2})\s+(team|solo)\s*$/i);
  if (!m) return null;

  const state = m[2].toUpperCase();
  if (!US_STATE_CODES.has(state)) return null;

  const city = (m[1] || '').replace(/,\s*$/, '').trim();
  const truckType = m[3].toLowerCase();
  return { city, state, truckType };
}

function attachCapListListener(userId, client) {
  if (capListListenerAttached.has(userId)) return;
  capListListenerAttached.add(userId);

  client.addEventHandler(async (event) => {
    try {
      const message = event.message;
      if (!message || !message.message) return;

      const chatId = message.peerId && (message.peerId.channelId || message.peerId.chatId || message.peerId.userId);
      if (!chatId) return;

      const group = db
        .prepare('SELECT * FROM telegram_groups WHERE user_id = ? AND chat_id = ?')
        .get(userId, chatId.toString());
      if (!group) return; // only track chats the user has actually added/imported

      const lines = message.message.split(/\r?\n/);
      const matches = lines.map(parseCapListLine).filter(Boolean);
      if (!matches.length) return;

      let senderName = '';
      try {
        const sender = await message.getSender();
        if (sender) {
          senderName = [sender.firstName, sender.lastName].filter(Boolean).join(' ') || (sender.username ? '@' + sender.username : '');
        }
      } catch {
        // best-effort only — a failure here shouldn't drop the cap-list entry
      }

      const insert = db.prepare(
        `INSERT INTO cap_list_entries (user_id, group_id, chat_title, sender_name, raw_text, city, state, truck_type)
         VALUES (@userId, @groupId, @chatTitle, @senderName, @rawText, @city, @state, @truckType)`
      );
      for (const match of matches) {
        insert.run({
          userId,
          groupId: group.id,
          chatTitle: group.title,
          senderName,
          rawText: message.message,
          city: match.city,
          state: match.state,
          truckType: match.truckType,
        });
      }
    } catch {
      // never let a parsing/storage error crash the event loop
    }
  }, new NewMessage({}));
}

async function initializeAllTelegramClients() {
  const rows = db.prepare('SELECT user_id FROM telegram_accounts').all();
  for (const row of rows) {
    try {
      await getClient(row.user_id);
    } catch (err) {
      console.error(`[caplist] failed to warm up Telegram client for user ${row.user_id}:`, err.message);
    }
  }
}

function listCapListCurrent(userId, { kind, search } = {}) {
  // "Current" view: the latest parsed line per group, i.e. each broker's most
  // recently reported truck status — not the full history.
  let rows = db
    .prepare(
      `SELECT c.* FROM cap_list_entries c
       INNER JOIN (
         SELECT group_id, MAX(id) AS max_id FROM cap_list_entries WHERE user_id = ? GROUP BY group_id
       ) latest ON latest.group_id = c.group_id AND latest.max_id = c.id
       WHERE c.user_id = ?
       ORDER BY c.created_at DESC, c.id DESC`
    )
    .all(userId, userId);

  if (kind === 'team' || kind === 'solo') {
    rows = rows.filter((r) => r.truck_type === kind);
  }
  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter((r) =>
      [r.city, r.state, r.chat_title, r.sender_name].filter(Boolean).some((v) => v.toLowerCase().includes(q))
    );
  }
  return rows;
}

function listCapListLog(userId, { kind, search } = {}) {
  let rows = db
    .prepare('SELECT * FROM cap_list_entries WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 500')
    .all(userId);

  if (kind === 'team' || kind === 'solo') {
    rows = rows.filter((r) => r.truck_type === kind);
  }
  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter((r) =>
      [r.city, r.state, r.chat_title, r.sender_name].filter(Boolean).some((v) => v.toLowerCase().includes(q))
    );
  }
  return rows;
}

function capListCounts(userId) {
  const current = listCapListCurrent(userId);
  return {
    all: current.length,
    team: current.filter((r) => r.truck_type === 'team').length,
    solo: current.filter((r) => r.truck_type === 'solo').length,
    log: db.prepare('SELECT COUNT(*) AS n FROM cap_list_entries WHERE user_id = ?').get(userId).n,
  };
}

function clearCapList(userId) {
  db.prepare('DELETE FROM cap_list_entries WHERE user_id = ?').run(userId);
}

// ---- Hard Pull: @-mention every member of a group (except an exclude list) ----

const HARD_PULL_TEXT = 'Please share cap list , lets books some loads';

const HARD_PULL_EXCLUDED_USERNAMES = [
  'LB_Mark',
  'zamkgz',
  'babazavrrrrr',
  'Islam_cold_loads',
  'rashland_force',
  'benjamin_1207',
  'Eddy_x993',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function hardPullGroups(userId, groupIds, delaySeconds = 0) {
  const client = await getClient(userId);
  const delayMs = Math.min(5, Math.max(0, Number(delaySeconds) || 0)) * 1000;
  const excludeSet = new Set(HARD_PULL_EXCLUDED_USERNAMES.map((u) => u.replace(/^@/, '').toLowerCase()));
  const groups = db
    .prepare(`SELECT * FROM telegram_groups WHERE user_id = ? AND id IN (${groupIds.map(() => '?').join(',')})`)
    .all(userId, ...groupIds);

  const results = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (i > 0 && delayMs > 0) await sleep(delayMs);
    try {
      if (group.peer_type === 'user') {
        throw new Error('Hard Pull доступен только для групп и каналов.');
      }
      const peer = buildInputPeer(group);
      const participants = await client.getParticipants(peer, { limit: 5000 });

      const targets = participants.filter((p) => {
        if (!p || p.className !== 'User') return false;
        if (p.bot || p.self || p.deleted) return false;
        if (p.username && excludeSet.has(p.username.toLowerCase())) return false;
        return true;
      });

      // Visible text stays short; each excluded-free member gets a hidden
      // (zero-width) mention entity so Telegram still notifies them.
      let text = HARD_PULL_TEXT + '\n';
      const entities = [];
      for (const user of targets) {
        if (!user.accessHash) continue; // need an access hash to build a valid mention
        entities.push(
          new Api.InputMessageEntityMentionName({
            offset: text.length,
            length: 1,
            userId: new Api.InputUser({ userId: user.id, accessHash: user.accessHash }),
          })
        );
        text += '​';
      }

      const message = await client.sendMessage(peer, { message: text, formattingEntities: entities });

      db.prepare(
        `INSERT INTO sent_messages (user_id, group_id, chat_id, message_id, text)
         VALUES (?, ?, ?, ?, ?)`
      ).run(userId, group.id, group.chat_id, message.id, `[Hard Pull] ${HARD_PULL_TEXT} (упомянуто: ${targets.length})`);

      results.push({ groupId: group.id, title: group.title, ok: true, mentioned: targets.length });
    } catch (err) {
      results.push({ groupId: group.id, title: group.title, ok: false, error: err.message });
    }
  }
  return results;
}

module.exports = {
  startLogin,
  submitCode,
  submitPassword,
  getStatus,
  disconnect,
  addGroup,
  listGroups,
  removeGroup,
  sendToGroups,
  listSentMessages,
  deleteMessagesByDbIds,
  buildInputPeer,
  getClient,
  listDialogs,
  importDialogs,
  initializeAllTelegramClients,
  listCapListCurrent,
  listCapListLog,
  capListCounts,
  clearCapList,
  hardPullGroups,
  CAP_LIST_REQUEST_TEXT,
  HARD_PULL_TEXT,
};
