import { describe, expect, it } from "vitest";

import {
  timedCaptureEvidence,
  type TimedCaptureRow,
} from "../../../tests/fixtures/analysisView.js";
import {
  BOOKMARK_ROWS,
  FOLDER_ROWS,
  TAG_ROWS,
  TAG_UPDATE_ROWS,
} from "../../../tests/fixtures/environmentStateDerivedValues.js";
import { environmentStateViewOf } from "../../../tests/fixtures/environmentStateWrites.js";

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

describe("values an application derives from others", () => {
  it("serves creates whose clocks drop trailing fraction zeros, as Go spells nanoseconds", () => {
    expect(planOf(TAG_ROWS, "post_tags")).toMatchObject({
      served: true,
      rules: expect.arrayContaining([
        { field: "updatedAt", rule: "clock", format: TRIMMED },
      ]),
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
});
