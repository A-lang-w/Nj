import { z } from "zod";

import { ANALYSIS_RESOURCE_KINDS } from "./analysisErrorCore.js";
import { webBundleAnalysisSchema } from "./webBundleAnalysis.js";

const observations = webBundleAnalysisSchema.shape.observations.shape;

/**
 * Facts one captured script contributes to a bundle analysis. Every
 * deduplication key the analyzer uses is scoped by script_key, so independently
 * analyzed scripts concatenate in capture order without changing results.
 */
export const webBundleScriptFactsSchema = z.strictObject({
  script_key: z.string(),
  parse: z.enum(["parsed", "recovered", "failed"]),
  returned_reference_widened: z.boolean(),
  visited_ast_nodes: z.number().int().min(0),
  edges: observations.chunks.shape.edges,
  routes: observations.routes,
  endpoints: observations.endpoints,
  webmcp_declarations: observations.webmcp_declarations,
  inferences: webBundleAnalysisSchema.shape.inferences,
});
export type WebBundleScriptFacts = z.infer<typeof webBundleScriptFactsSchema>;

/** One script either produced its complete facts or stopped at a resource bound. */
export type WebBundleScriptOutcome =
  | { readonly status: "analyzed"; readonly facts: WebBundleScriptFacts }
  | {
      readonly status: "resource_limited";
      readonly script_key: string;
      readonly resource: (typeof ANALYSIS_RESOURCE_KINDS)[number];
      readonly reason: string;
    };
