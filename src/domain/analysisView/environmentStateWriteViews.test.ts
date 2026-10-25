import { describe, expect, it } from "vitest";

import {
  timedCaptureEvidence,
  type TimedCaptureRow,
} from "../../../tests/fixtures/analysisView.js";
import {
  LISTED_LABEL_ROWS,
  READ_BACK_TAG_ROWS,
  RESTAMPED_ROWS,
  STALE_SLUG_ROWS,
} from "../../../tests/fixtures/environmentStateWriteViews.js";
import { environmentStateViewOf } from "../../../tests/fixtures/environmentStateWrites.js";

const planOf = (rows: readonly TimedCaptureRow[], tool: string) => {
  const plan = environmentStateViewOf(timedCaptureEvidence(rows)).writes.find(
    (candidate) => candidate.tool === tool,
  );
  if (plan === undefined) throw new Error(`No plan for ${tool}`);
  return plan;
};

describe("creates whose answer shows the entity otherwise than reads do", () => {
  it("serves a create whose item read adds a count and spells the clock otherwise, taking the read's fields", () => {
    expect(planOf(READ_BACK_TAG_ROWS, "post_tags")).toMatchObject({
      served: true,
      observation: {
        ordinal: 3,
        pointer: "",
        read: { ordinal: 4, pointer: "", shape: "item" },
      },
      rules: expect.arrayContaining([
        {
          field: "created",
          rule: "clock",
          format: expect.objectContaining({ fraction: 0 }),
        },
      ]),
    });
  });

  it("serves a create whose list read adds a count the answer lacks", () => {
    expect(planOf(LISTED_LABEL_ROWS, "post_labels")).toMatchObject({
      served: true,
      observation: { read: { ordinal: 2, pointer: "/2", shape: "list" } },
    });
  });
});

describe("whole-object updates that send back what the application derives", () => {
  it("slugs a sent slug anew from the name the call stored", () => {
    expect(planOf(STALE_SLUG_ROWS, "put_tags_by_id")).toMatchObject({
      served: true,
      rules: expect.arrayContaining([
        { field: "slug", rule: "slug", from: "name" },
        { field: "name", rule: "echo" },
      ]),
      body: { accepted: expect.arrayContaining(["slug", "name"]) },
    });
  });

  it("stamps anew a modification time each call sends back as it read it", () => {
    expect(planOf(RESTAMPED_ROWS, "put_posts_by_id")).toMatchObject({
      served: true,
      rules: expect.arrayContaining([
        expect.objectContaining({ field: "updated_at", rule: "clock" }),
      ]),
      body: { accepted: expect.arrayContaining(["updated_at"]) },
    });
  });
});
