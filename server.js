require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const http = require('http');
const { Server } = require('socket.io');

// Fail fast when auth secrets are missing instead of signing tokens with
// `undefined` (jsonwebtoken would throw on first login) or deriving weak
// file-encryption keys. Every deployment (including Railway) must set these.
if (!process.env.JWT_SECRET) {
  console.error('[fatal] JWT_SECRET is not set — refusing to start.');
  process.exit(1);
}

const authRoutes = require('./routes/auth');
const groupRoutes = require('./routes/groups');
const conversationRoutes = require('./routes/conversations');
const notificationRoutes = require('./routes/notifications');
const uploadRoutes = require('./routes/uploads');
const logRoutes = require('./routes/logs');
const roleRoutes = require('./routes/roles');
const userRoutes = require('./routes/users');
const dashboardRoutes = require('./routes/dashboard');
const adminRoutes = require('./routes/admin');
const superadminRoutes = require('./routes/superadmin');
const stickerRoutes = require('./routes/stickers');
const { registerSocketHandlers } = require('./sockets');
const { registerDashboardNamespace } = require('./sockets/dashboard');
const { registerCoreListeners } = require('./events/listeners');
const logger = require('./helpers/logger');
const { ensureDefaultSuperAdmin } = require('./helpers/superAdmin');
const { createRateLimiter } = require('./helpers/rateLimiter');
const config = require('./config');

const path = require('path');

registerCoreListeners();
ensureDefaultSuperAdmin();

const app = express();
// Behind Railway / Nginx the client IP only arrives via X-Forwarded-For.
// Trust the first proxy hop so req.ip (used by the rate limiter) is real.
app.set('trust proxy', 1);
// Security headers. CSP stays off: the vanilla frontend uses inline scripts
// and third-party font CDNs, which a default CSP would break.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Standard, IP-based rate limit applied to every /api request.
const standardLimiter = createRateLimiter({
  name: 'standard',
  windowMs: config.rateLimit.standard.windowMs,
  max: config.rateLimit.standard.max
});
app.use('/api', standardLimiter);

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/users', userRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/superadmin', superadminRoutes);
app.use('/api/stickers', stickerRoutes);

app.use((err, req, res, next) => {
  logger.error('http.error', err.message, { meta: { stack: err.stack } });
  res.status(500).json({ error: 'Internal server error' });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.CORS_ORIGIN || '*' } });
registerSocketHandlers(io);
registerDashboardNamespace(io);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Chat backend running on port ${PORT}`));
