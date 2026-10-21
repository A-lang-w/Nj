import { describe, it, expect } from "vitest";
import {
  emitEvent,
  subscribe,
  getEventBuffer,
  getOldestBufferedId,
} from "../../src/domain/events.js";

describe("event buffer bounds", () => {
  it("exposes the oldest retained id for gap detection", () => {
    const before = getEventBuffer().length;
    emitEvent("test.probe", { n: 1 });
    const oldest = getOldestBufferedId();
    expect(oldest).not.toBeNull();
    expect(Number(oldest)).toBeGreaterThan(0);
    expect(getEventBuffer().length).toBe(before + 1);
  });

  it("evicts oldest entries past capacity, advancing the oldest id", () => {
    const firstOldest = getOldestBufferedId();
    for (let i = 0; i < 150; i++) {
      emitEvent("test.flood", { i });
    }
    expect(getEventBuffer().length).toBeLessThanOrEqual(100);
    const oldest = getOldestBufferedId();
    expect(oldest).not.toBeNull();
    if (firstOldest !== null) {
      expect(Number(oldest)).toBeGreaterThan(Number(firstOldest));
    }
  });

  it("delivers emitted events to subscribers with ids", () => {
    const seen: Array<{ event: string; id: string }> = [];
    const unsubscribe = subscribe((event, _data, id) => {
      seen.push({ event, id });
    });
    try {
      emitEvent("test.sub", { ok: true });
    } finally {
      unsubscribe();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].event).toBe("test.sub");
    expect(Number(seen[0].id)).toBeGreaterThan(0);
  });
});
