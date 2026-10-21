import { digestCanonicalValue } from "../canonicalDigest.js";
import { z } from "zod";
import { jsonValueByteLength } from "../jsonValueByteLength.js";
import type { JsonValue } from "../jsonValue.js";
import { digestSchema } from "../digests.js";
import { JAVASCRIPT_STATIC_FACT_BYTES } from "./javascriptAnalysisResourceControls.js";
import {
  javaScriptRouteCandidateSchema,
  javaScriptRouteMechanismSchema,
  javaScriptRouteRangeSchema,
  javaScriptRouteSegmentSchema,
  javaScriptRouteSourceFactsSchema,
  type JavaScriptRouteCandidate,
  type JavaScriptRouteSourceFacts,
} from "./javascriptRouteFacts.js";
import {
  nextAppRoutePath,
  nextScriptBasePath,
} from "./javascriptRoutePaths.js";

const sourceStatus = z.enum(["complete", "partial", "unavailable", "unknown"]);
const confidence = javaScriptRouteCandidateSchema.shape.confidence;
const sourceShape = {
  id: z.string().regex(/^jss:[a-f0-9]{32}$/u),
  key: z.string(),
  path: z.string().nullable(),
  url: z.string().nullable(),
  sha256: digestSchema.nullable(),
  container_sha256: digestSchema.nullable(),
  status: sourceStatus,
  reported_route_capacity: javaScriptRouteSourceFactsSchema.shape.capacity,
  reason: z.string().nullable(),
  base_path: z
    .strictObject({
      value: z.string(),
      basis: z.literal("next-script-url"),
      status: z.literal("inferred"),
    })
    .nullable(),
};
export const javaScriptRouteInventorySourceSchema = z.strictObject(sourceShape);
export const javaScriptRouteOccurrenceSchema = z.strictObject({
  id: z.string().regex(/^jso:[a-f0-9]{32}$/u),
  route_id: z.string().regex(/^jsr:[a-f0-9]{32}$/u),
  source_id: sourceShape.id,
  mechanism: javaScriptRouteMechanismSchema,
  confidence,
  derivation: javaScriptRouteCandidateSchema.shape.derivation,
  source_range: javaScriptRouteRangeSchema.nullable(),
  origin: z.enum(["source-syntax", "source-path", "source-url"]),
  unprefixed_path: z.string(),
  inferred_base_path: z.string().nullable(),
  segments: z.array(javaScriptRouteSegmentSchema),
});
export const javaScriptInventoryRouteSchema = z.strictObject({
  id: z.string().regex(/^jsr:[a-f0-9]{32}$/u),
  path: z.string().startsWith("/"),
  classification: z.enum(["page", "system", "unknown"]),
  classification_basis: z.enum([
    "next-app-page",
    "router-configuration",
    "path-name-heuristic",
    "unknown",
  ]),
  confidence,
  mechanisms: z.array(javaScriptRouteMechanismSchema),
  occurrence_count: z.number().int().nonnegative(),
  source_count: z.number().int().nonnegative(),
  primary_occurrence_id: javaScriptRouteOccurrenceSchema.shape.id,
});
export const javaScriptRouteGapSchema = z.strictObject({
  id: z.string().regex(/^jsg:[a-f0-9]{32}$/u),
  source_id: sourceShape.id.nullable(),
  kind: z.enum([
    "source-unavailable",
    "interpretation",
    "inferred-base",
    "capacity",
  ]),
  source_range: javaScriptRouteRangeSchema.nullable(),
  reason: z.string(),
});
const capacitySchema = z.strictObject({
  limit_bytes: z.number().int().nonnegative(),
  accounted_bytes: z.number().int().nonnegative(),
});
const inventoryShape = z.strictObject({
  inventory_id: z.string().regex(/^jsri:[a-f0-9]{64}$/u),
  source_manifest_sha256: digestSchema,
  sources: z.array(javaScriptRouteInventorySourceSchema),
  routes: z.array(javaScriptInventoryRouteSchema),
  occurrences: z.array(javaScriptRouteOccurrenceSchema),
  unknowns: z.array(javaScriptRouteGapSchema),
  coverage: z.strictObject({
    scope: z.literal("provided-code-sources"),
    source_parsing: z.enum(["complete", "partial", "unknown"]),
    candidate_enumeration: z.enum(["complete", "partial"]),
    application_routes: z.literal("unknown"),
  }),
  statistics: z.strictObject({
    sources_seen: z.number().int().nonnegative(),
    sources_retained: z.number().int().nonnegative(),
    route_patterns: z.number().int().nonnegative(),
    occurrences: z.number().int().nonnegative(),
    unanchored_literals_excluded: z.number().int().nonnegative(),
  }),
  capacity: capacitySchema.nullable(),
  limitations: z.array(z.string()),
});
export const javaScriptRouteInventorySchema = inventoryShape.superRefine(
  (value, context) => {
    const sources = new Set<string>(),
      routes = new Map<
        string,
        z.infer<typeof javaScriptInventoryRouteSchema>
      >(),
      occurrences = new Map<
        string,
        z.infer<typeof javaScriptRouteOccurrenceSchema>
      >();
    for (const source of value.sources) {
      if (
        sources.has(source.id) ||
        source.id !==
          lookupId("jss", [
            source.key,
            source.path,
            source.url,
            source.sha256,
            source.container_sha256,
          ])
      )
        context.addIssue({
          code: "custom",
          path: ["sources"],
          message:
            "Route source identity must be unique and bind its source/content fields",
        });
      sources.add(source.id);
    }
    for (const route of value.routes) {
      if (routes.has(route.id) || route.id !== routeId(route.path))
        context.addIssue({
          code: "custom",
          path: ["routes"],
          message: "Route identity must uniquely bind its exact pattern",
        });
      routes.set(route.id, route);
    }
    const byRoute = new Map<string, typeof value.occurrences>();
    for (const occurrence of value.occurrences) {
      if (
        occurrences.has(occurrence.id) ||
        !sources.has(occurrence.source_id) ||
        !routes.has(occurrence.route_id) ||
        occurrence.id !==
          lookupId("jso", [
            occurrence.source_id,
            routes.get(occurrence.route_id)?.path ?? null,
            occurrence.mechanism,
            occurrence.origin,
            occurrence.source_range,
            occurrence.segments,
          ])
      )
        context.addIssue({
          code: "custom",
          path: ["occurrences"],
          message:
            "Route occurrences require unique identities and retained source/route owners",
        });
      occurrences.set(occurrence.id, occurrence);
      let rows = byRoute.get(occurrence.route_id);
      if (rows === undefined) {
        rows = [];
        byRoute.set(occurrence.route_id, rows);
      }
      rows.push(occurrence);
    }
    for (const route of value.routes) {
      const rows = byRoute.get(route.id) ?? [],
        primary = occurrences.get(route.primary_occurrence_id);
      if (
        rows.length !== route.occurrence_count ||
        new Set(rows.map((row) => row.source_id)).size !== route.source_count ||
        primary?.route_id !== route.id ||
        rows.some((row) => !route.mechanisms.includes(row.mechanism)) ||
        new Set(rows.map((row) => row.mechanism)).size !==
          new Set(route.mechanisms).size ||
        new Set(route.mechanisms).size !== route.mechanisms.length ||
        route.confidence !== primary?.confidence ||
        rows.some((row) => ranks[row.confidence] > ranks[route.confidence]) ||
        route.classification !==
          classify(route.path, route.mechanisms).classification ||
        route.classification_basis !==
          classify(route.path, route.mechanisms).classification_basis
      )
        context.addIssue({
          code: "custom",
          path: ["routes"],
          message:
            "Route aggregates and primary provenance must match their occurrences",
        });
    }
    if (
      value.statistics.sources_retained !== value.sources.length ||
      value.statistics.route_patterns !== value.routes.length ||
      value.statistics.occurrences !== value.occurrences.length
    )
      context.addIssue({
        code: "custom",
        path: ["statistics"],
        message: "Route statistics must count retained facts",
      });
    const gaps = new Set<string>();
    for (const gap of value.unknowns) {
      if (
        gaps.has(gap.id) ||
        gap.id !==
          lookupId("jsg", [
            gap.source_id,
            gap.kind,
            gap.source_range,
            gap.reason,
          ]) ||
        (gap.source_id !== null && !sources.has(gap.source_id))
      )
        context.addIssue({
          code: "custom",
          path: ["unknowns"],
          message:
            "An attributed route gap requires a unique content-bound identity and retained source",
        });
      gaps.add(gap.id);
    }
    const { inventory_id, ...body } = value;
    if (inventory_id !== `jsri:${hash(["javascript-routes-v1", body])}`)
      context.addIssue({
        code: "custom",
        path: ["inventory_id"],
        message:
          "Inventory identity must bind all retained facts and coverage.",
      });
  },
);
export type JavaScriptRouteInventory = z.infer<
  typeof javaScriptRouteInventorySchema
>;
export type JavaScriptInventoryRoute = z.infer<
  typeof javaScriptInventoryRouteSchema
>;
export type JavaScriptRouteOccurrence = z.infer<
  typeof javaScriptRouteOccurrenceSchema
>;
export type JavaScriptRouteInventorySource = z.infer<
  typeof javaScriptRouteInventorySourceSchema
>;
export interface JavaScriptRouteInventoryInput {
  readonly key: string;
  readonly path: string | null;
  readonly url: string | null;
  readonly sha256: string | null;
  readonly container_sha256: string | null;
  readonly status: z.infer<typeof sourceStatus>;
  readonly reason: string | null;
  readonly facts: JavaScriptRouteSourceFacts | null;
}
const hash = (value: JsonValue): string =>
  digestCanonicalValue(value, "JavaScript route fact");
const lookupId = (prefix: string, value: JsonValue): string =>
  `${prefix}:${hash(value).slice(0, 32)}`;
const routeId = (path: string): string => lookupId("jsr", path);
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const ranks = { low: 0, medium: 1, high: 2 } as const;
const classify = (
  path: string,
  mechanisms: readonly string[],
): Pick<
  JavaScriptInventoryRoute,
  "classification" | "classification_basis"
> => {
  if (
    /(?:^|\/)(?:auth|login|logout|signin|signup|billing|callback|callbacks|oauth|sso)(?:\/|$)/iu.test(
      path,
    )
  )
    return {
      classification: "system",
      classification_basis: "path-name-heuristic",
    };
  if (mechanisms.includes("next-app-chunk"))
    return { classification: "page", classification_basis: "next-app-page" };
  if (mechanisms.includes("nested-route-object"))
    return {
      classification: "page",
      classification_basis: "router-configuration",
    };
  return { classification: "unknown", classification_basis: "unknown" };
};

const INVENTORY_LIMITATIONS = [
  "Routes are static candidates from the provided code sources. Reachability, permissions, server-only routes and the complete application route set are unverified.",
  "Pattern IDs are exact path identities within this inventory. Occurrence and source IDs retain source/content identity and precise syntax ranges; metadata-only discoveries have no AST range.",
  "System classification is a path-name heuristic. Asset URL prefixes can differ from routing bases; inferred prefixes retain the original unprefixed path.",
  "Unbound path strings require a top-level segment supported by structural routes or navigation candidates. Unknown or missing source facts do not establish route absence.",
] as const;

/** Join only owned syntax facts and source metadata; never fetch or reinterpret source text. */
export function* buildJavaScriptRouteInventorySteps(
  inputs: readonly JavaScriptRouteInventoryInput[],
  byteBudget = JAVASCRIPT_STATIC_FACT_BYTES,
): Generator<void, JavaScriptRouteInventory> {
  const sources: JavaScriptRouteInventorySource[] = [],
    occurrences: JavaScriptRouteOccurrence[] = [],
    unknowns: JavaScriptRouteInventory["unknowns"] = [];
  const routes = new Map<string, JavaScriptInventoryRoute>(),
    sourceIdsByRoute = new Map<string, Set<string>>(),
    seenOccurrences = new Set<string>(),
    seenGaps = new Set<string>();
  const contexts: {
    input: JavaScriptRouteInventoryInput;
    source: JavaScriptRouteInventorySource;
    metadataPath: string | undefined;
  }[] = [];
  // Reserve a conservative envelope before admitting rows. It covers the four
  // arrays, digests, fixed limitations and every counter at its widest encoding.
  const headerBytes = jsonValueByteLength({
    inventory_id: `jsri:${"f".repeat(64)}`,
    source_manifest_sha256: "f".repeat(64),
    sources: [],
    routes: [],
    occurrences: [],
    unknowns: [],
    capacity: {
      limit_bytes: Number.MAX_SAFE_INTEGER,
      accounted_bytes: Number.MAX_SAFE_INTEGER,
    },
    coverage: {
      scope: "provided-code-sources",
      source_parsing: "complete",
      candidate_enumeration: "complete",
      application_routes: "unknown",
    },
    statistics: Object.fromEntries(
      [
        "sources_seen",
        "sources_retained",
        "route_patterns",
        "occurrences",
        "unanchored_literals_excluded",
      ].map((key) => [key, Number.MAX_SAFE_INTEGER]),
    ),
    limitations: [...INVENTORY_LIMITATIONS],
  });
  if (!Number.isSafeInteger(byteBudget) || byteBudget < headerBytes)
    throw new RangeError(
      `Route inventory budget must fit its ${headerBytes}-byte envelope.`,
    );
  let accounted = headerBytes,
    capacity: JavaScriptRouteInventory["capacity"] = null,
    partial = false,
    unanchored = 0;
  const reserve = (value: JsonValue): boolean => {
    if (capacity !== null) return false;
    const bytes = jsonValueByteLength(value, byteBudget - accounted) + 1;
    if (bytes > byteBudget - accounted) {
      capacity = { limit_bytes: byteBudget, accounted_bytes: accounted };
      partial = true;
      return false;
    }
    accounted += bytes;
    return true;
  };
  const gap = (
    source: JavaScriptRouteInventorySource,
    kind: z.infer<typeof javaScriptRouteGapSchema>["kind"],
    reason: string,
    source_range: z.infer<typeof javaScriptRouteRangeSchema> | null = null,
  ): void => {
    const value = {
      id: lookupId("jsg", [source.id, kind, source_range, reason]),
      source_id: source.id,
      kind,
      source_range,
      reason,
    };
    if (!seenGaps.has(value.id) && reserve(value)) {
      unknowns.push(value);
      seenGaps.add(value.id);
    }
  };
  const manifestIds: string[] = [];
  for (const input of inputs) {
    yield;
    const id = lookupId("jss", [
      input.key,
      input.path,
      input.url,
      input.sha256,
      input.container_sha256,
    ]);
    manifestIds.push(id);
    const prefix =
      input.url === null ? undefined : nextScriptBasePath(input.url);
    const source: JavaScriptRouteInventorySource = {
      id,
      key: input.key,
      path: input.path,
      url: input.url,
      sha256: input.sha256,
      container_sha256: input.container_sha256,
      status: input.status,
      reported_route_capacity: input.facts?.capacity ?? null,
      reason: input.reason,
      base_path: prefix
        ? { value: prefix, basis: "next-script-url", status: "inferred" }
        : null,
    };
    if (!reserve(source)) continue;
    sources.push(source);
    const metadataPath = nextAppRoutePath(input.url ?? input.path ?? "");
    contexts.push({ input, source, metadataPath });
    if (input.status !== "complete" || input.facts === null) {
      partial = true;
      gap(
        source,
        "source-unavailable",
        input.reason ?? "Route syntax was not fully measured for this source.",
      );
    }
    if (source.base_path !== null)
      gap(
        source,
        "inferred-base",
        "A Next script URL prefix is an inferred routing base; assetPrefix may differ from the deployed route base.",
      );
    if (input.facts?.capacity !== null && input.facts?.capacity !== undefined) {
      partial = true;
      gap(
        source,
        "capacity",
        `Source route work/facts reached ${input.facts.capacity.limit_bytes} accounted bytes; additional candidates remain unknown.`,
      );
    }
    for (const unknown of input.facts?.unresolved ?? []) {
      partial = true;
      gap(source, "interpretation", unknown.reason, unknown.location);
    }
  }
  const prefixPath = (
    path: string,
    source: JavaScriptRouteInventorySource,
  ): string => {
    const base = source.base_path?.value;
    return base === undefined || path === base || path.startsWith(`${base}/`)
      ? path
      : `${base}${path}`;
  };
  const roots = new Set<string>();
  for (const { input, source, metadataPath } of contexts) {
    yield;
    if (metadataPath !== undefined) {
      const path = prefixPath(metadataPath, source);
      if (path.split("/")[1]) roots.add(path.split("/")[1]!);
    }
    for (const candidate of input.facts?.candidates ?? [])
      if (candidate.mechanism !== "route-string-constant") {
        const root = prefixPath(candidate.path, source).split("/")[1];
        if (root) roots.add(root);
      }
  }
  const append = (
    source: JavaScriptRouteInventorySource,
    candidate: Omit<JavaScriptRouteCandidate, "location"> & {
      location: z.infer<typeof javaScriptRouteRangeSchema> | null;
    },
    origin: JavaScriptRouteOccurrence["origin"],
  ): void => {
    if (capacity !== null) return;
    const path = prefixPath(candidate.path, source);
    if (
      candidate.mechanism === "route-string-constant" &&
      !roots.has(path.split("/")[1]!)
    ) {
      unanchored++;
      return;
    }
    const route_id = routeId(path),
      inferredBase = path === candidate.path ? null : source.base_path!.value;
    const identity: JsonValue = [
      source.id,
      path,
      candidate.mechanism,
      origin,
      candidate.location,
      candidate.segments,
    ];
    const id = lookupId("jso", identity);
    if (seenOccurrences.has(id)) return;
    const occurrence: JavaScriptRouteOccurrence = {
      id,
      route_id,
      source_id: source.id,
      mechanism: candidate.mechanism,
      confidence: inferredBase === null ? candidate.confidence : "low",
      derivation: inferredBase === null ? candidate.derivation : "inferred",
      source_range: origin === "source-syntax" ? candidate.location : null,
      origin,
      unprefixed_path: candidate.path,
      inferred_base_path: inferredBase,
      segments: origin === "source-syntax" ? candidate.segments : [],
    };
    let route = routes.get(path);
    if (route === undefined) {
      route = {
        id: route_id,
        path,
        ...classify(path, [candidate.mechanism]),
        confidence: occurrence.confidence,
        mechanisms: [],
        occurrence_count: 0,
        source_count: 0,
        primary_occurrence_id: id,
      };
      if (
        !reserve({
          ...route,
          classification_basis: "router-configuration",
          confidence: "medium",
          mechanisms: javaScriptRouteMechanismSchema.options,
          occurrence_count: Number.MAX_SAFE_INTEGER,
          source_count: Number.MAX_SAFE_INTEGER,
        })
      )
        return;
    }
    if (!reserve(occurrence)) return;
    if (!routes.has(path)) {
      routes.set(path, route);
      sourceIdsByRoute.set(route_id, new Set());
    }
    occurrences.push(occurrence);
    seenOccurrences.add(id);
    route.occurrence_count++;
    const routeSources = sourceIdsByRoute.get(route_id)!;
    routeSources.add(source.id);
    route.source_count = routeSources.size;
    if (!route.mechanisms.includes(candidate.mechanism)) {
      route.mechanisms.push(candidate.mechanism);
      Object.assign(route, classify(path, route.mechanisms));
    }
    if (
      ranks[occurrence.confidence] > ranks[route.confidence] ||
      (ranks[occurrence.confidence] === ranks[route.confidence] &&
        id < route.primary_occurrence_id)
    ) {
      route.confidence = occurrence.confidence;
      route.primary_occurrence_id = id;
    }
  };
  for (const { input, source, metadataPath } of contexts) {
    yield;
    if (metadataPath !== undefined)
      append(
        source,
        {
          path: metadataPath,
          mechanism: "next-app-chunk",
          confidence: "medium",
          derivation: "joined",
          location: null,
          segments: [],
        },
        source.url === null ? "source-path" : "source-url",
      );
    for (const candidate of input.facts?.candidates ?? []) {
      yield;
      append(source, candidate, "source-syntax");
      if (capacity !== null) break;
    }
  }
  sources.sort((a, b) => order(a.key, b.key) || order(a.id, b.id));
  occurrences.sort((a, b) => order(a.id, b.id));
  const items = [...routes.values()].sort((a, b) => order(a.path, b.path));
  for (const route of items) route.mechanisms.sort(order);
  unknowns.sort(
    (a, b) =>
      order(a.source_id ?? "", b.source_id ?? "") ||
      order(a.kind, b.kind) ||
      (a.source_range?.start.line ?? 0) - (b.source_range?.start.line ?? 0) ||
      (a.source_range?.start.column ?? 0) -
        (b.source_range?.start.column ?? 0) ||
      (a.source_range?.end.line ?? 0) - (b.source_range?.end.line ?? 0) ||
      (a.source_range?.end.column ?? 0) - (b.source_range?.end.column ?? 0) ||
      order(a.reason, b.reason),
  );
  const source_manifest_sha256 = hash(manifestIds.sort(order));
  const result: Omit<JavaScriptRouteInventory, "inventory_id"> = {
    source_manifest_sha256,
    sources,
    routes: items,
    occurrences,
    unknowns,
    capacity,
    coverage: {
      scope: "provided-code-sources",
      source_parsing:
        sources.length === 0
          ? "unknown"
          : sources.some((source) => source.status !== "complete") ||
              capacity !== null
            ? "partial"
            : "complete",
      candidate_enumeration: partial ? "partial" : "complete",
      application_routes: "unknown",
    },
    statistics: {
      sources_seen: inputs.length,
      sources_retained: sources.length,
      route_patterns: items.length,
      occurrences: occurrences.length,
      unanchored_literals_excluded: unanchored,
    },
    limitations: [...INVENTORY_LIMITATIONS],
  };
  return {
    inventory_id: `jsri:${hash(["javascript-routes-v1", result])}`,
    ...result,
  };
}
