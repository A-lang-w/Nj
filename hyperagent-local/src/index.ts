import "dotenv/config";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { logger } from "./lib/logger.js";
import { sql } from "drizzle-orm";
import {
  createLockFile,
  claimStaleLock,
  releaseLockFile,
} from "./lib/instance-lock.js";

// --- Credential File Warning ---
// When both .env and .env.example exist, the operator has live credentials
// on disk under the template filename. Prefer .env.local for actual secrets
// so .env can serve as documentation without accidental commit risk.
const ENV_FILE = path.resolve(".env");
const ENV_EXAMPLE_FILE = path.resolve(".env.example");
if (fsSync.existsSync(ENV_FILE) && fsSync.existsSync(ENV_EXAMPLE_FILE)) {
  logger.warn(
    ".env exists alongside .env.example. Live credentials may be on disk " +
      "under the template filename. Prefer .env.local for secrets and keep " +
      ".env as a safe, committable template.",
  );
}

// --- Single-Instance Lock (WAL write serialization) ---
// WAL mode does not serialize writes across separate processes; only one
// process may hold the database open for writing at a time. Acquire an
// exclusive lock on a .lock file in DATA_DIR before initializing the DB.
const DATA_DIR_LOCK = process.env.DATA_DIR || "./data";
if (!fsSync.existsSync(DATA_DIR_LOCK)) {
  fsSync.mkdirSync(DATA_DIR_LOCK, { recursive: true });
}
const LOCK_FILE_PATH = path.join(DATA_DIR_LOCK, "hyperagent.lock");

try {
  createLockFile(LOCK_FILE_PATH);
} catch (err) {
  if (
    (err as NodeJS.ErrnoException).code === "EEXIST" &&
    claimStaleLock(LOCK_FILE_PATH)
  ) {
    // Reclaimed a dead holder's lock; this process now owns the path.
  } else if ((err as NodeJS.ErrnoException).code === "EEXIST") {
    logger.error(
      "Another hyperagent-local instance is already running; exiting",
      { lockFile: LOCK_FILE_PATH },
    );
    process.exit(1);
  } else {
    throw err;
  }
}

const releaseLock = () => releaseLockFile(LOCK_FILE_PATH);
process.on("SIGTERM", () => {
  releaseLock();
  process.exit(0);
});
process.on("SIGINT", () => {
  releaseLock();
  process.exit(0);
});
process.on("exit", releaseLock);

import { db } from "./db/connection.js";
import { eventsRouter } from "./routes/events.js";
import { inboxRouter } from "./routes/inbox.js";
import { memoriesRouter } from "./routes/memories.js";
import { skillsRouter } from "./routes/skills.js";
import { filesRouter } from "./routes/files.js";
import { mcpServersRouter } from "./routes/mcp-servers.js";
import { communityRouter } from "./routes/community.js";
import { marketplaceRouter } from "./routes/marketplace.js";
import { integrationsRouter } from "./routes/integrations.js";
import { settingsRouter } from "./routes/settings.js";
import { threadsRouter } from "./routes/threads.js";
import { agentsRouter } from "./routes/agents.js";
import { authRouter } from "./routes/auth.js";
import { workspacesRouter } from "./routes/workspaces.js";
import { authMiddleware } from "./auth/middleware.js";
import { verifyResidency } from "./residency/guard.js";
import { config, verifyDataResidency } from "./config.js";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createRateLimitMiddleware } from "./lib/rate-limit-middleware.js";
import { handleAppError } from "./lib/error-handler.js";
verifyResidency();
verifyDataResidency();
// Apply pending schema migrations at startup so fresh checkouts and
// containers boot against the current schema without a manual step.
// MIGRATIONS_DIR overrides the dev-tree default for packaged layouts.
migrate(db, {
  migrationsFolder: process.env.MIGRATIONS_DIR || "./src/db/migrations",
});
const app = new Hono();

// Malformed request bodies are client errors, not crashes: the shared error
// handler maps JSON parse failures (direct and validator-raised) to the
// documented 400 envelope while preserving Hono's other semantics.
app.onError(handleAppError);

// --- Rate Limiter Middleware (SEC-006) ---
app.use("*", createRateLimitMiddleware());

// --- CORS Middleware (SEC-012) ---
const ALLOWED_ORIGINS = ["http://localhost:5173", "http://localhost:3000"];

app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
    c.header(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    );
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    c.header("Access-Control-Allow-Credentials", "true");
  }

  if (c.req.method === "OPTIONS") {
    return c.body(null, 204);
  }

  await next();
});

// Public routes (exempt from global auth)
app.get("/api/health", async (c) => {
  const checks: Record<string, { status: string; error?: string }> = {};
  let overallStatus = "ok";

  // OPS-009: Check database connectivity
  try {
    db.run(sql`SELECT 1`);
    checks.database = { status: "ok" };
  } catch (err) {
    checks.database = {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
    overallStatus = "degraded";
  }

  // OPS-009: Check DATA_DIR writability
  const dataDir = process.env.DATA_DIR || "./data";
  try {
    await fs.access(dataDir, fs.constants.W_OK);
    checks.dataDir = { status: "ok" };
  } catch (err) {
    checks.dataDir = {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
    overallStatus = "degraded";
  }

  return c.json(
    {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      checks,
    },
    overallStatus === "ok" ? 200 : 503,
  );
});
app.route("/api/auth", authRouter);
// Global auth enforcement for all other /api/* routes
app.use("/api/*", authMiddleware);
// Core API routes (protected globally; per-route middleware is redundant but harmless)
app.route("/api/threads", threadsRouter);
app.route("/api/agents", agentsRouter);
app.route("/api/events", eventsRouter);
app.route("/api/inbox", inboxRouter);
app.route("/api/memories", memoriesRouter);
app.route("/api/skills", skillsRouter);
app.route("/api/files", filesRouter);
app.route("/api/mcp-servers", mcpServersRouter);
app.route("/api/community", communityRouter);
app.route("/api/marketplace", marketplaceRouter);
app.route("/api/integrations", integrationsRouter);
app.route("/api/settings", settingsRouter);
app.route("/api/workspaces", workspacesRouter);
const { port, host, dataDir } = config;
// SEC-004: Passwordless email login is only safe on loopback. Binding to a
// non-loopback address without an explicit override would expose account
// takeover to anyone who can reach the port.
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
const allowInsecureBind = process.env.ALLOW_INSECURE_BIND === "true";
if (!loopbackHosts.has(host) && !allowInsecureBind) {
  throw new Error(
    `Refusing to bind HOST="${host}": passwordless auth is loopback-only. ` +
      `Use 127.0.0.1 / ::1 / localhost, or set ALLOW_INSECURE_BIND=true to acknowledge the risk.`,
  );
}
if (!loopbackHosts.has(host) && allowInsecureBind) {
  logger.warn(
    "ALLOW_INSECURE_BIND=true: passwordless auth is reachable off-loopback",
    { host, port },
  );
}
logger.info("Starting hyperagent-local", { host, port });
logger.info("Configuration loaded", {
  dataDir,
  // SEC-010: LLM_BASE_URL omitted from startup logs to prevent credential leakage
});
serve({ fetch: app.fetch, port, hostname: host }, () => {
  logger.info("Server running", { url: `http://${host}:${port}` });
});
export { app };
