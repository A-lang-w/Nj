import { z } from "zod";

import { analysisSearchInput } from "../contracts/analysisSearchContract.js";
import { AnalysisInputError } from "./analysisErrorCore.js";

/** Parsed `search_procedures`/`search_strings` query shared by providers that match in REA. */
export const analysisSearchQuerySchema = z.object(analysisSearchInput);

export type AnalysisSearchQuery = z.infer<typeof analysisSearchQuerySchema>;

/**
 * Match names the way the search contract describes: a literal substring by
 * default, or a Unicode regular expression, case-insensitive unless requested.
 * An invalid pattern is the caller's input error.
 */
export const analysisSearchPredicate = (
  query: AnalysisSearchQuery,
): ((value: string) => boolean) => {
  if (query.mode === "regex") {
    let regex: RegExp;
    try {
      regex = new RegExp(query.pattern, query.case_sensitive ? "u" : "iu");
    } catch (cause: unknown) {
      throw new AnalysisInputError("search", { cause });
    }
    return (value) => regex.test(value);
  }
  if (query.case_sensitive) return (value) => value.includes(query.pattern);
  // Unicode case folding is independent of word context, unlike toLowerCase
  // (a final Greek sigma lowercases differently from a standalone sigma).
  // Escape every regex metacharacter so this branch remains a literal search.
  const literal = new RegExp(
    query.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "iu",
  );
  return (value) => literal.test(value);
};
