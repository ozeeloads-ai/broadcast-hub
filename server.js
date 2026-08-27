require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');

const authRoutes = require('./src/routes/auth');
const telegramRoutes = require('./src/routes/telegram');
const emailRoutes = require('./src/routes/email');
const distanceRoutes = require('./src/routes/distance');
const scheduler = require('./src/services/scheduler');
const telegramManager = require('./src/services/telegramManager');

const app = express();
const PORT = process.env.PORT || 3000;

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
app.use('/api/telegram', telegramRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/distance', distanceRoutes);

app.use(express.static(path.join(__dirname, 'public')));

// SPA-ish fallback for the dashboard route
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.listen(PORT, () => {
  console.log(`Broadcast Hub listening on http://localhost:${PORT}`);
  scheduler.start();

  // Reconnect every user's Telegram client on boot so the Cap List listener
  // keeps capturing incoming group messages even when nobody is actively
  // using the dashboard right now.
  telegramManager.initializeAllTelegramClients().catch((err) => {
    console.error('[caplist] initial client warm-up failed:', err.message);
  });
});
