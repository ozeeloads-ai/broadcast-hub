// Background job: every 30 seconds, (1) finds sent Telegram messages whose
// auto-delete time has passed and deletes them via the owning user's
// Telegram session, marking them deleted in the DB, and (2) runs any Cap
// List Puller auto-pulls that have come due.

const db = require('../db');
const telegramManager = require('./telegramManager');

const CHECK_INTERVAL_MS = 30 * 1000;

async function runOnce() {
  const due = db
    .prepare(
      `SELECT id, user_id FROM sent_messages
       WHERE auto_delete_at IS NOT NULL AND deleted_at IS NULL AND auto_delete_at <= datetime('now')`
    )
    .all();

  if (due.length > 0) {
    const byUser = new Map();
    for (const row of due) {
      if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
      byUser.get(row.user_id).push(row.id);
    }

    for (const [userId, ids] of byUser.entries()) {
      try {
        await telegramManager.deleteMessagesByDbIds(userId, ids);
      } catch (err) {
        console.error(`[scheduler] auto-delete failed for user ${userId}:`, err.message);
      }
    }
  }

  try {
    await telegramManager.runDueAutoPulls();
  } catch (err) {
    console.error('[scheduler] cap list auto-pull failed:', err.message);
  }
}

function start() {
  setInterval(() => {
    runOnce().catch((err) => console.error('[scheduler] error:', err.message));
  }, CHECK_INTERVAL_MS).unref();
  console.log('[scheduler] auto-delete watcher + cap list auto-pull started (checks every 30s)');
}

module.exports = { start, runOnce };
