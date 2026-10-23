import { expect, it } from "vitest";

import { analysisSearchPredicate } from "./analysisSearch.js";

it.each([
  ["Σ", "ΟΣ", true],
  ["σ", "ΟΣ", true],
  ["ς", "ΟΣ", true],
  ["ΟΣ", "οσ", true],
  ["Σ", "ΣA", true],
  ["foo", "FOO", true],
  [".", "x", false],
  ["[Σ]+", "prefix [ς]+ suffix", true],
  ["a+b", "AAAB", false],
  ["\\", "path\\file", true],
  ["", "anything", true],
  ["𐐀", "prefix 𐐨 suffix", true],
] as const)(
  "matches literal %s in %s without contextual lowercasing",
  (pattern, value, expected) => {
    const common = { pattern, document: undefined, mode: "literal" as const };
    expect(
      analysisSearchPredicate({ ...common, case_sensitive: false })(value),
    ).toBe(expected);
    expect(
      analysisSearchPredicate({ ...common, case_sensitive: true })(value),
    ).toBe(value.includes(pattern));
  },
);

it("retains regex matching and invalid-pattern input errors", () => {
  const common = {
    document: undefined,
    mode: "regex" as const,
    case_sensitive: false,
  };
  expect(analysisSearchPredicate({ ...common, pattern: "^σ$" })("ς")).toBe(
    true,
  );
  expect(() => analysisSearchPredicate({ ...common, pattern: "[" })).toThrow(
    "search",
  );
});
