import { z } from "zod";

const point = z.strictObject({
  line: z.number().int().positive().describe("One-based source line."),
  column: z
    .number()
    .int()
    .nonnegative()
    .describe("Zero-based UTF-16 source column; end is exclusive."),
});
export const javaScriptRouteRangeSchema = z
  .strictObject({
    start: point,
    end: point,
  })
  .refine(
    ({ start, end }) =>
      end.line > start.line ||
      (end.line === start.line && end.column >= start.column),
    "Source range end precedes its start.",
  );
export const javaScriptRouteMechanismSchema = z.enum([
  "router-call",
  "nested-route-object",
  "typed-route-tree",
  "next-app-chunk",
  "navigation-target",
  "route-string-constant",
]);
export const javaScriptRouteSegmentSchema = z.strictObject({
  value: z.string(),
  location: javaScriptRouteRangeSchema,
  origin: z.enum(["literal", "property-name", "next-app-path"]),
});
export const javaScriptRouteCandidateSchema = z.strictObject({
  path: z.string().startsWith("/"),
  mechanism: javaScriptRouteMechanismSchema,
  confidence: z.enum(["low", "medium", "high"]),
  derivation: z.enum(["literal", "joined", "inferred"]),
  location: javaScriptRouteRangeSchema,
  segments: z.array(javaScriptRouteSegmentSchema),
});
export const javaScriptRouteSourceFactsSchema = z.strictObject({
  candidates: z.array(javaScriptRouteCandidateSchema),
  unresolved: z.array(
    z.strictObject({
      mechanism: javaScriptRouteMechanismSchema,
      location: javaScriptRouteRangeSchema,
      reason: z.string(),
    }),
  ),
  capacity: z
    .strictObject({
      kind: z.literal("route-work-or-facts"),
      limit_bytes: z.number().int().nonnegative(),
      accounted_fact_bytes: z.number().int().nonnegative(),
      accounted_work_bytes: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type JavaScriptRouteCandidate = z.infer<
  typeof javaScriptRouteCandidateSchema
>;
export type JavaScriptRouteSegment = z.infer<
  typeof javaScriptRouteSegmentSchema
>;
export type JavaScriptRouteSourceFacts = z.infer<
  typeof javaScriptRouteSourceFactsSchema
>;
