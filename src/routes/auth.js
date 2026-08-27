const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');

const router = express.Router();

// No public signup: accounts are created only by the admin (see /api/admin).
router.post('/login', (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const { password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Неверный email или пароль.' });
  }
  req.session.userId = user.id;
  req.session.email = user.email;
  req.session.isAdmin = !!user.is_admin;
  res.json({ ok: true, email: user.email, isAdmin: !!user.is_admin });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (req.session && req.session.userId) {
    return res.json({ authenticated: true, email: req.session.email, isAdmin: !!req.session.isAdmin });
  }
  res.json({ authenticated: false });
});

module.exports = router;
