import { describe, expect, it } from "vitest";

import {
  timedCaptureEvidence,
  type TimedCaptureRow,
} from "../../../tests/fixtures/analysisView.js";
import { shelvedRows } from "../../../tests/fixtures/environmentStateDerivedValues.js";
import { environmentStateViewOf } from "../../../tests/fixtures/environmentStateWrites.js";
import { mergedCreatePlan } from "./environmentStateWriteCreateCalls.js";
import type { FieldRule } from "./environmentStateWriteRules.js";

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

describe("merging a later create into a plan", () => {
  const body = (accepted: string[], required = accepted) => ({
    accepted,
    fixed: [],
    required,
    identity: null,
    kinds: [],
  });
  const plan = {
    rules: [
      { field: "id", rule: "identity", generator: "sequence" } as const,
      { field: "name", rule: "echo" } as const,
    ],
    body: body(["name"]),
  };
  const exemplar = { id: 3, name: "Third", shelf: "general" };
  const later = (
    overrides: Partial<Parameters<typeof mergedCreatePlan>[2]>,
  ) => ({
    entity: { id: 4, name: "Fourth", shelf: "rare" },
    body: { name: "Fourth", shelf: "rare" },
    rules: [...plan.rules, { field: "shelf", rule: "echo" } as const],
    contract: body(["name", "shelf"]),
    ...overrides,
  });

  it("refuses a field neither call rules that holds another value, or a member one fixes and the other accepts", () => {
    expect(
      mergedCreatePlan(plan, exemplar, later({ rules: plan.rules })),
    ).toBeUndefined();
    expect(
      mergedCreatePlan(
        {
          ...plan,
          body: { ...body(["name"]), fixed: [{ member: "shelf", sent: "x" }] },
        },
        exemplar,
        later({}),
      ),
    ).toBeUndefined();
  });

  it("takes a reference one call alone shows when the other did not send its member", () => {
    const reference: FieldRule = {
      field: "shelf",
      rule: "reference",
      member: "shelf_id",
      type: "/api/shelves",
      fields: ["id", "name"],
    };
    const merged = mergedCreatePlan(
      plan,
      { id: 3, name: "Third" },
      later({
        entity: { id: 4, name: "Fourth", shelf: { id: 1, name: "Main" } },
        body: { name: "Fourth", shelf_id: 1 },
        rules: [...plan.rules, reference],
        contract: body(["name", "shelf_id"]),
      }),
    );
    expect(merged).toMatchObject({
      rules: expect.arrayContaining([reference]),
      body: { accepted: ["name", "shelf_id"], required: ["name"] },
    });
  });
});
