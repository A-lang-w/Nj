import { expect, it } from "vitest";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import {
  buildJavaScriptRouteInventorySteps,
  javaScriptRouteInventorySchema,
  type JavaScriptRouteInventoryInput,
} from "./javascriptRouteInventory.js";

const source = (
  key: string,
  text: string,
  url: string | null = null,
): JavaScriptRouteInventoryInput => ({
  key,
  path: url === null ? key : null,
  url,
  sha256: "a".repeat(64),
  container_sha256: null,
  status: "complete",
  reason: null,
  facts: analyzeJavaScriptStaticSource(text).routes!,
});
const build = (inputs: JavaScriptRouteInventoryInput[], bytes?: number) =>
  javaScriptRouteInventorySchema.parse(
    completeSemanticSteps(buildJavaScriptRouteInventorySteps(inputs, bytes)),
  );

it("coalesces exact patterns while retaining independent occurrences and stable identities", () => {
  const inputs = [
    source("one.js", `router.push('/reports');`),
    source(
      "two.js",
      `createBrowserRouter([{path:'/reports',children:[{path:'settings'}]}]);`,
    ),
  ];
  const result = build(inputs),
    repeated = build([...inputs].reverse());
  expect(result.routes.map(({ path }) => path)).toEqual([
    "/reports",
    "/reports/settings",
  ]);
  expect(result.routes[0]).toMatchObject({
    occurrence_count: 3,
    source_count: 2,
  });
  expect(result.routes.map(({ id }) => id)).toEqual(
    repeated.routes.map(({ id }) => id),
  );
  expect(result.source_manifest_sha256).toBe(repeated.source_manifest_sha256);
  expect(result.inventory_id).toBe(repeated.inventory_id);
  expect(result.coverage.application_routes).toBe("unknown");
});
it("chooses deterministic primary provenance when sources have equal confidence", () => {
  const inputs = [
    source("one.js", `router.push('/reports');`),
    source("two.js", `router.push('/reports');`),
  ];
  expect(build(inputs)).toEqual(build([...inputs].reverse()));
});
it("binds ordinary constants to application segments across sources and excludes framework filesystem noise", () => {
  const result = build([
    source("navigation.js", `router.push('/reports');`),
    source(
      "runtime.js",
      `globalThis.TURBOPACK=[];const routes=['/reports/:id','/ROOT/node_modules/next/process/','/_not-found'];`,
    ),
  ]);
  expect(result.routes.map(({ path }) => path)).toEqual([
    "/reports",
    "/reports/:id",
  ]);
  expect(result.statistics.unanchored_literals_excluded).toBe(2);
});
it("retains inferred Next script bases and the unprefixed path", () => {
  const result = build([
    source(
      "script",
      `router.push('/planner');`,
      "https://example.test/app/_next/static/chunks/123.js",
    ),
  ]);
  expect(result.routes.map(({ path }) => path)).toEqual(["/app/planner"]);
  expect(result.occurrences[0]).toMatchObject({
    unprefixed_path: "/planner",
    inferred_base_path: "/app",
    confidence: "low",
  });
  expect(result.sources[0]!.url).toBe(
    "https://example.test/app/_next/static/chunks/123.js",
  );
  expect(result.unknowns.some(({ kind }) => kind === "inferred-base")).toBe(
    true,
  );
});
it("reports missing source facts as partial and preserves filename-only discoveries without fake AST ranges", () => {
  const result = build([
    {
      ...source("app/reports/[id]/page.js", ""),
      status: "unavailable",
      reason: "source was not selected",
      facts: null,
    },
  ]);
  expect(result.coverage).toMatchObject({
    source_parsing: "partial",
    candidate_enumeration: "partial",
    application_routes: "unknown",
  });
  expect(result.routes[0]!.path).toBe("/reports/:id");
  expect(result.occurrences[0]).toMatchObject({
    origin: "source-path",
    source_range: null,
  });
});
it("does not interpret the URL authority or file URL prefix as an App Router directory or routing base", () => {
  const result = build([
    source("script", `router.push('/reports');`, "https://app/reports/page.js"),
  ]);
  expect(result.routes.map(({ path }) => path)).toEqual(["/reports"]);
  const local = build([
    source("file", `router.push('/reports');`, "file:///tmp/_next/123.js"),
  ]);
  expect(local.sources[0]!.base_path).toBeNull();
  expect(local.routes[0]!.path).toBe("/reports");
});
it("rejects forged aggregate counts and detached provenance", () => {
  const result = build([source("one.js", `router.push('/reports');`)]);
  expect(
    javaScriptRouteInventorySchema.safeParse({
      ...result,
      routes: result.routes.map((route) => ({
        ...route,
        occurrence_count: 99,
      })),
    }).success,
  ).toBe(false);
  expect(
    javaScriptRouteInventorySchema.safeParse({ ...result, sources: [] })
      .success,
  ).toBe(false);
});

it("retains a bounded prefix with explicit capacity and counts only retained facts", () => {
  const inputs = [
    source(
      "many.js",
      Array.from(
        { length: 100 },
        (_, index) => `router.push('/reports/${index}');`,
      ).join("\n"),
    ),
  ];
  const result = build(inputs, 8192);
  expect(result.routes.length).toBeGreaterThan(0);
  expect(result.routes.length).toBeLessThan(100);
  expect(result.coverage.candidate_enumeration).toBe("partial");
  expect(result.capacity?.limit_bytes).toBe(8192);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192);
  expect(() => build(inputs, 1)).toThrow(RangeError);
});
