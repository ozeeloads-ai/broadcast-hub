const express = require('express');
const { requireAuth } = require('../middleware/auth');
const mailer = require('../services/mailer');

const router = express.Router();
router.use(requireAuth);

router.get('/status', (req, res) => {
  res.json(mailer.getStatus(req.session.userId));
});

router.post('/connect', async (req, res) => {
  try {
    const account = await mailer.connectAccount(req.session.userId, req.body || {});
    res.json(account);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/disconnect', (req, res) => {
  mailer.disconnect(req.session.userId);
  res.json({ ok: true });
});

router.get('/brokers', (req, res) => {
  res.json(mailer.listBrokers(req.session.userId));
});

router.post('/brokers', (req, res) => {
  try {
    const broker = mailer.addBroker(req.session.userId, req.body || {});
    res.json(broker);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/brokers/:id', (req, res) => {
  try {
    mailer.updateBroker(req.session.userId, Number(req.params.id), req.body || {});
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/brokers/:id', (req, res) => {
  mailer.removeBroker(req.session.userId, Number(req.params.id));
  res.json({ ok: true });
});

router.post('/send', async (req, res) => {
  try {
    const { brokerIds, subject, text, delaySeconds } = req.body || {};
    if (!Array.isArray(brokerIds) || brokerIds.length === 0) {
      return res.status(400).json({ error: 'Выберите хотя бы одного брокера.' });
    }
    if (!subject || !text) {
      return res.status(400).json({ error: 'Заполните тему и текст письма.' });
    }
    const results = await mailer.sendToBrokers(req.session.userId, brokerIds, subject, text, delaySeconds);
    res.json({ results });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
