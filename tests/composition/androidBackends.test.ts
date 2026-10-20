import { expect, it } from "vitest";
import type { AndroidAnalysisPort } from "../../src/application/android/AndroidAnalysisPort.js";
import { AndroidBackendRouter } from "../../src/application/android/AndroidBackendRouter.js";
import { androidRequestSchema } from "../../src/domain/android/androidAnalysis.js";
import { AnalysisCapabilityUnavailableError } from "../../src/domain/analysisErrorCore.js";
import { err } from "../../src/domain/result.js";
import type { BinaryTarget } from "../../src/domain/binaryTargetTypes.js";

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

it("rejects an unknown backend instead of treating it as the default", () => {
  expect(
    androidRequestSchema.safeParse({
      operation: "search_android_classes",
      input: { path: "/fixture.apk", query: "", backend: "other" },
    }).success,
  ).toBe(false);
});
