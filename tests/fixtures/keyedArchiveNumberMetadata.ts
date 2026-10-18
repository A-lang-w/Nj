import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { build } from "plist";
import { expect } from "vitest";

import { keyedArchiveResultSchema } from "../../src/domain/apple/keyedArchive.js";
import type { JsonValue } from "../../src/domain/jsonValue.js";
import { createTestTempDirectory } from "./temporaryDirectory.js";

const EXACT_INTEGER = { $plist_type: "integer", decimal: "9007199254740993" };
const ROUNDED = 9007199254740992;

/** Unknown integer literals must not discard independent numeric facts. */
const unknownArchiveIntegerLiterals = [
  ["9007199254740992<!-- split -->3", "unsupported-markup"],
  ["9007199254740992<![CDATA[3]]>", "unsupported-markup"],
  ["<![CDATA[9007199254740992]]>3", "unsupported-markup"],
  ["<![CDATA[9007199254740992&#51;]]>", "unsupported-markup"],
  ["9007199254740992<?rea split?>3", "unsupported-markup"],
  ["9007199254740992<string>3</string>", "unsupported-markup"],
  ["9007199254740992x", "invalid-literal"],
] as const;

/** Ordinary dictionaries and malformed numeric references at the same boundary. */
export const archiveNumberMetadataCases = [
  ...[
    {
      element: "<real>9007199254740992<![CDATA[0]]></real>",
      value: 90071992547409920,
    },
    {
      element: "<real><![CDATA[1]]>9007199254740992</real>",
      value: Number("19007199254740992"),
    },
  ].map(({ element, value }) => ({
    name: element,
    source: { first: "__INTEGER__", other: "__OTHER__" },
    element,
    expected: { first: EXACT_INTEGER, other: value },
    unknownScalar: false,
    exactInteger: true,
    malformedReference: false,
  })),
  ...unknownArchiveIntegerLiterals.map(([literal, reason]) => ({
    name: `<integer>${literal}</integer>`,
    source: { first: "__INTEGER__", other: "__OTHER__" },
    element: `<integer>${literal}</integer>`,
    expected: {
      first: EXACT_INTEGER,
      other: { $plist_type: "unknown", element: "integer", literal, reason },
    },
    unknownScalar: true,
    exactInteger: true,
    malformedReference: false,
  })),
  ...(["UID", "CF$UID"] as const).flatMap((key) => [
    {
      name: `${key} dictionary data`,
      source: { [key]: { amount: "__INTEGER__" } },
      element: "",
      expected: { [key]: { amount: EXACT_INTEGER } },
      unknownScalar: false,
      exactInteger: true,
      malformedReference: false,
    },
    {
      name: `${key} array data`,
      source: { [key]: ["__INTEGER__"] },
      element: "",
      expected: { [key]: [EXACT_INTEGER] },
      unknownScalar: false,
      exactInteger: true,
      malformedReference: false,
    },
    {
      name: `${key} malformed numeric reference`,
      source: { [key]: "__INTEGER__" },
      element: "",
      expected: { [key]: ROUNDED },
      unknownScalar: false,
      exactInteger: false,
      malformedReference: true,
    },
  ]),
  {
    name: "entity-encoded integer text",
    source: { amount: "__INTEGER__" },
    element: "",
    expected: {
      amount: {
        $plist_type: "unknown",
        element: "integer",
        literal: "&#57;007199254740993",
        reason: "invalid-literal",
      },
    },
    unknownScalar: true,
    exactInteger: false,
    malformedReference: false,
    integerElement: "<integer>&#57;007199254740993</integer>",
  },
] satisfies readonly {
  name: string;
  source: JsonValue;
  element: string;
  expected: JsonValue;
  unknownScalar: boolean;
  exactInteger: boolean;
  malformedReference: boolean;
  integerElement?: string;
}[];

type MetadataCase = (typeof archiveNumberMetadataCases)[number];

/** Write one inert archive and retain the original byte digest for assertions. */
export const keyedArchiveNumberMetadataFixture = async (item: MetadataCase) => {
  const root = await createTestTempDirectory("rea-keyed-number-metadata-");
  const xml = build({
    $archiver: "NSKeyedArchiver",
    $version: 100000,
    $objects: ["$null", item.source],
    $top: { root: { CF$UID: 1 } },
  })
    .replace(
      "<string>__INTEGER__</string>",
      "integerElement" in item
        ? item.integerElement
        : "<integer>9007199254740993</integer>",
    )
    .replace("<string>__OTHER__</string>", item.element);
  const bytes = Buffer.from(xml);
  const path = join(root, "archive.plist");
  await writeFile(path, bytes);
  return {
    root,
    path,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
};

/** Require exact values, explicit unknowns and independently retained metadata. */
export const expectKeyedArchiveNumberMetadata = (
  value: unknown,
  item: MetadataCase,
  digest: string,
) => {
  const result = keyedArchiveResultSchema.parse(value);
  expect(result.archive_sha256).toBe(digest);
  expect(result.roots).toEqual({ root: { CF$UID: 1 } });
  expect(result.objects).toHaveLength(2);
  expect(result.objects[1]).toMatchObject({
    id: 1,
    kind: "dictionary",
    value: item.expected,
  });
  expect(result.references).toContainEqual({
    source: null,
    path: ["root"],
    target: 1,
    status: "resolved",
    raw: { CF$UID: 1 },
  });
  expect(result.limitations).not.toContainEqual(
    expect.stringMatching(/metadata.*completely observed.*precision/u),
  );
  expect(
    result.limitations.filter((note) => note.includes("XML scalar value(s)")),
  ).toEqual(
    item.unknownScalar
      ? [
          expect.stringMatching(
            /^1 XML scalar value\(s\) could not be established/u,
          ),
        ]
      : [],
  );
  expect(
    result.limitations.filter((note) => note.includes("unambiguous integer")),
  ).toEqual(
    item.exactInteger
      ? [expect.stringMatching(/^1 unambiguous integer value/u)]
      : [],
  );
  expect(
    result.limitations.filter((note) =>
      note.includes("observed integer literal(s)"),
    ),
  ).toEqual(
    item.exactInteger || item.malformedReference
      ? [expect.stringMatching(/^1 observed integer literal\(s\)/u)]
      : [],
  );
  if (item.malformedReference) {
    expect(result.references).toContainEqual({
      source: 1,
      path: [],
      target: null,
      status: "malformed",
      raw: item.expected,
    });
  } else {
    expect(result.references).toHaveLength(1);
  }
};
