import { describe, expect, it } from "vitest";

import { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import { inspectWebPageInputSchema } from "../domain/browserObservation.js";
import { webPageInspectionSchema } from "../domain/browserObservationSchemas.js";

const createCapture = (origin = "http://127.0.0.1:43127"): CdpCaptureEvents =>
  new CdpCaptureEvents(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: origin,
      allowed_origins: [origin],
      target_id: "page",
    }),
    new Set([origin]),
  );

describe("CdpCaptureEvents: console API timestamps", () => {
  it("preserves finite producer timestamps exactly, including zero and negative values", () => {
    const origin = "http://127.0.0.1:43127";
    const events = createCapture(origin);

    const callFrames = [
      { url: `${origin}/app.js`, lineNumber: 10, columnNumber: 5 },
    ];

    events.ingest({
      method: "Runtime.consoleAPICalled",
      params: {
        type: "log",
        timestamp: 1710000000123,
        args: [{ type: "string", value: "hello" }],
        stackTrace: { callFrames },
      },
    });

    events.ingest({
      method: "Runtime.consoleAPICalled",
      params: {
        type: "info",
        timestamp: 0,
        args: [],
        stackTrace: { callFrames },
      },
    });

    events.ingest({
      method: "Runtime.consoleAPICalled",
      params: {
        type: "warn",
        timestamp: -1000,
        args: [],
        stackTrace: { callFrames },
      },
    });

    expect(events.console).toHaveLength(3);
    expect(events.console[0]?.timestamp).toBe(1710000000123);
    expect(events.console[1]?.timestamp).toBe(0);
    expect(events.console[2]?.timestamp).toBe(-1000);

    const completeness = events.completeness.snapshot();
    expect(completeness.excluded).toEqual([]);
    expect(completeness.unavailable_sections).toEqual([]);
  });

  it("retains console events with null timestamp and invalid_protocol_value when timestamp is missing or non-finite", () => {
    const origin = "http://127.0.0.1:43127";
    const events = createCapture(origin);

    const callFrames = [
      { url: `${origin}/app.js`, lineNumber: 1, columnNumber: 2 },
    ];

    // Missing timestamp property
    events.ingest({
      method: "Runtime.consoleAPICalled",
      params: {
        type: "log",
        args: [],
        stackTrace: { callFrames },
      },
    });

    expect(events.console).toHaveLength(1);
    expect(events.console[0]?.timestamp).toBeNull();

    let snapshot = events.completeness.snapshot();
    expect(snapshot.unavailable_sections).toContain("console_events");
    expect(snapshot.excluded).toContainEqual({
      section: "console_events",
      reason: "invalid_protocol_value",
      count: 1,
    });

    // NaN timestamp
    events.ingest({
      method: "Runtime.consoleAPICalled",
      params: {
        type: "log",
        timestamp: Number.NaN,
        args: [],
        stackTrace: { callFrames },
      },
    });

    expect(events.console).toHaveLength(2);
    expect(events.console[1]?.timestamp).toBeNull();

    // Infinity timestamp
    events.ingest({
      method: "Runtime.consoleAPICalled",
      params: {
        type: "log",
        timestamp: Number.POSITIVE_INFINITY,
        args: [],
        stackTrace: { callFrames },
      },
    });

    expect(events.console).toHaveLength(3);
    expect(events.console[2]?.timestamp).toBeNull();

    // String timestamp
    events.ingest({
      method: "Runtime.consoleAPICalled",
      params: {
        type: "log",
        timestamp: "not-a-number",
        args: [],
        stackTrace: { callFrames },
      },
    });

    expect(events.console).toHaveLength(4);
    expect(events.console[3]?.timestamp).toBeNull();

    snapshot = events.completeness.snapshot();
    expect(snapshot.excluded).toContainEqual({
      section: "console_events",
      reason: "invalid_protocol_value",
      count: 4,
    });
  });

  it("validates against webPageInspectionSchema with nullable timestamps", () => {
    const origin = "http://127.0.0.1:43127";
    const events = createCapture(origin);

    events.ingest({
      method: "Runtime.consoleAPICalled",
      params: {
        type: "log",
        args: [],
        stackTrace: {
          callFrames: [
            { url: `${origin}/app.js`, lineNumber: 1, columnNumber: 1 },
          ],
        },
      },
    });

    const consoleSection = {
      events: events.console,
      coverage_started_at: "2026-10-21T00:00:00.000Z",
      prior_activity_available: false as const,
    };

    expect(() =>
      webPageInspectionSchema.shape.console.parse(consoleSection),
    ).not.toThrow();
  });
});
