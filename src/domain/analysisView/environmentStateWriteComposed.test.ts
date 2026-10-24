import { describe, expect, it } from "vitest";

import type { JsonObject } from "./environmentStateRules.js";
import {
  composedChange,
  composedValue,
  createdComposer,
} from "./environmentStateWriteComposed.js";
import type { FieldRule } from "./environmentStateWriteRules.js";

const CLOCK: FieldRule = {
  field: "added",
  rule: "clock",
  format: { kind: "iso", separator: "T", fraction: 0, zone: "Z" },
};

const bookmark = (url: string, added: string): JsonObject => ({
  url,
  added,
  modified: added,
  snapshot: `https://web.archive.org/web/${added.replace(/\D/gu, "").slice(0, 14)}/${url}`,
});

const SEED = bookmark(
  "https://ferries.example.test/timetable",
  "2026-10-01T09:00:00Z",
);
const CREATED = bookmark(
  "https://quarry.example.test/ledger",
  "2026-10-17T18:00:03Z",
);
const ECHO_URL: FieldRule = { field: "url", rule: "echo" };

describe("strings a create composes from other fields", () => {
  it("spells a snapshot address from the write clock's digits and the sent URL, as held entities do", () => {
    const rule = createdComposer(
      CREATED,
      [ECHO_URL, CLOCK],
      [SEED],
    )("snapshot");
    expect(rule).toEqual({
      field: "snapshot",
      rule: "composed",
      parts: [
        { text: "https://web.archive.org/web/" },
        { from: "added", as: "clock", pattern: "YYYYMMDDhhmmss" },
        { text: "/" },
        { from: "url", as: "value" },
      ],
    });
    expect(
      composedValue(rule!.rule === "composed" ? rule!.parts : [], SEED),
    ).toBe(SEED["snapshot"]);
  });

  it("composes nothing one call alone shows, nor what a held entity spells otherwise", () => {
    expect(
      createdComposer(CREATED, [ECHO_URL, CLOCK], [])("snapshot"),
    ).toBeUndefined();
    const stale = {
      ...SEED,
      snapshot: "https://web.archive.org/web/20250101000000/x",
    };
    expect(
      createdComposer(CREATED, [ECHO_URL, CLOCK], [SEED, stale])("snapshot"),
    ).toBeUndefined();
  });

  it.each([
    ["before", (url: string) => `𐐀${url}`],
    ["after", (url: string) => `${url}𐐀`],
  ])(
    "composes nothing from a value an astral letter joins %s it",
    (_, label) => {
      const labelled = (entity: JsonObject): JsonObject => ({
        ...entity,
        label: label(String(entity["url"])),
      });
      expect(
        createdComposer(
          labelled(CREATED),
          [ECHO_URL, CLOCK],
          [labelled(SEED)],
        )("label"),
      ).toBeUndefined();
    },
  );

  it("takes two clocks a create stamps alike as one source, but not two members that send the same text", () => {
    const modified: FieldRule = { ...CLOCK, field: "modified" };
    expect(
      createdComposer(CREATED, [ECHO_URL, CLOCK, modified], [SEED])("snapshot"),
    ).toMatchObject({ rule: "composed" });
    const folder = {
      uid: "scratch-pier",
      title: "Scratch Pier",
      url: "/dashboards/f/scratch-pier/scratch-pier",
    };
    const seed = {
      uid: "lighthouse-rota",
      title: "Lighthouse Rota",
      url: "/dashboards/f/lighthouse-rota/lighthouse-rota",
    };
    expect(
      createdComposer(
        folder,
        [
          { field: "uid", rule: "echo" },
          { field: "title", rule: "echo" },
        ],
        [seed],
      )("url"),
    ).toBeUndefined();
  });
});

describe("strings an update composes from other fields", () => {
  const before = {
    uid: "scratch-alpha",
    title: "Scratch Alpha Harbor",
    url: "/dashboards/f/scratch-alpha/scratch-alpha-harbor",
  };
  const after = {
    ...before,
    title: "Renamed Alpha Lantern",
    url: "/dashboards/f/scratch-alpha/renamed-alpha-lantern",
  };
  const change = (overrides: {
    readonly after?: JsonObject;
    readonly sent?: JsonObject;
    readonly others?: readonly JsonObject[];
  }) =>
    composedChange("url", {
      before,
      after: overrides.after ?? after,
      sent: overrides.sent ?? { title: "Renamed Alpha Lantern" },
      idField: "uid",
      others: overrides.others ?? [],
    });

  it("spells an address from an unchanged uid and the sent title's slug, which spell it before the call too", () => {
    expect(change({})).toEqual({
      field: "url",
      rule: "composed",
      parts: [
        { text: "/dashboards/f/" },
        { from: "uid", as: "value" },
        { text: "/" },
        { from: "title", as: "slug" },
      ],
    });
  });

  it("composes nothing from a member the application stored otherwise than sent, nor what another entity spells otherwise", () => {
    expect(
      change({ sent: { title: "RENAMED ALPHA LANTERN" } }),
    ).toBeUndefined();
    expect(
      change({
        others: [
          { uid: "other-folder", title: "Other Folder", url: "/f/other" },
        ],
      }),
    ).toBeUndefined();
  });

  it("composes nothing the same parts do not spell before the call", () => {
    expect(
      change({
        after: {
          ...after,
          url: "/dashboards/f/scratch-alpha/renamed-alpha-lantern-1",
        },
      }),
    ).toBeUndefined();
  });
});
