const path = require('path');
const Database = require('better-sqlite3');

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

CREATE TABLE IF NOT EXISTS brokers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  work_hours TEXT,
  email TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = db;
