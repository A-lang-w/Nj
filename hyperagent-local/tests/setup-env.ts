// Test environment setup — runs before each test file's module graph loads
// (vitest `isolate` must stay true so this re-runs per file).
//
// Gives every test file its own migrated SQLite database in a temp dir by
// setting DATA_DIR before src/db/connection.ts binds it at import time.
// Services keep their signatures; no mocks, no DI changes.
//
// IMPORTANT: Do not import src/db/connection.ts (or anything that imports
// it) from this file — imports evaluate before the body below runs, which
// would bind the database before DATA_DIR is set.
//
// NOTE: tsconfig includes src only, so tests are NOT typechecked by
// `tsc --noEmit`, and vitest transpiles without typechecking. Verify test
// edits by running them (including a negative control where feasible),
// not by relying on the compiler.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll } from "vitest";

// This prevents src/config.ts from throwing FATAL errors during test collection
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET =
    "test-jwt-secret-that-is-at-least-32-bytes-long-for-vitest";
}
if (!process.env.RESIDENCY_STRICT) {
  process.env.RESIDENCY_STRICT = "false";
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hal-test-"));
process.env.DATA_DIR = tmpDir;

const dbPath = path.join(tmpDir, "hyperagent.db");
const setupDb = new Database(dbPath);
setupDb.pragma("journal_mode = WAL");
setupDb.pragma("foreign_keys = ON");

// Apply the real migrations in order so tests run against the production
// schema, including the FTS5 table/triggers. Split ONLY on the explicit
// breakpoint markers — trigger bodies contain their own semicolons.
const migrationsDir = path.resolve(process.cwd(), "src/db/migrations");
for (const file of fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()) {
  const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) setupDb.exec(trimmed);
  }
}

// Baseline fixtures: tests assume workspace 1 owned by user 1.
// Drizzle `timestamp` mode stores Unix SECONDS (not milliseconds).
const nowSec = Math.floor(Date.now() / 1000);
setupDb.exec(
  `INSERT INTO users (id, email, display_name, created_at, updated_at) ` +
    `VALUES (1, 'test@test.com', 'Test', ${nowSec}, ${nowSec}); ` +
    `INSERT INTO workspaces (id, name, owner_id, created_at, updated_at) ` +
    `VALUES (1, 'Test WS', 1, ${nowSec}, ${nowSec});`,
);
setupDb.close();

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup of the temp dir; the OS reclaims /tmp entries.
  }
});
