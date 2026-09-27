FROM node:20-slim

# better-sqlite3 needs a compiler only when no prebuilt binary matches;
# keep the toolchain so docker builds never break on a new arch.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Persistent data lives here on the server / Railway volume:
#   DB_PATH=/app/data/chat.db  UPLOAD_DIR=/app/data/uploads  BACKUP_DIR=/app/data/backups
RUN mkdir -p /app/data/uploads /app/data/backups

ENV NODE_ENV=production
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["sh", "-c", "npm run migrate && node server.js"]
