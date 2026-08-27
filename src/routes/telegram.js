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
