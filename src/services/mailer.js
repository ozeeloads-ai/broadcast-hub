// Per-user email sending. Each user connects their OWN mailbox via SMTP
// (Gmail/Outlook app password, or any custom SMTP server) and the app sends
// on their behalf using nodemailer. Credentials are encrypted at rest.

const nodemailer = require('nodemailer');
const { encrypt, decrypt } = require('../crypto');
const db = require('../db');

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

async function connectAccount(userId, { email, smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass }) {
  if (!email || !smtpHost || !smtpPort || !smtpUser || !smtpPass) {
    throw new Error('Заполните все поля: email, SMTP-сервер, порт, логин и пароль.');
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

  db.prepare(
    `INSERT INTO email_accounts (user_id, email, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, connected_at)
     VALUES (@userId, @email, @smtp_host, @smtp_port, @smtp_secure, @smtp_user, @smtp_pass, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       email=excluded.email, smtp_host=excluded.smtp_host, smtp_port=excluded.smtp_port,
       smtp_secure=excluded.smtp_secure, smtp_user=excluded.smtp_user, smtp_pass=excluded.smtp_pass,
       connected_at=excluded.connected_at`
  ).run({ userId, email, ...account });

  return { connected: true, email };
}

function getStatus(userId) {
  const row = db.prepare('SELECT email, smtp_host, connected_at FROM email_accounts WHERE user_id = ?').get(userId);
  if (!row) return { connected: false };
  return { connected: true, email: row.email, smtpHost: row.smtp_host, connectedAt: row.connected_at };
}

function disconnect(userId) {
  db.prepare('DELETE FROM email_accounts WHERE user_id = ?').run(userId);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendToBrokers(userId, brokerIds, subject, text, delaySeconds = 0) {
  const account = db.prepare('SELECT * FROM email_accounts WHERE user_id = ?').get(userId);
  if (!account) throw new Error('Сначала подключите свою почту.');

  const delayMs = Math.min(5, Math.max(0, Number(delaySeconds) || 0)) * 1000;

  const brokers = db
    .prepare(`SELECT * FROM brokers WHERE user_id = ? AND id IN (${brokerIds.map(() => '?').join(',')})`)
    .all(userId, ...brokerIds);

  const transporter = buildTransport(account);
  const results = [];
  for (let i = 0; i < brokers.length; i++) {
    const broker = brokers[i];
    if (i > 0 && delayMs > 0) await sleep(delayMs);
    try {
      await transporter.sendMail({
        from: account.email,
        to: broker.email,
        subject,
        text,
      });
      results.push({ brokerId: broker.id, email: broker.email, ok: true });
    } catch (err) {
      results.push({ brokerId: broker.id, email: broker.email, ok: false, error: err.message });
    }
  }
  return results;
}

// ---- Broker CRUD ----

function addBroker(userId, { firstName, lastName, workHours, email }) {
  if (!firstName || !lastName || !email) {
    throw new Error('Укажите имя, фамилию и email брокера.');
  }
  const info = db
    .prepare('INSERT INTO brokers (user_id, first_name, last_name, work_hours, email) VALUES (?, ?, ?, ?, ?)')
    .run(userId, firstName, lastName, workHours || '', email);
  return { id: info.lastInsertRowid, firstName, lastName, workHours, email };
}

function listBrokers(userId) {
  return db.prepare('SELECT * FROM brokers WHERE user_id = ? ORDER BY added_at DESC').all(userId);
}

function updateBroker(userId, id, { firstName, lastName, workHours, email }) {
  db.prepare(
    `UPDATE brokers SET first_name = ?, last_name = ?, work_hours = ?, email = ? WHERE user_id = ? AND id = ?`
  ).run(firstName, lastName, workHours || '', email, userId, id);
}

function removeBroker(userId, id) {
  db.prepare('DELETE FROM brokers WHERE user_id = ? AND id = ?').run(userId, id);
}

module.exports = {
  connectAccount,
  getStatus,
  disconnect,
  sendToBrokers,
  addBroker,
  listBrokers,
  updateBroker,
  removeBroker,
};
