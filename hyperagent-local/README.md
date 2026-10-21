# hyperagent-local

Local-first agent runtime with SQLite persistence, LLM integration, and REST API.

## Prerequisites

- Node.js 22+ (see `.nvmrc`; better-sqlite3 requires Node 22)
- npm 10+
- SQLite (bundled via better-sqlite3)
- `sqlite3` CLI (for `db:backup` and `db:migrate:safe`)

## Setup

```bash
npm ci
cp .env.example .env
# Edit .env: set JWT_SECRET (required) and point LLM_* at your provider
npm run db:generate
npm run db:migrate
npm run db:seed
```

Frontend (Vite dev server on :5173, proxying `/api` to the backend on :3000):

```bash
cd web
npm ci
npm run dev
```

## Environment Variables

| Variable               | Required | Default                     | Description                                               |
| ---------------------- | -------- | --------------------------- | --------------------------------------------------------- |
| `LLM_BASE_URL`         | No       | `http://localhost:11434/v1` | LLM provider base URL (Ollama-compatible default)         |
| `LLM_API_KEY`          | No       | `ollama`                    | API key for the LLM provider                              |
| `LLM_MODEL`            | No       | `claude-opus-5-5`           | Model identifier (ghostcli.cloud default)                 |
| `JWT_SECRET`           | Yes      | —                           | Cryptographically secure random secret for signing tokens |
| `SESSION_MAX_AGE_DAYS` | No       | `30`                        | Session token lifetime in days                            |
| `DATA_DIR`             | No       | `./data`                    | Directory for SQLite database and file storage            |
| `RESIDENCY_STRICT`     | No       | `true`                      | Enforce data residency constraints (set `false` to relax) |
| `PORT`                 | No       | `3000`                      | HTTP listen port                                          |
| `HOST`                 | No       | `127.0.0.1`                 | HTTP listen hostname                                      |

Generate a JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Development

```bash
npm run dev          # Start with tsx watch (auto-reload)
npm run build        # Type-check and bundle to dist/
npm start            # Run production build
npm test             # Run vitest suite
npm run lint         # Lint with oxlint
npm run format       # Format with oxfmt
```

## Database

The application uses SQLite via Drizzle ORM. The database file lives in `$DATA_DIR` (default `./data`).

```bash
npm run db:generate  # Generate migration files from schema changes
npm run db:migrate   # Apply pending migrations (no backup)
npm run db:migrate:safe  # Apply migrations with automatic backup and integrity verification
npm run db:backup    # Create a timestamped backup of the database
npm run db:seed      # Seed initial data
```

Migration snapshots are stored in `src/db/migrations/`. Never edit generated SQL files directly; modify `src/db/schema.ts` and regenerate.

### Safe Migration Procedure

For production or any environment where data loss is unacceptable, always use `db:migrate:safe`:

```bash
npm run db:migrate:safe
```

This command runs `scripts/migrate-with-backup.sh`, which:

1. Creates a timestamped backup of the database before migration
2. Runs `drizzle-kit migrate`
3. Verifies database integrity with `PRAGMA integrity_check` after migration
4. Prints restore instructions if migration or the integrity check fails
5. Retains the backup permanently for rollback (backups are never auto-deleted)

If migration fails, restore from the retained backup:

```bash
./scripts/restore-db.sh "$DATA_DIR/hyperagent.db.backup.TIMESTAMP"
```

### Manual Rollback

If you need to roll back after a successful migration:

1. Stop the application server
2. Restore from the most recent backup: `./scripts/restore-db.sh "$DATA_DIR/hyperagent.db.backup.TIMESTAMP"`
3. Restart the server

Drizzle does not support automatic down-migrations for SQLite. Schema changes that remove columns or tables are irreversible without a backup.

## Backup

For a consistent snapshot while the server is running (WAL mode), use the
online backup API via the bundled script (keeps the 7 most recent backups in
`$DATA_DIR/backups/`):

```bash
npm run db:backup
```

A plain `cp` of `hyperagent.db` is only consistent with the server stopped:

```bash
# Stop the server first to ensure a consistent snapshot
cp "$DATA_DIR"/hyperagent.db "$DATA_DIR"/hyperagent.db.bak.$(date +%Y%m%d%H%M%S)
tar czf hyperagent-backup-$(date +%Y%m%d%H%M%S).tar.gz "$DATA_DIR"
```

## Docker

The image runs the API server only (run the Vite frontend separately against
it). `JWT_SECRET` is required at startup and must be passed at run time; mount
a volume at `/app/data` or container restarts lose the database:

```bash
docker build -t hyperagent-local .
docker run --rm \
  -e JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
  -v hyperagent-data:/app/data \
  -p 3000:3000 \
  hyperagent-local
```

Health check: `curl http://localhost:3000/api/health` should return 200.

## Architecture Overview

```
src/
  index.ts           # Application entry point, Hono server setup
  config.ts          # Configuration loading and validation
  lib/logger.ts      # Structured JSON logger
  auth/              # JWT authentication middleware and token management
  db/                # Drizzle schema, connection, migrations, seed
  llm/               # LLM client adapter
  residency/         # Data residency guard
  routes/            # REST route handlers (agents, threads, memories, etc.)
  services/          # Business logic layer (thread, memory, skill, file)
```

Dependencies flow inward: domain semantics and contracts, provider adapters, shared application workflows, then CLI/MCP adapters. Route handlers delegate to services; services own database access through Drizzle. Authentication middleware protects routes that require it.
