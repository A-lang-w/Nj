import { expect, it } from "vitest";

import { timedCaptureEvidence } from "../../../tests/fixtures/analysisView.js";
import {
  scenarioCaptureEvidence,
  scenarioCaptureFixture,
  type ScenarioExchange,
} from "../../../tests/fixtures/browserScenarioCapture.js";
import {
  BOOK_ROWS,
  BOOK_WRITE_CLOCK,
  environmentStateViewOf,
} from "../../../tests/fixtures/environmentStateWrites.js";
import type { BrowserScenarioCapture } from "../browserScenarioCapture.js";
import { scenarioCaptureRecords } from "./scenarioCaptureRecords.js";

const START = Date.parse("2026-10-17T18:00:00.000Z");

/** The book session the HAR fixture times one second apart, as browser scenario exchanges. */
const EXCHANGES: readonly ScenarioExchange[] = BOOK_ROWS.map(
  ([method, path, body = null, status = 200, sent]) => ({
    method,
    url: path,
    status,
    mediaType: "application/json",
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...(sent === undefined
      ? {}
      : {
          requestMediaType: "application/json",
          requestBody: JSON.stringify(sent),
        }),
  }),
);

/** The same capture with each request observed when the HAR fixture starts it, finishing 5 ms later. */
const timed = (capture: BrowserScenarioCapture): BrowserScenarioCapture => {
  let transaction = 0;
  const items = capture.events.items.map((event) =>
    event.kind === "request"
      ? {
          ...event,
          observed_at: new Date(START + transaction++ * 1000).toISOString(),
        }
      : event,
  );
  let sequence = Math.max(...items.map((event) => event.sequence));
  const finished = items.flatMap((event) =>
    event.kind === "request"
      ? [
          {
            ...event,
            observed_at: undefined,
            sequence: ++sequence,
            kind: "request-finished" as const,
            elapsed_ms: 5,
          },
        ]
      : [],
  );
  return {
    ...capture,
    events: {
      ...capture.events,
      retained: items.length + finished.length,
      items: [
        ...items,
        ...finished.map(({ observed_at: _unset, ...event }) => event),
      ],
    },
  };
};

const verdicts = (state: ReturnType<typeof environmentStateViewOf>) =>
  Object.fromEntries(
    state.writes.map((plan) => [
      plan.tool,
      plan.served
        ? plan.rules.map(({ field, rule }) => `${field}:${rule}`)
        : plan.reason,
    ]),
  );

it("times scenario records from when each request was observed and how long the browser took", () => {
  const records = scenarioCaptureRecords(
    timed(scenarioCaptureFixture(EXCHANGES)),
    "manifest",
  );
  expect(records.records[1]?.reported).toMatchObject({
    startedDateTime: "2026-10-17T18:00:01.000Z",
    time: 5,
  });
  expect(records.limitations).toContainEqual(
    expect.stringContaining("observed each request"),
  );
  const untimed = scenarioCaptureRecords(
    scenarioCaptureFixture(EXCHANGES),
    "manifest",
  );
  expect(untimed.records[1]?.reported).not.toHaveProperty("startedDateTime");
  expect(untimed.limitations.join(" ")).not.toContain("observed each request");
});

it("learns the clock from a timed scenario as from the same session's HAR, and none without times", () => {
  const har = environmentStateViewOf(timedCaptureEvidence(BOOK_ROWS));
  const scenario = environmentStateViewOf(
    scenarioCaptureEvidence(timed(scenarioCaptureFixture(EXCHANGES))),
  );
  expect(scenario.timeline).toBe("recorded-start-time");
  expect(scenario.write_clock).toBe(BOOK_WRITE_CLOCK);
  expect(verdicts(scenario)).toEqual(verdicts(har));
  expect(Object.values(verdicts(scenario)).flat()).toContain(
    "updated_at:clock",
  );

  const untimed = environmentStateViewOf(
    scenarioCaptureEvidence(scenarioCaptureFixture(EXCHANGES)),
  );
  expect(untimed.timeline).toBe("record-order");
  expect(untimed.write_clock).toBeNull();
  expect(Object.values(verdicts(untimed)).flat()).not.toContain(
    "updated_at:clock",
  );
});
