const express = require('express');
const { requireAuth } = require('../middleware/auth');
const tg = require('../services/telegramManager');

const router = express.Router();
router.use(requireAuth);

router.get('/status', (req, res) => {
  res.json(tg.getStatus(req.session.userId));
});

router.post('/login/start', async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'Укажите номер телефона в формате +996700000000' });
    const result = await tg.startLogin(req.session.userId, phone);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/login/code', async (req, res) => {
  try {
    const { token, code } = req.body || {};
    const result = await tg.submitCode(token, code);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/login/password', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    const result = await tg.submitPassword(token, password);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/disconnect', async (req, res) => {
  await tg.disconnect(req.session.userId);
  res.json({ ok: true });
});

router.get('/groups', (req, res) => {
  res.json(tg.listGroups(req.session.userId));
});

router.post('/groups', async (req, res) => {
  try {
    const { identifier } = req.body || {};
    if (!identifier) return res.status(400).json({ error: 'Укажите @username, ссылку-приглашение или ID группы.' });
    const group = await tg.addGroup(req.session.userId, identifier);
    res.json(group);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/groups/:id', (req, res) => {
  tg.removeGroup(req.session.userId, Number(req.params.id));
  res.json({ ok: true });
});

router.get('/dialogs', async (req, res) => {
  try {
    const kind = req.query.kind === 'private' ? 'private' : 'groups';
    const dialogs = await tg.listDialogs(req.session.userId, kind);
    res.json(dialogs);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/dialogs/import', async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Не выбрано ни одного чата.' });
    }
    const results = await tg.importDialogs(req.session.userId, ids);
    res.json({ results });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/caplist/template', (req, res) => {
  res.json({ text: tg.CAP_LIST_REQUEST_TEXT });
});

router.get('/caplist', (req, res) => {
  const kind = ['team', 'solo'].includes(req.query.kind) ? req.query.kind : null;
  const search = (req.query.search || '').trim();
  res.json({
    entries: tg.listCapListCurrent(req.session.userId, { kind, search }),
    counts: tg.capListCounts(req.session.userId),
  });
});

router.get('/caplist/log', (req, res) => {
  const kind = ['team', 'solo'].includes(req.query.kind) ? req.query.kind : null;
  const search = (req.query.search || '').trim();
  res.json({
    entries: tg.listCapListLog(req.session.userId, { kind, search }),
    counts: tg.capListCounts(req.session.userId),
  });
});

router.post('/caplist/clear', (req, res) => {
  tg.clearCapList(req.session.userId);
  res.json({ ok: true });
});

// Mentions every member of the chosen groups and asks them for a load list.
// Runs in the background (member lookup + several batched messages per group
// with flood-safe delays); poll /caplist/tagall/status/:jobId for progress.
router.post('/caplist/tagall', (req, res) => {
  try {
    const { groupIds, text, batchSize, delaySeconds, autoDeleteMinutes } = req.body || {};
    const job = tg.startTagAllJob(req.session.userId, groupIds, text, {
      batchSize,
      delaySeconds,
      autoDeleteMinutes,
    });
    res.json(job);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/caplist/tagall/settings', (req, res) => {
  res.json(tg.getTagAllSettings(req.session.userId));
});

router.post('/caplist/tagall/settings', (req, res) => {
  try {
    res.json(tg.setTagAllSettings(req.session.userId, (req.body || {}).excludedUsernames));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/groups/:id/notag', (req, res) => {
  try {
    res.json(tg.setGroupNoTag(req.session.userId, Number(req.params.id), !!(req.body || {}).noTag));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/caplist/tagall/status/:jobId', (req, res) => {
  const job = tg.getTagAllJob(req.session.userId, Number(req.params.jobId));
  if (!job) return res.status(404).json({ error: 'Задача не найдена.' });
  res.json(job);
});

router.get('/caplist/pull/status', (req, res) => {
  const log = tg.getLastPull(req.session.userId);
  res.json({
    lastHours: log ? log.last_hours : null,
    lastPulledAt: log ? log.last_pulled_at : null,
    lastFoundCount: log ? log.last_found_count : null,
  });
});

// Scans message HISTORY for the past 1-3 hours (looking backward at what's
// already been posted) and fills the cap list table — it never sends anything
// to the group. Starts in the background and returns immediately; poll
// /caplist/pull/job/:jobId for progress.
router.post('/caplist/pull', (req, res) => {
  try {
    const { hours } = req.body || {};
    res.json(tg.startCapListPullJob(req.session.userId, hours));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/caplist/pull/job/:jobId', (req, res) => {
  const job = tg.getCapListPullJob(req.session.userId, Number(req.params.jobId));
  if (!job) return res.status(404).json({ error: 'Задача не найдена.' });
  res.json(job);
});

router.post('/send', async (req, res) => {
  try {
    const { groupIds, text, autoDeleteMinutes } = req.body || {};
    if (!Array.isArray(groupIds) || groupIds.length === 0) {
      return res.status(400).json({ error: 'Выберите хотя бы одну группу.' });
    }
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Введите текст сообщения.' });
    }
    const results = await tg.sendToGroups(req.session.userId, groupIds, text, autoDeleteMinutes);
    res.json({ results });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/messages', (req, res) => {
  const groupId = req.query.groupId ? Number(req.query.groupId) : undefined;
  res.json(tg.listSentMessages(req.session.userId, groupId));
});

router.post('/messages/delete', async (req, res) => {
  try {
    const { messageDbIds } = req.body || {};
    if (!Array.isArray(messageDbIds) || messageDbIds.length === 0) {
      return res.status(400).json({ error: 'Не выбрано ни одного сообщения.' });
    }
    const results = await tg.deleteMessagesByDbIds(req.session.userId, messageDbIds);
    res.json({ results });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
