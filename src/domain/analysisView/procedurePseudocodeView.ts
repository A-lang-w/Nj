import { z } from "zod";

import type { AnalysisError } from "../analysisErrorBase.js";
import { analysisInputErrorFromIssues } from "../inputIssueProjection.js";
import { err, ok, type Result } from "../result.js";
import type {
  AnalysisViewParent,
  AnalysisViewRequest,
  UnsignedAnalysisView,
} from "./analysisView.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import { completeWithinViewCoverage } from "./analysisViewCoverage.js";
import { parseAnalysisViewResult } from "./analysisViewParent.js";
import { analysisTextPage } from "./analysisViewText.js";

const selectionSchema = z.strictObject({
  procedure: z.string(),
  document: z.string().optional(),
});
const unavailable = {
  available: false as const,
  reason: "Provider returned null" as const,
};

/** A returned null remains distinct from a returned, empty pseudocode string. */
export const procedurePseudocodeSummarySchema = z.strictObject({
  selection: selectionSchema,
  pseudocode: z.discriminatedUnion("available", [
    z.strictObject({
      available: z.literal(true),
      code_units: z.number().int().nonnegative(),
      unit: z.literal("utf16-code-units"),
    }),
    z.strictObject({
      available: z.literal(false),
      reason: z.literal("Provider returned null"),
    }),
  ]),
});

/** Project the original scalar observation, never another decompilation or a synthetic dossier. */
export const projectProcedurePseudocodeView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (
    view.kind !== "summary" &&
    !(view.kind === "native" && view.facet === "pseudocode")
  )
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "procedure_pseudo_code Evidence supports summary or native pseudocode views.",
        },
      ]),
    );
  if (parent.artifact == null)
    return err(
      analysisViewInputError([
        {
          path: ["source", "subject"],
          reason: "invalid_value",
          message: "Pseudocode Evidence requires an artifact-bound subject.",
        },
      ]),
    );
  const parsed = parseAnalysisViewResult(z.string().nullable(), parent);
  if (!parsed.ok) return parsed;
  const selection = selectionSchema.safeParse(parent.parameters);
  if (!selection.success)
    return err(
      analysisInputErrorFromIssues(
        "inspect_analysis_view",
        selection.error.issues.map((issue) => ({
          ...issue,
          path: ["source", "parameters", ...issue.path],
        })),
        { source: { parameters: parent.parameters } },
        { cause: selection.error },
      ),
    );
  const text = parsed.value;
  const common = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "procedure_pseudo_code" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: parent.artifact,
    limitations: [...parent.limitations],
    unknowns:
      text === null
        ? [
            "Provider returned null; this does not establish absence of a function.",
          ]
        : [],
  };
  if (view.kind === "summary")
    return ok({
      kind: "summary",
      view,
      ...common,
      summary: {
        selection: selection.data,
        pseudocode:
          text === null
            ? unavailable
            : {
                available: true,
                code_units: text.length,
                unit: "utf16-code-units",
              },
      },
      coverage: completeWithinViewCoverage(1, 1),
    });
  if (text === null)
    return ok({
      kind: "native",
      view,
      ...common,
      procedure_address: null,
      item: unavailable,
      coverage: completeWithinViewCoverage(1, 1),
    });
  const page = analysisTextPage(text, view.offset, view.limit);
  return page.ok
    ? ok({
        kind: "native",
        view,
        ...common,
        procedure_address: null,
        ...page.value,
      })
    : page;
};
