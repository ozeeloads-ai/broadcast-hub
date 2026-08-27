const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const mailer = require('../services/mailer');

const router = express.Router();
router.use(requireAuth);

// ---- Mailboxes (each user can connect up to 5) ----

router.get('/mailboxes', (req, res) => {
  res.json(mailer.listMailboxes(req.session.userId));
});

router.post('/mailboxes', async (req, res) => {
  try {
    const mailbox = await mailer.connectMailbox(req.session.userId, req.body || {});
    res.json(mailbox);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/mailboxes/:id/default', (req, res) => {
  try {
    mailer.setDefaultMailbox(req.session.userId, Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/mailboxes/:id', (req, res) => {
  mailer.disconnectMailbox(req.session.userId, Number(req.params.id));
  res.json({ ok: true });
});

// ---- Brokers (global list; only an admin can add/edit/remove) ----

router.get('/brokers', (req, res) => {
  res.json(mailer.listBrokers());
});

router.post('/brokers', requireAdmin, (req, res) => {
  try {
    const broker = mailer.addBroker(req.session.userId, req.body || {});
    res.json(broker);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/brokers/import', requireAdmin, (req, res) => {
  try {
    const { csv } = req.body || {};
    const result = mailer.importBrokersCsv(req.session.userId, csv);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/brokers/:id', requireAdmin, (req, res) => {
  try {
    const broker = mailer.updateBroker(Number(req.params.id), req.body || {});
    res.json(broker);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Open to any logged-in user, not just admins — anyone on the team can add
// or fix a broker's email address even without full edit access.
router.post('/brokers/:id/email', (req, res) => {
  try {
    const broker = mailer.setBrokerEmail(Number(req.params.id), (req.body || {}).email);
    res.json(broker);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/brokers/:id/online', requireAdmin, (req, res) => {
  try {
    const broker = mailer.setBrokerOnline(Number(req.params.id), !!(req.body || {}).online);
    res.json(broker);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/brokers/:id', requireAdmin, (req, res) => {
  mailer.removeBroker(Number(req.params.id));
  res.json({ ok: true });
});

// ---- Send ----

router.post('/send', async (req, res) => {
  try {
    const { mailboxId, brokerIds, subject, text, delaySeconds } = req.body || {};
    if (!Array.isArray(brokerIds) || brokerIds.length === 0) {
      return res.status(400).json({ error: 'Выберите хотя бы одного брокера.' });
    }
    if (!subject || !text) {
      return res.status(400).json({ error: 'Заполните тему и текст письма.' });
    }
    const results = await mailer.sendToBrokers(req.session.userId, mailboxId, brokerIds, subject, text, delaySeconds);
    res.json({ results });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
