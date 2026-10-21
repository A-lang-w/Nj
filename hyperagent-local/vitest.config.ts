import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Web store tests (tests/web/) import modules that use the web `@/`
  // alias. Backend code uses no `@/` imports, so this is collision-free.
  resolve: {
    alias: { "@": fileURLToPath(new URL("./web/src", import.meta.url)) },
  },
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 15000,
    setupFiles: ["./tests/setup-env.ts"],
    // Pinned, not defaulted: setup-env provisions one temp database per
    // file by setting DATA_DIR at module load. Without isolation every
    // file would share a single database and pollute each other's rows.
    isolate: true,
  },
});
