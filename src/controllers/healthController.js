/**
 * Health & readiness endpoints.
 * /health  → liveness, always 200
 * /ready   → readiness, 200 only when DB is connected
 */
const mongoose = require('mongoose');

exports.health = (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
};

exports.ready = (_req, res) => {
  const dbState = mongoose.connection.readyState; // 1 = connected
  const ok = dbState === 1;
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ready' : 'not_ready',
    db: dbState,
    timestamp: new Date().toISOString(),
  });
};
