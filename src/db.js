const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { generatePassword } = require('./crypto');

// DB_PATH lets us point the database at a mounted persistent volume in
// production (e.g. Railway) instead of the app's own ephemeral filesystem.
// Falls back to a local file for VPS/manual runs.
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data.sqlite');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS telegram_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  phone TEXT,
  session_string TEXT,       -- encrypted GramJS StringSession
  display_name TEXT,
  connected_at TEXT
);

CREATE TABLE IF NOT EXISTS telegram_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,      -- Telegram entity id (as string, can be large)
  access_hash TEXT,
  peer_type TEXT NOT NULL,    -- 'channel' (supergroup/channel) or 'chat' (basic group)
  title TEXT,
  identifier TEXT,            -- what the user typed in (username / invite link / id)
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, chat_id)
);

CREATE TABLE IF NOT EXISTS sent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES telegram_groups(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  text TEXT,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  auto_delete_at TEXT,        -- NULL = no auto delete
  deleted_at TEXT             -- NULL until deleted (auto or manual)
);

CREATE TABLE IF NOT EXISTS email_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  smtp_host TEXT,
  smtp_port INTEGER,
  smtp_secure INTEGER,        -- 1 = TLS/SSL, 0 = STARTTLS/plain
  smtp_user TEXT,
  smtp_pass TEXT,             -- encrypted
  connected_at TEXT
);

-- Replaces email_accounts: lets each user connect several mailboxes (up to 5)
-- and pick which one to send a given broadcast from.
CREATE TABLE IF NOT EXISTS email_mailboxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT,
  email TEXT NOT NULL,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL,
  smtp_secure INTEGER NOT NULL DEFAULT 0,
  smtp_user TEXT NOT NULL,
  smtp_pass TEXT NOT NULL,     -- encrypted
  is_default INTEGER NOT NULL DEFAULT 0,
  connected_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mailboxes_user ON email_mailboxes(user_id);

-- Brokers are shared/global: any logged-in user can see the list, but only
-- an admin can add/edit/remove entries (enforced in the routes, not here).
CREATE TABLE IF NOT EXISTS brokers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- who added it
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  work_hours TEXT,
  email TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Logs every send attempt to a broker so we can compute a per-broker success %.
CREATE TABLE IF NOT EXISTS broker_send_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  broker_id INTEGER NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  success INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_broker_send_log_broker ON broker_send_log(broker_id);

-- Broker email sends run in the background instead of holding the HTTP
-- request open for the whole batch (a big broker list × the per-email delay
-- easily exceeds a reverse proxy's timeout, which was surfacing as 504s).
-- This table lets the client poll progress instead.
CREATE TABLE IF NOT EXISTS email_send_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_send_jobs_user ON email_send_jobs(user_id);

-- Cap List Puller: records the last time a user scanned their groups'
-- message HISTORY (looking backward, not forward) for cap-list lines, so the
-- UI can show "last pulled: N hours, at HH:MM, found X".
CREATE TABLE IF NOT EXISTS cap_list_pull_log (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_hours INTEGER NOT NULL,
  last_pulled_at TEXT NOT NULL,
  last_found_count INTEGER NOT NULL DEFAULT 0
);

-- Cap List: incoming Telegram messages from monitored groups get scanned for
-- lines like "Las Vegas NV Solo" / "CA Team" and logged here so dispatchers
-- can see, per group, the latest truck availability (city/state + team/solo).
CREATE TABLE IF NOT EXISTS cap_list_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES telegram_groups(id) ON DELETE CASCADE,
  chat_title TEXT,
  sender_name TEXT,
  raw_text TEXT,
  city TEXT,
  state TEXT,
  truck_type TEXT NOT NULL, -- 'team' or 'solo'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cap_list_user ON cap_list_entries(user_id);
`);

// ---- Lightweight migrations: add columns that didn't exist in older DBs ----

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('users', 'email', 'TEXT');
ensureColumn('users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)');

ensureColumn('brokers', 'rating', 'INTEGER'); // 0-4 = star count, 5 = "5★ ELITE", NULL = none
ensureColumn('brokers', 'shift', 'TEXT'); // 'day' | 'night' | NULL
ensureColumn('brokers', 'hours_from', 'TEXT');
ensureColumn('brokers', 'hours_to', 'TEXT');
ensureColumn('brokers', 'working_days', 'TEXT'); // comma-separated: Mo,Tu,We,...
ensureColumn('brokers', 'shuttle', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('brokers', 'is_online', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('brokers', 'birthday', 'TEXT');
ensureColumn('brokers', 'notes', 'TEXT');

// Tracks which Telegram message a cap-list entry came from, so a Cap List
// Puller history-scan doesn't create duplicate entries for a message the
// live listener already captured, or on a re-pull of an overlapping window.
ensureColumn('cap_list_entries', 'tg_message_id', 'INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS idx_cap_list_group_msg ON cap_list_entries(group_id, tg_message_id)');

// One-time copy of any legacy single-mailbox rows into the new multi-mailbox
// table, so users who connected mail before this update don't lose it.
const legacyAccounts = db.prepare('SELECT * FROM email_accounts').all();
for (const acc of legacyAccounts) {
  const already = db
    .prepare('SELECT id FROM email_mailboxes WHERE user_id = ? AND smtp_user = ? AND smtp_host = ?')
    .get(acc.user_id, acc.smtp_user, acc.smtp_host);
  if (already) continue;
  db.prepare(
    `INSERT INTO email_mailboxes (user_id, label, email, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, is_default, connected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(acc.user_id, 'Основной', acc.email, acc.smtp_host, acc.smtp_port, acc.smtp_secure, acc.smtp_user, acc.smtp_pass, acc.connected_at);
}

// ---- Admin bootstrap ----
// Access is admin-controlled only: nobody can self-register. The one
// account named by ADMIN_EMAIL (in .env) is promoted to admin on every
// startup, and created automatically the first time if it doesn't exist yet.
function logGeneratedAdminPassword(email, password) {
  console.log('================================================');
  console.log(' Admin-аккаунт готов:');
  console.log(` Email:  ${email}`);
  console.log(` Пароль: ${password}`);
  console.log(' Сохраните пароль сейчас — он больше нигде не показывается.');
  console.log(' (Чтобы задать свой пароль, добавьте ADMIN_PASSWORD в .env и перезапустите.)');
  console.log('================================================');
}

function ensureAdminUser() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!email) return;

  // Look up by email first, but also fall back to matching by username: an
  // account created before admin-only access existed (the old signup form)
  // may have this address stored as its "username" with no email set yet.
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    user = db.prepare('SELECT * FROM users WHERE username = ?').get(email);
  }

  const explicitPassword = (process.env.ADMIN_PASSWORD || '').trim();

  // What password should end up set, if any this run:
  //  - ADMIN_PASSWORD in .env always wins (operator explicitly wants it applied
  //    now, even if this account is already an admin from a previous run —
  //    that's exactly how you change it).
  //  - otherwise, only generate+print a random one the first time this
  //    account becomes admin, so plain restarts never rotate the password.
  let passwordToApply = null;
  let shouldLog = false;
  if (explicitPassword) {
    passwordToApply = explicitPassword;
  } else if (!user || !user.is_admin) {
    passwordToApply = generatePassword(12);
    shouldLog = true;
  }

  if (user) {
    const sets = ['is_admin = 1'];
    const params = { id: user.id };
    if (!user.email) {
      sets.push('email = @email');
      params.email = email;
    }
    if (passwordToApply) {
      sets.push('password_hash = @hash');
      params.hash = bcrypt.hashSync(passwordToApply, 10);
    }
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = @id`).run(params);
  } else {
    db.prepare('INSERT INTO users (username, email, password_hash, is_admin) VALUES (?, ?, ?, 1)').run(
      email,
      email,
      bcrypt.hashSync(passwordToApply, 10)
    );
  }

  if (shouldLog) logGeneratedAdminPassword(email, passwordToApply);
}

ensureAdminUser();

module.exports = db;
