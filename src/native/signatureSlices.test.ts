import { describe, expect, it } from "vitest";
import {
  describeEntitlementDifferences,
  describeSignatureSlices,
  describeSignedSlicesBesideUnsigned,
  entitlementShape,
  type AggregateSignature,
  type SliceSignature,
} from "./signatureSlices.js";

const ARM = "133d589374281103e27b32ee243781884bc41413";
const X86 = "269615ed3412eb7a8c0945e51c76355412db4b12";

const aggregate: AggregateSignature = {
  identifier: "com.example.armslice",
  team_identifier: null,
  cdhashes: [ARM],
  authorities: [],
  hardened_runtime: true,
  entitlements: { "com.apple.security.cs.disable-library-validation": true },
  designated_requirement: `cdhash H"${ARM}" or cdhash H"${X86}"`,
};

const armSlice: SliceSignature = {
  architecture: "arm64",
  identifier: "com.example.armslice",
  team_identifier: null,
  cdhashes: [ARM],
  authorities: [],
  hardened_runtime: true,
};

const x86Slice: SliceSignature = {
  architecture: "x86_64",
  identifier: "com.example.x86slice",
  team_identifier: null,
  cdhashes: [X86],
  authorities: [],
  hardened_runtime: false,
  entitlementDifferences: describeEntitlementDifferences(
    { "com.apple.security.get-task-allow": true },
    aggregate.entitlements,
  ),
};

describe("describeSignatureSlices", () => {
  it("returns nothing when no signed slice was queried", () => {
    expect(describeSignatureSlices("arm64", aggregate, [])).toEqual([]);
  });

  it("names the other slices and every differing field of theirs", () => {
    expect(
      describeSignatureSlices("arm64", aggregate, [x86Slice, armSlice]),
    ).toEqual([
      `Other signed Mach-O slices: x86_64 (CDHash ${X86}).`,
      `Mach-O slices signed differently from the arm64 slice: x86_64 (identifier "com.example.x86slice"; hardened runtime off; entitlements "com.apple.security.cs.disable-library-validation" absent, "com.apple.security.get-task-allow": true).`,
      `designated_requirement names CDHashes of other slices (x86_64 ${X86}); cdhashes lists only the requested slice.`,
    ]);
  });

  it("does not attribute a requirement hash that matches no queried slice", () => {
    const stale = "ab".repeat(20);
    const limitations = describeSignatureSlices(
      "arm64",
      {
        ...aggregate,
        designated_requirement: `cdhash H"${ARM}" or cdhash H"${X86}" or cdhash H"${stale}"`,
      },
      [x86Slice, armSlice],
    );
    expect(limitations.at(-1)).toBe(
      `designated_requirement names CDHashes of other slices (x86_64 ${X86}) and names CDHashes matching no queried slice (${stale}); cdhashes lists only the requested slice.`,
    );
    const onlyStale = describeSignatureSlices(
      "arm64",
      { ...aggregate, designated_requirement: `cdhash H"${stale}"` },
      [armSlice],
    );
    expect(onlyStale.at(-1)).toBe(
      `designated_requirement names CDHashes matching no queried slice (${stale}); cdhashes lists only the requested slice.`,
    );
  });

  it("names signed slices when the requested slice is unsigned", () => {
    expect(describeSignedSlicesBesideUnsigned("x86_64", [])).toEqual([]);
    expect(describeSignedSlicesBesideUnsigned("x86_64", [armSlice])).toEqual([
      `Mach-O slices signed although the requested x86_64 slice is unsigned: arm64 (identifier "com.example.armslice"; team identifier not set; authorities none; CDHash ${ARM}; hardened runtime on); signed is false for the requested slice and their entitlements were not reported.`,
    ]);
  });

  it("lists only the other slices when they are signed alike", () => {
    // An identity requirement names no CDHash, so nothing contradicts cdhashes.
    const alike: AggregateSignature = {
      ...aggregate,
      identifier: "com.apple.true",
      authorities: [
        "Software Signing",
        "Apple Code Signing Certification Authority",
      ],
      hardened_runtime: false,
      entitlements: null,
      designated_requirement: 'identifier "com.apple.true" and anchor apple',
    };
    const slice = (architecture: string, cdhash: string): SliceSignature => ({
      architecture,
      identifier: "com.apple.true",
      team_identifier: null,
      cdhashes: [cdhash],
      authorities: alike.authorities,
      hardened_runtime: false,
      entitlementDifferences: null,
    });
    expect(
      describeSignatureSlices("arm64e", alike, [
        slice("x86_64", X86),
        slice("arm64e", ARM),
        slice("arm64e.x1", "ab".repeat(20)),
      ]),
    ).toEqual([
      `Other signed Mach-O slices: x86_64 (CDHash ${X86}), arm64e.x1 (CDHash ${"ab".repeat(20)}).`,
    ]);
    // codesign selects a variant of the requested family; the CDHash tells.
    expect(
      describeSignatureSlices("arm64", alike, [
        slice("x86_64", X86),
        slice("arm64e.x1", ARM),
      ]),
    ).toEqual([`Other signed Mach-O slices: x86_64 (CDHash ${X86}).`]);
  });

  it("keeps an unmatched requested slice visible instead of guessing", () => {
    const limitations = describeSignatureSlices(
      "arm64e",
      { ...aggregate, cdhashes: ["ff".repeat(20)] },
      [x86Slice, armSlice],
    );
    expect(limitations[0]).toBe(
      `The requested arm64e slice matched no queried slice by name or CDHash; queried signed slices: x86_64 (CDHash ${X86}), arm64 (CDHash ${ARM}).`,
    );
    expect(limitations[1]).toContain(
      "Mach-O slices signed differently from the arm64e slice: x86_64 (",
    );
  });
});

describe("describeSignatureSlices entitlement and requirement details", () => {
  it("does not report entitlements for a slice that was not asked for them", () => {
    const { entitlementDifferences: _omitted, ...withoutEntitlements } =
      x86Slice;
    const limitations = describeSignatureSlices("arm64", aggregate, [
      withoutEntitlements,
      armSlice,
    ]);
    expect(limitations[1]).toBe(
      `Mach-O slices signed differently from the arm64 slice: x86_64 (identifier "com.example.x86slice"; hardened runtime off).`,
    );
  });

  it("describes empty and missing entitlements as none", () => {
    const limitations = describeSignatureSlices(
      "arm64",
      { ...aggregate, entitlements: null },
      [
        {
          ...x86Slice,
          identifier: aggregate.identifier,
          hardened_runtime: true,
          entitlementDifferences: describeEntitlementDifferences({}, null),
        },
        armSlice,
      ],
    );
    expect(
      limitations.some((text) => text.includes("signed differently")),
    ).toBe(false);
    const differing = describeSignatureSlices("arm64", aggregate, [
      {
        ...x86Slice,
        identifier: aggregate.identifier,
        hardened_runtime: true,
        entitlementDifferences: describeEntitlementDifferences(
          null,
          aggregate.entitlements,
        ),
      },
      armSlice,
    ]);
    expect(differing[1]).toBe(
      "Mach-O slices signed differently from the arm64 slice: x86_64 (entitlements none).",
    );
  });
});

describe("describeEntitlementDifferences values and quoting", () => {
  it("shows the differing value when both slices carry the same entitlement key", () => {
    const limitations = describeSignatureSlices(
      "arm64",
      {
        ...aggregate,
        entitlements: {
          "com.apple.security.get-task-allow": false,
          "com.apple.security.cs.disable-library-validation": true,
        },
      },
      [
        {
          ...x86Slice,
          identifier: aggregate.identifier,
          hardened_runtime: true,
          entitlementDifferences: describeEntitlementDifferences(
            {
              "com.apple.security.get-task-allow": true,
              "com.apple.security.cs.disable-library-validation": true,
            },
            {
              "com.apple.security.get-task-allow": false,
              "com.apple.security.cs.disable-library-validation": true,
            },
          ),
        },
        armSlice,
      ],
    );
    expect(limitations[1]).toBe(
      `Mach-O slices signed differently from the arm64 slice: x86_64 (entitlements "com.apple.security.get-task-allow": true (described slice false)).`,
    );
  });

  it("reads entitlement keys that shadow prototype properties as own entries", () => {
    const limitations = describeSignatureSlices(
      "arm64",
      { ...aggregate, entitlements: { toString: true } },
      [
        {
          ...x86Slice,
          identifier: aggregate.identifier,
          hardened_runtime: true,
          entitlementDifferences: describeEntitlementDifferences(
            { constructor: "x", hasOwnProperty: 1 },
            { toString: true },
          ),
        },
        armSlice,
      ],
    );
    expect(limitations[1]).toBe(
      'Mach-O slices signed differently from the arm64 slice: x86_64 (entitlements "constructor": "x", "hasOwnProperty": 1, "toString" absent).',
    );
  });

  it("keeps long differing values distinguishable after the cut", () => {
    const base = "x".repeat(90);
    const differences = describeEntitlementDifferences(
      { "com.example.long": `${base}a` },
      { "com.example.long": `${base}b` },
    );
    expect(differences).toMatch(
      /^"com\.example\.long": "x{76}\.\.\. \(93 chars, sha256 [0-9a-f]{16}\) \(described slice "x{76}\.\.\. \(93 chars, sha256 [0-9a-f]{16}\)\)$/u,
    );
    const [ours, theirs] = [
      ...(differences ?? "").matchAll(/sha256 ([0-9a-f]{16})/gu),
    ].map(([, digest]) => digest);
    expect(ours).not.toBe(theirs);
  });

  it("tells a data value from a dictionary that projects to the same JSON", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const sameProjection = { "0": 1, "1": 2, "2": 3 };
    expect(entitlementShape(bytes)).not.toBe(entitlementShape(sameProjection));
    expect(entitlementShape(bytes)).not.toBe(
      entitlementShape({ $plist_type: "data", base64: "AQID" }),
    );
    expect(entitlementShape(bytes)).toBe(
      entitlementShape(new Uint8Array([1, 2, 3])),
    );
    expect(
      describeEntitlementDifferences(
        { blob: sameProjection },
        { blob: sameProjection },
        {
          slice: entitlementShape({ blob: bytes }),
          described: entitlementShape({ blob: sameProjection }),
        },
      ),
    ).toBe(
      "same projected values, but the plist value types differ (for example data against a dictionary)",
    );
    expect(
      describeEntitlementDifferences(
        { a: 1 },
        { a: 1 },
        {
          slice: entitlementShape({ a: 1 }),
          described: entitlementShape({ a: 1 }),
        },
      ),
    ).toBeNull();
  });

  it("quotes identity values so a delimiter inside them cannot read as a field", () => {
    const limitations = describeSignatureSlices("arm64", aggregate, [
      {
        ...armSlice,
        architecture: "x86_64",
        cdhashes: [X86],
        identifier: "foo; hardened runtime off",
        entitlementDifferences: null,
      },
      armSlice,
    ]);
    expect(limitations[1]).toBe(
      'Mach-O slices signed differently from the arm64 slice: x86_64 (identifier "foo; hardened runtime off").',
    );
    expect(describeEntitlementDifferences({ "x: true, y": false }, {})).toBe(
      '"x: true, y": false',
    );
  });

  it("compares CDHashes without regard to letter case", () => {
    const limitations = describeSignatureSlices(
      "arm64e",
      {
        ...aggregate,
        cdhashes: [ARM.toUpperCase()],
        designated_requirement: null,
      },
      [armSlice],
    );
    expect(limitations).toEqual([]);
  });
});
