import { readdir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../../../../src/domain/providerCleanupError.js";
import { run, session } from "./kunaSessionFixture.js";

const fault = vi.hoisted(() => ({
  fail: false,
  span: "",
  short: false,
  reads: 0,
  closes: 0,
  opens: 0,
  handles: [] as FileHandle[],
  cause: Object.assign(new Error("controlled close refusal"), { code: "EIO" }),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (String(args[0]) !== fault.span) return handle;
      fault.opens += 1;
      fault.handles.push(handle);
      return new Proxy(handle, {
        get(target, key) {
          if (key === "read")
            return async (...readArgs: unknown[]) => {
              const read = await Reflect.apply(target.read, target, readArgs);
              fault.reads += 1;
              return fault.short ? { ...read, bytesRead: 0 } : read;
            };
          if (key === "close")
            return async () => {
              fault.closes += 1;
              if (fault.fail) throw fault.cause;
              return target.close();
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

afterEach(() => {
  fault.fail = false;
  fault.span = "";
  fault.short = false;
  fault.reads = 0;
  fault.closes = 0;
  fault.opens = 0;
  fault.handles = [];
});

it.each([false, true])(
  "preserves the span outcome and retries the exact handle when close fails (short=%s)",
  async (short) => {
    const { cacheRoot, open: createClient } = await session(
      "rea-kuna-span-close-",
    );
    const client = createClient();
    try {
      const warm = await run(client, "procedure_assembly", {
        procedure: "main",
      });
      const text = String(warm.result);
      const [key] = await readdir(join(cacheRoot, "projects"));
      fault.span = join(cacheRoot, "projects", key ?? "", "project", "program.asm");
      fault.short = short;
      fault.fail = true;
      const result = await client.execute(
        "procedure_assembly",
        { procedure: "main" },
        {},
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(projectAnalysisError(result.error).code).toBe(
        "cleanup_incomplete",
      );
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(result.error.cleanupResources).toContain(fault.span);
      expect(fault.reads).toBe(1);
      expect(fault.closes).toBe(1);
      expect(fault.opens).toBe(1);
      const handle = fault.handles[0];
      if (handle === undefined) throw new Error("missing span descriptor");
      if (short) {
        expect(result.error.cleanupPrimary?.userMessage).toContain(
          "shorter than its recorded span",
        );
        expect(result.error.diagnostics?.span_read).toBeUndefined();
      } else {
        expect(result.error).toBeInstanceOf(ProviderCleanupError);
        expect(result.error.diagnostics).toMatchObject({
          span_read: "completed",
          span_text: expect.stringContaining(text),
          path: fault.span,
        });
      }
      const live = await handle.read(Buffer.alloc(4), 0, 4, 0);
      expect(live.bytesRead).toBe(4);

      const blocked = await client.execute(
        "procedure_assembly",
        { procedure: "main" },
        {},
      );
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.error.cleanupIncomplete).toBe(true);
      expect(fault.reads).toBe(1);
      expect(fault.opens).toBe(1);
      expect(fault.closes).toBeGreaterThan(1);
      expect(handle.fd).toBeGreaterThanOrEqual(0);

      const closesBeforeShutdown = fault.closes;
      const closed = await client.close();
      expect(closed.ok).toBe(false);
      if (closed.ok) return;
      expect(closed.error.cleanupIncomplete).toBe(true);
      expect(fault.closes).toBeGreaterThan(closesBeforeShutdown);
      expect(handle.fd).toBeGreaterThanOrEqual(0);
      expect(result.error.cleanupIncomplete).toBe(true);
      const stillLive = await handle.read(Buffer.alloc(4), 0, 4, 0);
      expect(stillLive.bytesRead).toBe(4);

      fault.fail = false;
      const released = await client.close();
      expect(released).toEqual({ ok: true, value: null });
      expect(handle.fd).toBe(-1);
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(blocked.error.cleanupIncomplete).toBe(false);
      expect(closed.error.cleanupIncomplete).toBe(false);
    } finally {
      fault.fail = false;
      fault.span = "";
      await client.close();
      for (const handle of fault.handles)
        if (handle.fd >= 0) await handle.close().catch(() => undefined);
    }
  },
);
