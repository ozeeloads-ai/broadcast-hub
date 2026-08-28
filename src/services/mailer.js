// Email Sender: each user can connect up to 5 of their own mailboxes via
// SMTP (Gmail/Outlook app password, or any custom SMTP server) and pick
// which one to send a given broadcast from. Credentials are encrypted at rest.
//
// Brokers are a single shared/global list (visible to every logged-in user)
// so nobody has to re-enter them by hand — only an admin can add/edit/remove
// a broker (enforced in the route layer), everyone else just sees the list
// and can send to it.

const nodemailer = require('nodemailer');
const { encrypt, decrypt } = require('../crypto');
const db = require('../db');

const MAX_MAILBOXES_PER_USER = 5;
const NEW_BROKER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // "NEW" badge for a week
const MIN_SEND_DELAY_SECONDS = 2;
const MAX_SEND_DELAY_SECONDS = 300;

function buildTransport(account) {
  return nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure: !!account.smtp_secure, // true for 465, false for 587/25 (STARTTLS)
    auth: {
      user: account.smtp_user,
      pass: decrypt(account.smtp_pass),
    },
  });
}

// ---- Mailboxes (multi-account) ----

function serializeMailbox(row) {
  return {
    id: row.id,
    label: row.label || row.email,
    email: row.email,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    smtpSecure: !!row.smtp_secure,
    isDefault: !!row.is_default,
    connectedAt: row.connected_at,
  };
}

function listMailboxes(userId) {
  return db
    .prepare('SELECT * FROM email_mailboxes WHERE user_id = ? ORDER BY is_default DESC, connected_at ASC')
    .all(userId)
    .map(serializeMailbox);
}

async function connectMailbox(userId, { label, email, smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass }) {
  if (!email || !smtpHost || !smtpPort || !smtpUser || !smtpPass) {
    throw new Error('Заполните все поля: email, SMTP-сервер, порт, логин и пароль.');
  }
  const count = db.prepare('SELECT COUNT(*) AS c FROM email_mailboxes WHERE user_id = ?').get(userId).c;
  if (count >= MAX_MAILBOXES_PER_USER) {
    throw new Error(`Можно подключить не более ${MAX_MAILBOXES_PER_USER} почтовых ящиков.`);
  }

  const account = {
    smtp_host: smtpHost,
    smtp_port: Number(smtpPort),
    smtp_secure: smtpSecure ? 1 : 0,
    smtp_user: smtpUser,
    smtp_pass: encrypt(smtpPass),
  };

  // Verify the credentials actually work before saving.
  const transporter = buildTransport(account);
  await transporter.verify();

  const isFirst = count === 0 ? 1 : 0;
  const info = db
    .prepare(
      `INSERT INTO email_mailboxes (user_id, label, email, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, is_default, connected_at)
       VALUES (@userId, @label, @email, @smtp_host, @smtp_port, @smtp_secure, @smtp_user, @smtp_pass, @isFirst, datetime('now'))`
    )
    .run({ userId, label: label || email, email, ...account, isFirst });

  return serializeMailbox(db.prepare('SELECT * FROM email_mailboxes WHERE id = ?').get(info.lastInsertRowid));
}

function setDefaultMailbox(userId, id) {
  const row = db.prepare('SELECT * FROM email_mailboxes WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) throw new Error('Почтовый ящик не найден.');
  db.prepare('UPDATE email_mailboxes SET is_default = 0 WHERE user_id = ?').run(userId);
  db.prepare('UPDATE email_mailboxes SET is_default = 1 WHERE id = ?').run(id);
}

function disconnectMailbox(userId, id) {
  const row = db.prepare('SELECT * FROM email_mailboxes WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return;
  db.prepare('DELETE FROM email_mailboxes WHERE id = ?').run(id);
  if (row.is_default) {
    const next = db
      .prepare('SELECT id FROM email_mailboxes WHERE user_id = ? ORDER BY connected_at ASC LIMIT 1')
      .get(userId);
    if (next) db.prepare('UPDATE email_mailboxes SET is_default = 1 WHERE id = ?').run(next.id);
  }
}

function getMailboxForSend(userId, mailboxId) {
  const row = mailboxId
    ? db.prepare('SELECT * FROM email_mailboxes WHERE id = ? AND user_id = ?').get(mailboxId, userId)
    : db.prepare('SELECT * FROM email_mailboxes WHERE user_id = ? AND is_default = 1').get(userId) ||
      db.prepare('SELECT * FROM email_mailboxes WHERE user_id = ? ORDER BY connected_at ASC LIMIT 1').get(userId);
  if (!row) throw new Error('Сначала подключите почтовый ящик.');
  return row;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function serializeSendJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    total: row.total,
    completed: row.completed,
    successCount: row.success_count,
    failCount: row.fail_count,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function getSendJob(userId, jobId) {
  return serializeSendJob(db.prepare('SELECT * FROM email_send_jobs WHERE id = ? AND user_id = ?').get(jobId, userId));
}

// Validates everything synchronously (so bad input still fails fast with a
// normal error response), then runs the actual send loop in the background
// instead of making the HTTP request wait for it — a broker list combined
// with the per-email delay can take minutes, which was exceeding the
// reverse proxy's timeout and coming back as a 504 before this had a chance
// to finish. The client polls getSendJob() for progress instead.
function startSendJob(userId, mailboxId, brokerIds, subject, text, delaySeconds) {
  const account = getMailboxForSend(userId, mailboxId);

  const delayMs =
    Math.min(MAX_SEND_DELAY_SECONDS, Math.max(MIN_SEND_DELAY_SECONDS, Number(delaySeconds) || MIN_SEND_DELAY_SECONDS)) *
    1000;

  const brokers = db
    .prepare(`SELECT * FROM brokers WHERE id IN (${brokerIds.map(() => '?').join(',')})`)
    .all(...brokerIds);
  if (!brokers.length) {
    throw new Error('Брокеры не найдены.');
  }

  const transporter = buildTransport(account);

  const jobInfo = db
    .prepare('INSERT INTO email_send_jobs (user_id, total, status) VALUES (?, ?, ?)')
    .run(userId, brokers.length, 'running');
  const jobId = jobInfo.lastInsertRowid;

  const logStmt = db.prepare('INSERT INTO broker_send_log (broker_id, user_id, success) VALUES (?, ?, ?)');
  const progressStmt = db.prepare(
    'UPDATE email_send_jobs SET completed = completed + 1, success_count = success_count + ?, fail_count = fail_count + ? WHERE id = ?'
  );
  const finishStmt = db.prepare(
    "UPDATE email_send_jobs SET status = 'done', finished_at = datetime('now') WHERE id = ?"
  );
  const failJobStmt = db.prepare(
    "UPDATE email_send_jobs SET status = 'done', error = ?, finished_at = datetime('now') WHERE id = ?"
  );

  // Deliberately not awaited — this runs after startSendJob has already
  // returned the jobId to the caller.
  (async () => {
    try {
      for (let i = 0; i < brokers.length; i++) {
        const broker = brokers[i];
        if (i > 0 && delayMs > 0) await sleep(delayMs);
        try {
          await transporter.sendMail({ from: account.email, to: broker.email, subject, text });
          logStmt.run(broker.id, userId, 1);
          progressStmt.run(1, 0, jobId);
        } catch (err) {
          logStmt.run(broker.id, userId, 0);
          progressStmt.run(0, 1, jobId);
        }
      }
      finishStmt.run(jobId);
    } catch (err) {
      failJobStmt.run(err.message, jobId);
    }
  })();

  return { jobId, total: brokers.length };
}

// ---- Broker CRUD (global list; write access gated by requireAdmin in the route) ----

function normalizeWorkingDays(workingDays) {
  if (Array.isArray(workingDays)) return workingDays.filter(Boolean).join(',');
  return workingDays || '';
}

function addBroker(
  userId,
  { firstName, lastName, email, workHours, rating, shift, hoursFrom, hoursTo, workingDays, shuttle, birthday, notes }
) {
  if (!firstName || !lastName || !email) {
    throw new Error('Укажите имя, фамилию и email брокера.');
  }
  const info = db
    .prepare(
      `INSERT INTO brokers
        (user_id, first_name, last_name, work_hours, email, rating, shift, hours_from, hours_to, working_days, shuttle, is_online, birthday, notes)
       VALUES (@userId, @firstName, @lastName, @workHours, @email, @rating, @shift, @hoursFrom, @hoursTo, @workingDays, @shuttle, 1, @birthday, @notes)`
    )
    .run({
      userId,
      firstName,
      lastName,
      workHours: workHours || '',
      email,
      rating: rating === undefined || rating === null || rating === '' ? null : Number(rating),
      shift: shift || null,
      hoursFrom: hoursFrom || null,
      hoursTo: hoursTo || null,
      workingDays: normalizeWorkingDays(workingDays),
      shuttle: shuttle ? 1 : 0,
      birthday: birthday || null,
      notes: notes || '',
    });
  return getBroker(info.lastInsertRowid);
}

function getBroker(id) {
  return serializeBroker(db.prepare('SELECT * FROM brokers WHERE id = ?').get(id));
}

function serializeBroker(row) {
  if (!row) return null;
  const stats = db
    .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(success), 0) AS successes FROM broker_send_log WHERE broker_id = ?')
    .get(row.id);
  const percentage = stats.total > 0 ? Math.round((stats.successes / stats.total) * 100) : 0;
  const addedAtMs = Date.parse(`${row.added_at.replace(' ', 'T')}Z`);
  const isNew = Number.isFinite(addedAtMs) ? Date.now() - addedAtMs < NEW_BROKER_WINDOW_MS : false;

  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    workHours: row.work_hours || '',
    rating: row.rating === null || row.rating === undefined ? null : Number(row.rating),
    shift: row.shift || null,
    hoursFrom: row.hours_from || null,
    hoursTo: row.hours_to || null,
    workingDays: row.working_days ? row.working_days.split(',').filter(Boolean) : [],
    shuttle: !!row.shuttle,
    isOnline: !!row.is_online,
    birthday: row.birthday || null,
    notes: row.notes || '',
    addedAt: row.added_at,
    isNew,
    percentage,
    sendCount: stats.total,
  };
}

function listBrokers() {
  const rows = db.prepare('SELECT * FROM brokers ORDER BY added_at DESC').all();
  return rows.map(serializeBroker);
}

function updateBroker(
  id,
  { firstName, lastName, email, workHours, rating, shift, hoursFrom, hoursTo, workingDays, shuttle, birthday, notes }
) {
  const existing = db.prepare('SELECT * FROM brokers WHERE id = ?').get(id);
  if (!existing) throw new Error('Брокер не найден.');
  db.prepare(
    `UPDATE brokers SET
       first_name = @firstName, last_name = @lastName, work_hours = @workHours, email = @email,
       rating = @rating, shift = @shift, hours_from = @hoursFrom, hours_to = @hoursTo,
       working_days = @workingDays, shuttle = @shuttle, birthday = @birthday, notes = @notes
     WHERE id = @id`
  ).run({
    id,
    firstName: firstName || existing.first_name,
    lastName: lastName || existing.last_name,
    workHours: workHours !== undefined ? workHours : existing.work_hours,
    email: email || existing.email,
    rating: rating === undefined || rating === null || rating === '' ? existing.rating : Number(rating),
    shift: shift !== undefined ? shift || null : existing.shift,
    hoursFrom: hoursFrom !== undefined ? hoursFrom || null : existing.hours_from,
    hoursTo: hoursTo !== undefined ? hoursTo || null : existing.hours_to,
    workingDays: workingDays !== undefined ? normalizeWorkingDays(workingDays) : existing.working_days,
    shuttle: shuttle !== undefined ? (shuttle ? 1 : 0) : existing.shuttle,
    birthday: birthday !== undefined ? birthday || null : existing.birthday,
    notes: notes !== undefined ? notes : existing.notes,
  });
  return getBroker(id);
}

function setBrokerOnline(id, isOnline) {
  db.prepare('UPDATE brokers SET is_online = ? WHERE id = ?').run(isOnline ? 1 : 0, id);
  return getBroker(id);
}

// Any logged-in user (not just admins) may fill in or correct a broker's
// email address — the one field the whole team is expected to keep current
// even without full edit access to the rest of the broker's record.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function setBrokerEmail(id, email) {
  const trimmed = (email || '').trim();
  if (!EMAIL_RE.test(trimmed)) {
    throw new Error('Введите корректный email.');
  }
  const existing = db.prepare('SELECT * FROM brokers WHERE id = ?').get(id);
  if (!existing) throw new Error('Брокер не найден.');
  db.prepare('UPDATE brokers SET email = ? WHERE id = ?').run(trimmed, id);
  return getBroker(id);
}

function removeBroker(id) {
  db.prepare('DELETE FROM brokers WHERE id = ?').run(id);
}

// ---- CSV import ----
// Minimal, dependency-free CSV parser (handles quoted fields with embedded
// commas/newlines). Expected columns (English or Russian header, any order):
// Name/Имя (as "Last, First" or just a name), Email, and optionally
// Shift/Смена, Hours From/С, Hours To/До, Working Days/Рабочие дни,
// Rating/Звёзды (0-5), Shuttle, Birthday/День рождения, Notes/Заметки.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // skip, \n follows
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const HEADER_ALIASES = {
  name: 'name',
  'имя': 'name',
  email: 'email',
  shift: 'shift',
  'смена': 'shift',
  'hours from': 'hoursFrom',
  'с': 'hoursFrom',
  'hours to': 'hoursTo',
  'до': 'hoursTo',
  'working days': 'workingDays',
  'рабочие дни': 'workingDays',
  rating: 'rating',
  'звезды': 'rating',
  'звёзды': 'rating',
  shuttle: 'shuttle',
  birthday: 'birthday',
  'день рождения': 'birthday',
  notes: 'notes',
  'заметки': 'notes',
};

function importBrokersCsv(userId, csvText) {
  const rows = parseCsv(String(csvText || ''));
  if (rows.length < 2) throw new Error('CSV пустой или без данных.');

  const header = rows[0].map((h) => HEADER_ALIASES[h.trim().toLowerCase()] || null);
  const nameIdx = header.indexOf('name');
  const emailIdx = header.indexOf('email');
  if (nameIdx === -1 || emailIdx === -1) {
    throw new Error('В CSV должны быть колонки Name (Имя) и Email.');
  }

  let imported = 0;
  const errors = [];
  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    const email = (cols[emailIdx] || '').trim();
    const nameRaw = (cols[nameIdx] || '').trim();
    if (!email || !nameRaw) continue;

    let lastName = '';
    let firstName = nameRaw;
    if (nameRaw.includes(',')) {
      const [last, first] = nameRaw.split(',');
      lastName = (last || '').trim();
      firstName = (first || '').trim();
    }

    const get = (key) => {
      const idx = header.indexOf(key);
      return idx === -1 ? undefined : (cols[idx] || '').trim();
    };

    try {
      addBroker(userId, {
        firstName: firstName || nameRaw,
        lastName,
        email,
        shift: get('shift') ? get('shift').toLowerCase() : undefined,
        hoursFrom: get('hoursFrom'),
        hoursTo: get('hoursTo'),
        workingDays: get('workingDays') ? get('workingDays').split(/[/,;]/).map((s) => s.trim()) : undefined,
        rating: get('rating') !== undefined && get('rating') !== '' ? get('rating') : undefined,
        shuttle: /^(1|true|yes|да)$/i.test(get('shuttle') || ''),
        birthday: get('birthday'),
        notes: get('notes'),
      });
      imported++;
    } catch (err) {
      errors.push(`${nameRaw} <${email}>: ${err.message}`);
    }
  }
  return { imported, errors };
}

module.exports = {
  MIN_SEND_DELAY_SECONDS,
  MAX_SEND_DELAY_SECONDS,
  MAX_MAILBOXES_PER_USER,
  listMailboxes,
  connectMailbox,
  setDefaultMailbox,
  disconnectMailbox,
  startSendJob,
  getSendJob,
  addBroker,
  listBrokers,
  updateBroker,
  setBrokerOnline,
  setBrokerEmail,
  removeBroker,
  importBrokersCsv,
};
