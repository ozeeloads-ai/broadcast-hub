// Admin-only user management: the admin (ADMIN_EMAIL in .env) is the only
// person who can let someone into the app. Adding a user here IS the
// "allowlist" — only emails that exist as a user row can log in at all, and
// only the admin can generate/reset a participant's password.

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { generatePassword } = require('../crypto');

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/users', (req, res) => {
  const users = db
    .prepare('SELECT id, email, is_admin, created_at FROM users ORDER BY created_at DESC')
    .all();
  res.json(users.map((u) => ({ id: u.id, email: u.email, isAdmin: !!u.is_admin, createdAt: u.created_at })));
});

router.post('/users', (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Укажите корректный email.' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.status(409).json({ error: 'Пользователь с таким email уже существует.' });
  }
  const password = generatePassword(10);
  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (username, email, password_hash, is_admin) VALUES (?, ?, ?, 0)')
    .run(email, email, hash);
  res.json({ id: info.lastInsertRowid, email, password });
});

router.post('/users/:id/reset-password', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден.' });
  const password = generatePassword(10);
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
  res.json({ email: user.email, password });
});

router.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session.userId) {
    return res.status(400).json({ error: 'Нельзя удалить свой собственный аккаунт.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (user && user.is_admin) {
    return res.status(400).json({ error: 'Нельзя удалить администратора.' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
