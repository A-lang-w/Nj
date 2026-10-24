import { describe, expect, it } from "vitest";

import {
  timedCaptureEvidence,
  type TimedCaptureRow,
} from "../../../tests/fixtures/analysisView.js";
import { shelvedRows } from "../../../tests/fixtures/environmentStateDerivedValues.js";
import { environmentStateViewOf } from "../../../tests/fixtures/environmentStateWrites.js";

const createPlan = (rows: readonly TimedCaptureRow[]) => {
  const plan = environmentStateViewOf(timedCaptureEvidence(rows)).writes.find(
    (candidate) => candidate.tool === "post_books",
  );
  if (plan === undefined) throw new Error("No create plan");
  return plan;
};

const OPTIONAL_SHELF = {
  served: true,
  body: {
    accepted: ["name", "shelf"],
    required: ["name"],
    defaults: [{ member: "shelf", value: "general" }],
  },
  rules: expect.arrayContaining([{ field: "shelf", rule: "echo" }]),
};

describe("create plans learned from every call", () => {
  it("accepts a member a later create sends, stored as the earlier one's default when left out", () => {
    expect(
      createPlan(
        shelvedRows(
          { name: "Third Book" },
          { name: "Fourth Book", shelf: "rare" },
        ),
      ),
    ).toMatchObject(OPTIONAL_SHELF);
  });

  it("makes a member a later create leaves out optional, with the default that create stored", () => {
    expect(
      createPlan(
        shelvedRows(
          { name: "Third Book", shelf: "rare" },
          { name: "Fourth Book" },
        ),
      ),
    ).toMatchObject(OPTIONAL_SHELF);
  });

  it("serves no plan a later create contradicts by storing a member otherwise than sent", () => {
    expect(
      createPlan(
        shelvedRows(
          { name: "Third Book" },
          { name: "Fourth Book", shelf: "rare" },
          (sent) => sent.toUpperCase(),
        ),
      ),
    ).toMatchObject({ served: false, reason: "unexplained-change" });
  });
});
