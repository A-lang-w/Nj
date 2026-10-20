import { expect, it } from "vitest";
import type { AndroidAnalysisPort } from "../../src/application/android/AndroidAnalysisPort.js";
import { AndroidBackendRouter } from "../../src/application/android/AndroidBackendRouter.js";
import { androidRequestSchema } from "../../src/domain/android/androidAnalysis.js";
import { AnalysisCapabilityUnavailableError } from "../../src/domain/analysisErrorCore.js";
import { err } from "../../src/domain/result.js";
import type { BinaryTarget } from "../../src/domain/binaryTargetTypes.js";
import { ProviderAdapterError } from "../../src/domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../src/domain/providerCleanupError.js";

const target = {} as BinaryTarget;
const provider = (id: string) => {
  const calls: string[] = [];
  const port: AndroidAnalysisPort = {
    inspectAvailability: async () => {
      calls.push("inspect");
      return { status: "available", code: null, reason: null, diagnostics: {} };
    },
    execute: async (_target, request) => {
      calls.push(request.operation);
      return err(
        new AnalysisCapabilityUnavailableError(
          id,
          request.operation,
          "fixture",
        ),
      );
    },
    close: async () => {
      calls.push("close");
    },
  };
  return { port, calls };
};

it("defaults to JADX and only executes the explicitly selected backend, without fallback", async () => {
  const jadx = provider("jadx");
  const asc = provider("asc");
  const router = new AndroidBackendRouter({ jadx: jadx.port, asc: asc.port });
  const request = androidRequestSchema.parse({
    operation: "search_android_classes",
    input: { path: "/fixture.apk", query: "Target" },
  });
  await router.execute(target, request);
  await router.execute(
    target,
    androidRequestSchema.parse({
      operation: "search_android_classes",
      input: { path: "/fixture.apk", query: "Target", backend: "asc" },
    }),
  );
  expect(jadx.calls).toEqual(["search_android_classes"]);
  expect(asc.calls).toEqual(["search_android_classes"]);
  await router.close();
  expect(jadx.calls.at(-1)).toBe("close");
  expect(asc.calls.at(-1)).toBe("close");
  const closed = await router.execute(target, request);
  expect(closed.ok).toBe(false);
});

it("joins independent cleanup and retries only the backend that failed", async () => {
  const jadx = provider("jadx");
  const asc = provider("asc");
  let attempts = 0;
  asc.port.close = async () => {
    if (++attempts === 1) throw new Error("controlled close denial");
  };
  const router = new AndroidBackendRouter({ jadx: jadx.port, asc: asc.port });
  await expect(router.close()).rejects.toMatchObject({
    cleanupIncomplete: true,
  });
  expect(jadx.calls).toEqual(["close"]);
  await router.close();
  expect(attempts).toBe(2);
  expect(jadx.calls).toEqual(["close"]);
});

it.each(["jadx", "asc"] as const)(
  "preserves the single %s cleanup failure and its exact provider owner",
  async (id) => {
    const jadx = provider("jadx");
    const asc = provider("asc");
    const failed = id === "jadx" ? jadx : asc;
    const peer = id === "jadx" ? asc : jadx;
    const cause = new Error("provider primary failure");
    let resources = [`${id}:process`, `${id}:workspace`];
    const failure = new ProviderAdapterError(id, "inspect_android_package", {
      cause,
      capturedOutput: {
        stdout: "producer reply",
        stderr: "diagnostic",
        truncated: false,
      },
      diagnostics: { source: id },
      cleanup: { resources, reason: "provider-owned close denied" },
    }).bindCleanupResourceOwner({
      get cleanupResources() {
        return resources;
      },
    });
    let denied = true;
    failed.port.close = async () => {
      failed.calls.push("close");
      if (denied) throw failure;
      resources = [];
      failure.resolveCleanup();
    };
    const router = new AndroidBackendRouter({ jadx: jadx.port, asc: asc.port });
    await expect(router.close()).rejects.toBe(failure);
    expect(failure.providerId).toBe(id);
    expect(failure.operation).toBe("inspect_android_package");
    expect(failure.cause).toBe(cause);
    resources = [`${id}:workspace`];
    expect(failure.cleanupResources).toEqual([`${id}:workspace`]);
    await expect(router.close()).rejects.toBe(failure);
    expect(peer.calls).toEqual(["close"]);
    denied = false;
    await router.close();
    expect(failure.cleanupIncomplete).toBe(false);
    expect(peer.calls).toEqual(["close"]);
  },
);

it("keeps a mixed cleanup aggregate live until all original backend owners release", async () => {
  const jadx = provider("jadx");
  const asc = provider("asc");
  let jadxDenied = true;
  let ascDenied = true;
  const jadxFailure = new ProviderCleanupError("jadx", ["jadx:workspace"], {});
  const ascFailure = new ProviderCleanupError("asc", ["asc:descriptor"], {});
  for (const [fixture, failure, denied] of [
    [jadx, jadxFailure, () => jadxDenied],
    [asc, ascFailure, () => ascDenied],
  ] as const) {
    fixture.port.close = async () => {
      fixture.calls.push("close");
      if (denied()) throw failure;
      failure.resolveCleanup();
    };
  }
  const router = new AndroidBackendRouter({ jadx: jadx.port, asc: asc.port });
  const aggregate = await router.close().then(
    () => {
      throw new Error("Expected both backend cleanup failures");
    },
    (cause: unknown) => {
      if (!(cause instanceof ProviderCleanupError)) throw cause;
      return cause;
    },
  );
  expect((aggregate.cause as AggregateError).errors).toEqual([
    jadxFailure,
    ascFailure,
  ]);
  expect(aggregate.cleanupResources).toEqual([
    "jadx:workspace",
    "asc:descriptor",
  ]);
  jadxDenied = false;
  await expect(router.close()).rejects.toBe(ascFailure);
  expect(aggregate.cleanupIncomplete).toBe(true);
  expect(aggregate.cleanupResources).toEqual(["asc:descriptor"]);
  ascDenied = false;
  await router.close();
  expect(aggregate.cleanupIncomplete).toBe(false);
  expect(jadx.calls).toEqual(["close", "close"]);
  expect(asc.calls).toEqual(["close", "close", "close"]);
});

it("rejects an unknown backend instead of treating it as the default", () => {
  expect(
    androidRequestSchema.safeParse({
      operation: "search_android_classes",
      input: { path: "/fixture.apk", query: "", backend: "other" },
    }).success,
  ).toBe(false);
});
