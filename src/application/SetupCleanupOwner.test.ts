import { expect, it } from "vitest";

import { SetupCleanupOwner } from "./SetupCleanupOwner.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../artifacts/AnalysisCleanupLease.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";

it("updates every report through mixed cleanup outcomes and exact retries", async () => {
  let firstHeld = true;
  let secondHeld = true;
  let firstCalls = 0;
  const owner = new SetupCleanupOwner([
    {
      close: async () => {
        if (++firstCalls > 2)
          throw new Error("Completed child must not close again");
        return firstHeld
          ? { reason: "first held", resources: ["/first"] }
          : undefined;
      },
    },
    {
      close: async () =>
        secondHeld
          ? { reason: "second held", resources: ["/second"] }
          : undefined,
    },
  ]);
  const first = await owner.close();
  expect(first?.cleanupResources).toEqual(["/first", "/second"]);
  firstHeld = false;
  const second = await owner.close();
  expect(first?.cleanupIncomplete).toBe(true);
  expect(first?.cleanupResources).toEqual(["/second"]);
  expect(second?.cleanupResources).toEqual(["/second"]);
  secondHeld = false;
  expect(await owner.close()).toBeUndefined();
  expect(first?.cleanupIncomplete).toBe(false);
  expect(first?.cleanupResources).toEqual([]);
  expect(second?.cleanupIncomplete).toBe(false);
  expect(firstCalls).toBe(2);
});

it("keeps opaque cleanup unresolved without inventing paths or retaining released labels", async () => {
  let fileHeld = true;
  let opaqueHeld = true;
  const owner = new SetupCleanupOwner([
    {
      close: async () =>
        fileHeld ? { reason: "held file", resources: ["/owned"] } : undefined,
    },
    {
      close: async () => {
        if (opaqueHeld) throw new Error("opaque /not-an-owned-path");
      },
    },
  ]);
  const report = await owner.close();
  expect(report?.cleanupResources).toEqual(["/owned"]);
  fileHeld = false;
  await owner.close();
  expect(report?.cleanupIncomplete).toBe(true);
  expect(report?.cleanupResources).toEqual([]);
  opaqueHeld = false;
  expect(await owner.close()).toBeUndefined();
  expect(report?.cleanupIncomplete).toBe(false);
});

it("starts child finalization synchronously and shares concurrent closes", async () => {
  let calls = 0;
  let complete: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const owner = new SetupCleanupOwner([
    {
      close: () => {
        calls++;
        return gate;
      },
    },
  ]);
  const first = owner.close();
  expect(calls).toBe(1);
  expect(owner.close()).toBe(first);
  complete?.();
  expect(await first).toBeUndefined();
  expect(await owner.close()).toBeUndefined();
  expect(calls).toBe(1);
});

it("adopts later cleanup without reopening a completed generation", async () => {
  let held = true;
  const task = {
    close: async () =>
      held ? { reason: "held", resources: ["/same-label"] } : undefined,
  };
  const owner = new SetupCleanupOwner([task]);
  const previous = await owner.close();
  held = false;
  expect(await owner.close()).toBeUndefined();
  held = true;
  owner.admit(task);
  const current = await owner.close();
  expect(previous?.cleanupIncomplete).toBe(false);
  expect(previous?.cleanupResources).toEqual([]);
  expect(current?.cleanupIncomplete).toBe(true);
  expect(current?.cleanupResources).toEqual(["/same-label"]);
  held = false;
  expect(await owner.close()).toBeUndefined();
});

it("keeps finalization cancellation unresolved and still attempts the other child", async () => {
  let interrupted = true;
  let otherAttempts = 0;
  const owner = new SetupCleanupOwner([
    {
      close: async () => {
        if (interrupted)
          throw new DOMException("close interrupted", "AbortError");
      },
    },
    {
      close: async () => {
        otherAttempts++;
      },
    },
  ]);
  const report = await owner.close();
  expect(report?.cleanupIncomplete).toBe(true);
  expect(otherAttempts).toBe(1);
  interrupted = false;
  expect(await owner.close()).toBeUndefined();
  expect(report?.cleanupIncomplete).toBe(false);
});

it("observes exact concurrent recovery before aggregate binding", async () => {
  const source = new ProviderCleanupError("fixture", ["/shared"], {});
  const lease = new AnalysisCleanupLease(async () => {}, ["/shared"]);
  new AnalysisCleanupLeaseGroup(source, [lease]);
  let finish: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let sourceCalls = 0;
  const owner = new SetupCleanupOwner([
    {
      close: async () => {
        sourceCalls++;
        throw source;
      },
    },
    { close: () => gate },
  ]);
  const closing = owner.close();
  await lease.release();
  finish?.();
  expect(await closing).toBeUndefined();
  expect(await owner.close()).toBeUndefined();
  expect(sourceCalls).toBe(1);
});

it.each(["pending", "already recovered"] as const)(
  "keeps delegated cleanup pending when the next report has an independent owner: %s",
  async (timing) => {
    const source = new ProviderCleanupError("fixture", ["/independent"], {});
    const sourceLease = new AnalysisCleanupLease(async () => {}, [
      "/independent",
    ]);
    new AnalysisCleanupLeaseGroup(source, [sourceLease]);
    let calls = 0;
    const owner = new SetupCleanupOwner([
      {
        close: async () => {
          calls++;
          if (calls === 1)
            return {
              reason: "delegated work pending",
              resources: ["/delegated"],
            };
          if (calls === 2) return source;
          return undefined;
        },
      },
    ]);
    const first = await owner.close();
    if (timing === "already recovered") await sourceLease.release();
    const second = await owner.close();
    await sourceLease.release();
    expect(source.cleanupIncomplete).toBe(false);
    expect(first?.cleanupIncomplete).toBe(true);
    expect(second?.cleanupIncomplete).toBe(true);
    expect(first?.cleanupResources).toContain("/delegated");
    expect(second?.cleanupResources).toContain("/delegated");
    expect(first?.cleanupResources).toEqual(["/delegated"]);
    expect(second?.cleanupResources).toEqual(["/delegated"]);
    expect(await owner.close()).toBeUndefined();
    expect(calls).toBe(3);
    expect(first?.cleanupIncomplete).toBe(false);
    expect(second?.cleanupIncomplete).toBe(false);
  },
);

it("recognizes its own delegated typed error when the same producer returns it again", async () => {
  const source = new ProviderCleanupError("fixture", ["/delegated"], {});
  let held = true;
  const owner = new SetupCleanupOwner([
    {
      close: async () => (held ? source : undefined),
    },
  ]);
  const first = await owner.close();
  expect(first?.cleanupResources).toEqual(["/delegated"]);
  const second = await owner.close();
  expect(second?.cleanupResources).toEqual(["/delegated"]);
  held = false;
  expect(await owner.close()).toBeUndefined();
  expect(source.cleanupIncomplete).toBe(false);
  expect(first?.cleanupIncomplete).toBe(false);
  expect(second?.cleanupIncomplete).toBe(false);
});
