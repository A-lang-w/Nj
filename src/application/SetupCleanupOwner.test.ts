import { expect, it } from "vitest";

import { SetupCleanupOwner } from "./SetupCleanupOwner.js";

it("updates every report through mixed cleanup outcomes and exact retries", async () => {
  let firstHeld = true;
  let secondHeld = true;
  const owner = new SetupCleanupOwner([
    {
      close: async () =>
        firstHeld ? { reason: "first held", resources: ["/first"] } : undefined,
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
  expect(calls).toBe(2);
});

it("adopts later cleanup without reopening a completed generation", async () => {
  let held = true;
  const owner = new SetupCleanupOwner([
    {
      close: async () =>
        held ? { reason: "held", resources: ["/same-label"] } : undefined,
    },
  ]);
  const previous = await owner.close();
  held = false;
  expect(await owner.close()).toBeUndefined();
  held = true;
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
