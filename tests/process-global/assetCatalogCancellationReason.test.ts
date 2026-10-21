import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  controller: undefined as AbortController | undefined,
  reason: undefined as unknown,
}));

vi.mock("../../src/process/ExecFileOutput.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/process/ExecFileOutput.js")
    >();
  return {
    ...actual,
    execFileOutput: vi.fn(async () => {
      state.controller?.abort(state.reason);
      throw new actual.ExecFileOutputCancelledError(state.reason);
    }),
  };
});

import { ArtifactReaderFailure } from "../../src/artifacts/ArtifactReader.js";
import { analyzeAppleAssetCatalogs } from "../../src/artifacts/apple/AppleAssetCatalogAnalysis.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

it("retains the caller reason when assetutil observes cancellation", async () => {
  const bundle = await createTestTempDirectory(
    "rea-asset-catalog-cancellation-",
  );
  await mkdir(join(bundle, "Contents", "Resources"), { recursive: true });
  await writeFile(
    join(bundle, "Contents", "Resources", "Assets.car"),
    "inert catalog fixture",
  );
  const reason = { requested: "stop asset catalog" };
  const controller = new AbortController();
  state.controller = controller;
  state.reason = reason;
  try {
    const failure: unknown = await analyzeAppleAssetCatalogs({
      bundlePath: bundle,
      targetSha256: null,
      environment: {},
      signal: controller.signal,
      analyzeInterfaceBuilder: (async () => ({
        graph: { nodes: [], truncated: false },
      })) as never,
    }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactReaderFailure);
    if (!(failure instanceof ArtifactReaderFailure))
      throw new Error("Expected asset catalog cancellation");
    expect(failure.reason).toBe("cancelled");
    expect(failure.cancellation?.reason).toBe(reason);
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});
