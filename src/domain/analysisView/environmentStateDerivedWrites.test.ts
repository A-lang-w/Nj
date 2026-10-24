import { describe, expect, it } from "vitest";

import {
  timedCaptureEvidence,
  type TimedCaptureRow,
} from "../../../tests/fixtures/analysisView.js";
import {
  BOOKMARK_ROWS,
  FIXED_SIBLING_TAG_ROWS,
  FOLDER_ROWS,
  goClock,
  restoredAddressRows,
  TAG_ROWS,
  TAG_UPDATE_ROWS,
  TWO_CLOCK_TAG_UPDATE_ROWS,
  UNKNOWN_TAG_UPDATE_ROWS,
} from "../../../tests/fixtures/environmentStateDerivedValues.js";
import {
  environmentStateViewOf,
  numberedUuid,
} from "../../../tests/fixtures/environmentStateWrites.js";
import type { JsonValue } from "../jsonValue.js";
import { isObject } from "./environmentStateRules.js";

const planOf = (rows: readonly TimedCaptureRow[], tool: string) => {
  const plan = environmentStateViewOf(timedCaptureEvidence(rows)).writes.find(
    (candidate) => candidate.tool === tool,
  );
  if (plan === undefined) throw new Error(`No plan for ${tool}`);
  return plan;
};

const TRIMMED = {
  kind: "iso",
  separator: "T",
  fraction: 9,
  zone: "Z",
  trimmed: true,
} as const;

describe("clock spellings an application derives", () => {
  it("serves creates whose clocks drop trailing fraction zeros, as Go spells nanoseconds", () => {
    expect(planOf(TAG_ROWS, "post_tags")).toMatchObject({
      served: true,
      rules: expect.arrayContaining([
        { field: "updatedAt", rule: "clock", format: TRIMMED },
      ]),
    });
  });

  it.each([
    ["2026-10-01T09:00:00.12345678Z", "2026-10-01T10:00:00.120000000Z"],
    ["2026-10-01T09:00:00.120000000Z", "2026-10-01T10:00:00.12345678Z"],
    ["2026-10-01T09:00:00.12345678Z", "2026-10-01T10:00:00.123456780Z"],
    ["2026-10-01T09:00:00.123456780Z", "2026-10-01T10:00:00.12345678Z"],
  ])(
    "keeps a create's clock at a fixed width when a held value ends its fraction in a zero (%s, %s)",
    (first, second) => {
      const held = [first, second].map((updatedAt, index) => ({
        id: numberedUuid(index + 1),
        name: `Held ${index + 1}`,
        updatedAt,
      }));
      const created = {
        id: numberedUuid(3),
        name: "Heavy",
        updatedAt: goClock(3, "374763655"),
      };
      const rows: TimedCaptureRow[] = [
        ["GET", "/api/tags", held],
        ...held.map((tag): TimedCaptureRow => [
          "GET",
          `/api/tags/${tag.id}`,
          tag,
        ]),
        ["POST", "/api/tags", created, 201, { name: "Heavy" }],
        ["GET", `/api/tags/${created.id}`, created],
      ];
      expect(planOf(rows, "post_tags").rules).toContainEqual({
        field: "updatedAt",
        rule: "clock",
        format: { kind: "iso", separator: "T", fraction: 9, zone: "Z" },
      });
    },
  );

  it("keeps a create's sibling clock at a fixed width when a later call trims one clock and shows the sibling's trailing zero", () => {
    const rules = planOf(FIXED_SIBLING_TAG_ROWS, "post_tags").rules;
    expect(rules).toContainEqual({
      field: "updatedAt",
      rule: "clock",
      format: TRIMMED,
    });
    expect(rules).toContainEqual({
      field: "createdAt",
      rule: "clock",
      format: { kind: "iso", separator: "T", fraction: 9, zone: "Z" },
    });
  });

  it("serves updates whose clock a later call shows trimmed", () => {
    expect(planOf(TAG_UPDATE_ROWS, "patch_tags_by_uuid")).toMatchObject({
      served: true,
      rules: expect.arrayContaining([
        { field: "updatedAt", rule: "clock", format: TRIMMED },
      ]),
    });
  });

  it("learns no clock spelling from an update to an entity an unmodelled write left unknown", () => {
    expect(planOf(UNKNOWN_TAG_UPDATE_ROWS, "patch_tags_by_uuid")).toMatchObject(
      {
        served: true,
        rules: expect.arrayContaining([
          {
            field: "updatedAt",
            rule: "clock",
            format: { kind: "iso", separator: "T", fraction: 9, zone: "Z" },
          },
        ]),
      },
    );
  });

  it("serves updates whose two clocks a later call shows trimmed for one only", () => {
    expect(
      planOf(TWO_CLOCK_TAG_UPDATE_ROWS, "patch_tags_by_uuid"),
    ).toMatchObject({
      served: true,
      rules: expect.arrayContaining([
        { field: "updatedAt", rule: "clock", format: TRIMMED },
        { field: "syncedAt", rule: "clock", format: TRIMMED },
      ]),
    });
  });
});

describe("values an application composes or generates", () => {
  it("serves creates whose snapshot address joins the creation time and the sent URL, accepting any URL", () => {
    expect(planOf(BOOKMARK_ROWS, "post_bookmarks")).toMatchObject({
      served: true,
      body: { accepted: ["url", "title"], fixed: [] },
      rules: expect.arrayContaining([
        {
          field: "web_archive_snapshot_url",
          rule: "composed",
          parts: [
            { text: "https://web.archive.org/web/" },
            { from: "date_added", as: "clock", pattern: "YYYYMMDDhhmmss" },
            { text: "/" },
            { from: "url", as: "value" },
          ],
        },
      ]),
    });
  });

  it("serves folder creates and renames whose address follows the uid and the title's slug, and whose numeric id is generated", () => {
    const url = {
      field: "url",
      rule: "composed",
      parts: [
        { text: "/dashboards/f/" },
        { from: "uid", as: "value" },
        { text: "/" },
        { from: "title", as: "slug" },
      ],
    };
    expect(planOf(FOLDER_ROWS, "post_folders")).toMatchObject({
      served: true,
      body: { accepted: ["uid", "title"], fixed: [] },
      rules: expect.arrayContaining([{ field: "id", rule: "unique" }, url]),
    });
    expect(planOf(FOLDER_ROWS, "put_folders_by_uuid")).toMatchObject({
      served: true,
      rules: expect.arrayContaining([url]),
    });
  });

  it("withholds renames whose address a later call composes when an earlier call left it otherwise", () => {
    expect(
      planOf(restoredAddressRows(true), "put_folders_by_uuid"),
    ).toMatchObject({
      served: true,
      rules: expect.arrayContaining([
        expect.objectContaining({ field: "url", rule: "composed" }),
      ]),
    });
    // The first rename left its address as it was, which the composition would rebuild.
    expect(
      planOf(restoredAddressRows(false), "put_folders_by_uuid"),
    ).toMatchObject({
      served: false,
      reason: "unexplained-change",
    });
  });

  it("withholds folder creates whose generated numeric id another field repeats, which seeding cannot keep", () => {
    const repeated = (value: JsonValue): JsonValue =>
      Array.isArray(value)
        ? value.map(repeated)
        : isObject(value) && typeof value.id === "number"
          ? { ...value, folderId: value.id }
          : value;
    const rows = FOLDER_ROWS.map((row): TimedCaptureRow => {
      const [method, path, body, ...rest] = row;
      return body === undefined ? row : [method, path, repeated(body), ...rest];
    });
    expect(planOf(rows, "post_folders")).toMatchObject({
      served: false,
      reason: "unexplained-change",
    });
  });
});
