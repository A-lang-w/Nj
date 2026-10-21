# Stage 1: Build
# Node 22: better-sqlite3 declares engines.node >= 22.
FROM node:22-alpine AS builder
WORKDIR /app
# better-sqlite3 ships no musl prebuild for every arch (notably linux/arm64),
# so npm falls back to node-gyp: the builder needs the compile toolchain.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json drizzle.config.ts ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Production
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
# Same compile fallback as the builder; the toolchain is removed afterwards
# while libstdc++ stays for the native module at runtime.
RUN apk add --no-cache libstdc++ \
  && apk add --no-cache --virtual .build-deps python3 make g++ \
  && npm ci --omit=dev \
  && npm cache clean --force \
  && apk del .build-deps
COPY --from=builder /app/dist/ ./dist/
# Schema migrations are applied at startup (see index.ts); they must ship
# with the image since devDependencies (drizzle-kit) are not installed here.
COPY --from=builder /app/src/db/migrations/ ./migrations/
# DATA_DIR holds the SQLite database, uploads, and the instance lock.
# Mount a volume here or container restarts lose data (and a SIGKILLed
# container without a volume still cannot reboot; see instance-lock.ts).
ENV DATA_DIR=/app/data
ENV MIGRATIONS_DIR=/app/migrations
ENV HOST=0.0.0.0
VOLUME /app/data
EXPOSE 3000
# Port 3000 is baked in: operators overriding PORT must override this too.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/health > /dev/null || exit 1
# JWT_SECRET is required at startup (see config.ts) and must be supplied at
# run time — it is deliberately not baked into the image:
#   docker run -e JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
#     -v hyperagent-data:/app/data -p 3000:3000 hyperagent-local
CMD ["node", "dist/index.js"]
