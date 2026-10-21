import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATA_DIR
      ? `${process.env.DATA_DIR}/hyperagent.db`
      : "./data/hyperagent.db",
  },
});
