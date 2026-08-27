require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');

const authRoutes = require('./src/routes/auth');
const adminRoutes = require('./src/routes/admin');
const telegramRoutes = require('./src/routes/telegram');
const emailRoutes = require('./src/routes/email');
const distanceRoutes = require('./src/routes/distance');
const scheduler = require('./src/services/scheduler');
const telegramManager = require('./src/services/telegramManager');

const app = express();
const PORT = process.env.PORT || 3000;
// Cloud platforms like Railway proxy to 0.0.0.0 by default (leave HOST unset
// there). On a VPS behind nginx, set HOST=127.0.0.1 in .env so the app is
// only reachable through the reverse proxy, not directly on its own port.
const HOST = process.env.HOST || '0.0.0.0';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/telegram', telegramRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/distance', distanceRoutes);

app.use(express.static(path.join(__dirname, 'public')));

// SPA-ish fallback for the dashboard route
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Broadcast Hub listening on http://${HOST}:${PORT}`);
  scheduler.start();

  // Reconnect every user's Telegram client on boot so the Cap List listener
  // keeps capturing incoming group messages even when nobody is actively
  // using the dashboard right now.
  telegramManager.initializeAllTelegramClients().catch((err) => {
    console.error('[caplist] initial client warm-up failed:', err.message);
  });
});
