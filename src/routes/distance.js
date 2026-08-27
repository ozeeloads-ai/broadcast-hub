const express = require('express');
const { requireAuth } = require('../middleware/auth');
const distance = require('../services/distance');

const router = express.Router();
router.use(requireAuth);

router.post('/calculate', async (req, res) => {
  try {
    const { from, to } = req.body || {};
    if (!from || !to) {
      return res.status(400).json({ error: 'Укажите обе точки маршрута.' });
    }
    const result = await distance.getDistance(from, to);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
