import { describe, expect, it } from "vitest";

import type { JsonValue } from "../jsonValue.js";
import type { StateRecordFacts } from "./environmentStateRules.js";
import { creationLimit } from "./environmentStateWriteLinks.js";

const record = (
  ordinal: number,
  method: string,
  path: string,
): StateRecordFacts => ({
  ordinal,
  method,
  path,
  query: undefined,
  status: 200,
  start: ordinal,
  end: ordinal,
});

describe("creation limits", () => {
  it("reads the ids of a list body longer than a call's arguments can spread", () => {
    // A million elements overflow the argument limit of a spread, here and in the test workers' larger stack.
    const [list, post, later] = [
      record(0, "GET", "/api/metrics"),
      record(1, "POST", "/api/imports"),
      record(2, "GET", "/api/metrics"),
    ];
    const bodies = new Map<number, JsonValue>([
      [0, Array.from({ length: 1_000_000 }, () => 0)],
      [2, [{ id: "1003" }]],
    ]);
    const limit = creationLimit(
      [{ record: post, ids: ["1003"] }],
      {
        type: "/api/metrics",
        tools: [
          {
            name: "get_metrics",
            method: "GET",
            path_template: "/api/metrics",
            record_ordinals: [0, 2],
          },
        ],
        records: new Map([list, post, later].map((at) => [at.ordinal, at])),
        position: (at) => at.ordinal,
        body: (ordinal) => bodies.get(ordinal),
      },
      undefined,
    );
    expect(limit).toBe(post);
  });
});
