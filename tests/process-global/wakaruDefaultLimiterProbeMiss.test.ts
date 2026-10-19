import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { resolveWakaruLimiter } from "../../src/javascript/recovery/WakaruCommand.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

/**
 * The Linux default limiter is a probe, so a limiter that disappears between
 * `access()` and `stat()` — a package replacement racing the probe — must
 * degrade to "unenforced" instead of failing the whole resolution: the caller
 * maps any throw to `capability_unavailable`, which removes recovery on a host
 * that still has Wakaru.
 *
 * Module replacement needs a per-file graph, so this case lives in the
 * isolated-fork project that owns module mocks.
 */
const vanished = vi.hoisted(() => ({ path: "" }));

vi.mock("node:fs/promises", async () => {
  const real =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  return {
    ...real,
    stat: async (path: string) => {
      if (path === vanished.path)
        throw Object.assign(new Error("ENOENT: no such file or directory"), {
          code: "ENOENT",
        });
      return await real.stat(path);
    },
  };
});

it("treats a default limiter that vanishes after the probe as absent", async () => {
  const root = await createTestTempDirectory("rea-wakaru-limiter-vanished-");
  const limiter = join(root, "prlimit");
  await writeFile(limiter, "#!/bin/sh\n", { mode: 0o700 });
  vanished.path = limiter;

  try {
    await expect(
      resolveWakaruLimiter(undefined, {
        platform: "linux",
        defaultLimiter: limiter,
      }),
    ).resolves.toBeUndefined();
  } finally {
    vanished.path = "";
  }
});
