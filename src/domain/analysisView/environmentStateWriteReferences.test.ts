import { describe, expect, it } from "vitest";

import { timedCaptureEvidence } from "../../../tests/fixtures/analysisView.js";
import {
  FILED_ROWS,
  TAGGED_ROWS,
} from "../../../tests/fixtures/environmentStateDerivedValues.js";
import { environmentStateViewOf } from "../../../tests/fixtures/environmentStateWrites.js";
import type { StateEntity } from "./environmentStateRules.js";
import type { FieldRule } from "./environmentStateWriteRules.js";
import {
  referenceRule,
  referencedValue,
} from "./environmentStateWriteReferences.js";

const SHELF = { id: 2, name: "Map Room", floor: "upper" };
const held = (
  type: string,
  id: string,
  fields: StateEntity["fields"],
): StateEntity => ({
  type,
  collection: type,
  id,
  fields,
  view_fields: [],
  record_ordinals: [],
});

describe("objects that repeat the entity a member names", () => {
  it("serves creates that embed the named shelf, and lists show it with the keys they list", () => {
    const view = environmentStateViewOf(timedCaptureEvidence(FILED_ROWS));
    expect(
      view.writes.find((plan) => plan.tool === "post_books"),
    ).toMatchObject({
      served: true,
      body: { accepted: expect.arrayContaining(["name", "shelf_id"]) },
      rules: expect.arrayContaining([
        {
          field: "shelf",
          rule: "reference",
          member: "shelf_id",
          type: "/api/shelves",
          fields: ["id", "name", "floor"],
        },
      ]),
    });
    expect(
      view.views.find((candidate) => candidate.tool === "get_books"),
    ).toMatchObject({
      nested_fields: { shelf: ["id", "name"] },
    });
  });

  it("names the member whose entity the object repeats, the one named like the field when several do", () => {
    const named = (id: string) =>
      id === "2"
        ? [held("/api/shelves", "2", SHELF), held("/api/rooms", "2", SHELF)]
        : [];
    expect(
      referenceRule("shelf", SHELF, { shelf_id: 2 }, named),
    ).toBeUndefined();
    const shelves = (id: string) =>
      id === "2" ? [held("/api/shelves", "2", SHELF)] : [];
    expect(
      referenceRule("shelf", SHELF, { shelf_id: 2, room_id: 2 }, shelves),
    ).toMatchObject({ member: "shelf_id", type: "/api/shelves" });
    expect(
      referenceRule("shelf", { id: 2 }, { shelf_id: 2 }, shelves),
    ).toBeUndefined();
    expect(
      referenceRule(
        "shelf",
        { ...SHELF, floor: "lower" },
        { shelf_id: 2 },
        shelves,
      ),
    ).toBeUndefined();
  });

  it("refuses a call naming an entity the environment does not hold", () => {
    const rule: Extract<FieldRule, { rule: "reference" }> = {
      field: "shelf",
      rule: "reference",
      member: "shelf_id",
      type: "/api/shelves",
      fields: ["id", "name"],
    };
    expect(
      referencedValue(rule, { shelf_id: 9 }, () => undefined),
    ).toMatchObject({
      ok: false,
    });
    expect(referencedValue(rule, {}, () => undefined)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(referencedValue(rule, { shelf_id: 2 }, () => SHELF)).toEqual({
      ok: true,
      value: { id: 2, name: "Map Room" },
    });
  });
});

describe("arrays an application stores sorted", () => {
  it("serves creates that store sent tags in code-point order", () => {
    const view = environmentStateViewOf(timedCaptureEvidence(TAGGED_ROWS));
    expect(
      view.writes.find((plan) => plan.tool === "post_books"),
    ).toMatchObject({
      served: true,
      rules: expect.arrayContaining([
        { field: "tags", rule: "echo", sorted: true },
      ]),
    });
  });
});
