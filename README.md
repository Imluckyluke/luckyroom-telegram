# Luckyroom — Telegram UI (full-stack)

Luckyroom chat backend (groups + DMs, realtime Socket.io, uploads, stickers, roles)
with a **Telegram Web-style frontend** in `public/`.

## Features (all functional, wired to the real backend)

- Auth: sign up / log in (name + phone + password), sessions, logout everywhere,
  phone OTP verify, password reset via OTP or security questions, account lockout
- Chats: DMs (start by phone or @username), public/private groups, public
  discovery, invite links, direct invites (accept/reject), join, leave
- Messaging: text, photo/video/file/voice (encrypted at rest), stickers
  (incl. Telegram pack import), reply, forward, edit, delete, pin, reactions,
  read ticks, typing indicator, online presence, in-chat search, pinned list
- Profile: name/bio/username/avatar, block & mute users
- Groups: members list, make admin / remove, invite member, locks, group avatar
- Notifications center + broadcast toasts, unread badge
- Admin (role-gated): user lookup, ban/unban, mute, broadcast

## Run locally

```bash
cp .env.example .env   # set JWT_SECRET + SUPER_ADMIN_PHONE
npm install
npm run migrate
npm start              # http://localhost:4000
```

## Docker (any server)

```bash
cp .env.example .env   # set JWT_SECRET + SUPER_ADMIN_PHONE
docker build -t luckyroom .
docker run -d --name luckyroom -p 4000:4000 \
  --env-file .env \
  -e DB_PATH=/app/data/chat.db -e UPLOAD_DIR=/app/data/uploads -e BACKUP_DIR=/app/data/backups \
  -v luckyroom-data:/app/data \
  luckyroom
```

## Railway

1. New Project → Deploy from GitHub (`luckyroom-telegram`), builder = Dockerfile
   (`railway.toml` already sets this + `/api/health` healthcheck).
2. Add a **Volume** mounted at `/app/data`.
3. Variables:
   - `JWT_SECRET` = long random string (required)
   - `SUPER_ADMIN_PHONE` = owner phone number (required)
   - `DB_PATH` = `/app/data/chat.db`
   - `UPLOAD_DIR` = `/app/data/uploads`
   - `BACKUP_DIR` = `/app/data/backups`
   - `CORS_ORIGIN` = `*` (or your domain)
   - `TELEGRAM_BOT_TOKEN` = optional (sticker import)
   - `UPLOAD_ENCRYPTION_KEY`, `UPLOAD_LINK_SECRET` = random strings (production)
4. Deploy — migrations run automatically on boot.

## Env reference

See `.env.example` for the full list (upload limits, OTP, pagination, logging).
