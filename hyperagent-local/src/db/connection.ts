import Database, { type Database as DatabaseType } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import * as schema from "./schema.js";
import { logger } from "../lib/logger.js";

const DATA_DIR = process.env.DATA_DIR || "./data";
const DB_PATH = path.join(DATA_DIR, "hyperagent.db");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const sqlite: DatabaseType = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");

export const db = drizzle(sqlite, { schema });

// Defer integrity_check to avoid blocking server startup.
// Runs asynchronously after the module is imported and the server can accept requests.
setImmediate(() => {
  try {
    const result = sqlite.pragma("integrity_check", { simple: true });
    if (result !== "ok") {
      logger.error(
        "[db] Database corruption detected during background integrity check",
        { result },
      );
      logger.error(
        "[db] The database may be corrupt. Restore from backup or run db:seed.",
      );
    }
  } catch (err) {
    logger.error("[db] Background integrity check failed", { error: err });
  }
});
