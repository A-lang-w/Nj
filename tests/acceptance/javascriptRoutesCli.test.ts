import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { javaScriptRoutesViewResultSchema } from "../../src/domain/analysisView/analysisView.js";

const fixture = async () => {
  const path = await createTestTempDirectory("rea-javascript-routes-");
  await writeFile(
    join(path, "routes.js"),
    `globalThis.TURBOPACK=[];globalThis.TURBOPACK.push([1,function module(){const routes=defineRoutes({reports:{_$:'reports',settings:{_$:'settings'},history:{}}});createBrowserRouter([{path:'/account',children:[{path:':id'}]}]);router.push('/reports/' + selectedId);const extra='/reports/help';}]);`,
  );
  return path;
};
cliTest(
  "exports complete route Evidence and queries it after source removal",
  async ({ cli }) => {
    const path = await fixture(),
      output = join(
        await createTestTempDirectory("rea-route-evidence-"),
        "routes.json",
      );
    const response = await cli.run({
      arguments: [
        "analyze-javascript-application",
        path,
        "--detail",
        "summary",
        "--view",
        JSON.stringify({
          kind: "javascript-routes",
          collection: "routes",
          fields: ["path"],
          where: { path_prefix: "/reports" },
          limit: 2,
        }),
        "--evidence_output",
        output,
        "--json",
      ],
    });
    expect(response.exitCode, response.stderr).toBe(0);
    const envelope = response.json as {
      summary: unknown;
      evidence_bundle: { path: string };
    };
    const view = javaScriptRoutesViewResultSchema.parse(
      parseEvidence(envelope.summary).normalized_result,
    );
    expect(view.items).toHaveLength(2);
    expect(view.coverage).toMatchObject({ total: 4, next_offset: 2 });
    expect(view.sources[0]!.sha256).toMatch(/^[a-f0-9]{64}$/u);
    await rm(path, { recursive: true });
    const bundle = JSON.parse(await readFile(output, "utf8")) as {
      records: { evidence_id: string }[];
    };
    const record = bundle.records.find(
      (record) => record.evidence_id === view.parent_evidence_id,
    );
    expect(record).toBeDefined();
    const evidenceFile = join(
      await createTestTempDirectory("rea-route-record-"),
      "evidence.json",
    );
    await writeFile(evidenceFile, JSON.stringify(record));
    const repeated = await cli.run({
      arguments: [
        "inspect-analysis-view",
        JSON.stringify({
          source: {
            kind: "evidence-file",
            path: evidenceFile,
          },
          view: {
            kind: "javascript-routes",
            collection: "routes",
            where: { path_prefix: "/reports" },
            offset: 2,
            limit: 2,
          },
        }),
        "--json",
      ],
    });
    expect(repeated.exitCode, repeated.stdout + repeated.stderr).toBe(0);
    expect(
      javaScriptRoutesViewResultSchema.parse(
        parseEvidence(repeated.json).normalized_result,
      ).items,
    ).toHaveLength(2);
  },
);
cliTest(
  "rejects invalid route delivery before accessing the application",
  async ({ cli }) => {
    for (const args of [
      ["--view", "{"],
      [
        "--detail",
        "summary",
        "--view",
        '{"kind":"javascript-routes","collection":"routes"}',
      ],
    ]) {
      const response = await cli.run({
        arguments: [
          "analyze-javascript-application",
          "/not-opened",
          ...args,
          "--json",
        ],
      });
      expect(response.exitCode).not.toBe(0);
      expect(response.json).toMatchObject({ code: "invalid_request" });
    }
  },
);
it.each(["full", "compact"] as const)(
  "serves retained route batches through the %s production SDK schemas",
  async (profile) => {
    const path = await fixture(),
      { call } = await connectLocalToolsMcp({
        REA_MCP_INPUT_SCHEMA_PROFILE: profile,
      });
    for (const source_paths of [[], [""], [1]]) {
      const invalid = await call("analyze_javascript_application", {
        input_path: path,
        source_paths,
      });
      expect(invalid.isError).toBe(true);
      expect(JSON.stringify(invalid.content)).toContain("source_paths");
    }
    const response = await call("analyze_javascript_application", {
      input_path: path,
      detail: "summary",
      view: {
        kind: "javascript-routes",
        collection: "routes",
        where: { path_prefix: "/account" },
      },
    });
    expect(response.isError).not.toBe(true);
    const selected = javaScriptRoutesViewResultSchema.parse(
      parseEvidence(response.structuredContent).normalized_result,
    );
    expect(selected.items).toHaveLength(2);
    await rm(path, { recursive: true });
    const occurrences = await call("inspect_analysis_view", {
      source: {
        kind: "retained-evidence",
        evidence_id: selected.parent_evidence_id,
      },
      view: {
        kind: "javascript-routes",
        collection: "occurrences",
        where: { route_ids: selected.items.map((row) => row.id) },
        fields: ["segments"],
      },
    });
    expect(occurrences.isError).not.toBe(true);
    const result = javaScriptRoutesViewResultSchema.parse(
      parseEvidence(occurrences.structuredContent).normalized_result,
    );
    expect(result.items).toHaveLength(2);
    expect(result.sources).toHaveLength(1);
    expect(result.source_coverage.application_routes).toBe("unknown");
  },
);

cliTest(
  "projects captured route facts through both browser adapters",
  async ({ cli }) => {
    const { startFakeCdpBrowser } =
      await import("../fixtures/fakeCdpBrowser.js");
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Debugger.getScriptSource"
          ? {
              scriptSource: `const secondary=[{path:'/reports/panel',element:Panel}];createBrowserRouter([{path:'/reports',children:[{path:'settings'}],element:jsx(Panel,{routes:secondary})}]);`,
            }
          : undefined,
    });
    try {
      const view = {
        kind: "javascript-routes",
        collection: "routes",
        where: { paths: ["/reports/settings", "/reports/panel"] },
      };
      const output = join(
        await createTestTempDirectory("rea-browser-route-evidence-"),
        "routes.json",
      );
      const response = await cli.run({
        arguments: [
          "analyze-web-bundle",
          browser.endpoint,
          "allowed-page",
          "--allowed-origins",
          browser.allowedOrigin,
          "--observation-ms",
          "0",
          "--detail",
          "summary",
          "--view",
          JSON.stringify(view),
          "--evidence_output",
          output,
          "--json",
        ],
      });
      expect(response.exitCode, response.stderr).toBe(0);
      const envelope = response.json as { summary: unknown };
      const selected = javaScriptRoutesViewResultSchema.parse(
        parseEvidence(envelope.summary).normalized_result,
      );
      expect(selected.items).toHaveLength(2);
      expect(selected.artifact).toBeNull();
      const { call } = await connectLocalToolsMcp();
      const observed = await call("analyze_web_bundle", {
        cdp_endpoint: browser.endpoint,
        target_id: "allowed-page",
        allowed_origins: [browser.allowedOrigin],
        observation_ms: 0,
        detail: "summary",
        view,
      });
      expect(observed.isError).not.toBe(true);
      const result = javaScriptRoutesViewResultSchema.parse(
        parseEvidence(observed.structuredContent).normalized_result,
      );
      expect(result.items).toHaveLength(2);
      const retained = await call("inspect_analysis_view", {
        source: {
          kind: "retained-evidence",
          evidence_id: result.parent_evidence_id,
        },
        view: { kind: "javascript-routes", collection: "sources" },
      });
      expect(retained.isError).not.toBe(true);
      expect(
        javaScriptRoutesViewResultSchema.parse(
          parseEvidence(retained.structuredContent).normalized_result,
        ).items.length,
      ).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  },
  120000,
);

it("keeps a large source's partial route facts queryable through SDK delivery", async () => {
  const path = await createTestTempDirectory("rea-large-route-result-");
  const text = Array.from(
    { length: 12000 },
    (_, index) => `route('/reports/${index}/${"x".repeat(96)}');`,
  ).join("\n");
  await writeFile(join(path, "routes.js"), text);
  const { call } = await connectLocalToolsMcp({
    NODE_OPTIONS: "--max-old-space-size=3072",
  });
  const response = await call("analyze_javascript_application", {
    input_path: path,
    max_semantic_nodes: 1,
    max_semantic_unknowns: 8,
    max_heap_mb: 512,
    analysis_timeout_ms: 30000,
    detail: "summary",
    view: {
      kind: "javascript-routes",
      collection: "routes",
      fields: ["path"],
      limit: 2,
    },
  });
  expect(response.isError).not.toBe(true);
  const selected = javaScriptRoutesViewResultSchema.parse(
    parseEvidence(response.structuredContent).normalized_result,
  );
  expect(selected.items).toHaveLength(2);
  expect(selected.source_coverage.candidate_enumeration).toBe("partial");
  expect(selected.sources[0]).toMatchObject({
    status: "complete",
    sha256: createHash("sha256").update(text).digest("hex"),
    reported_route_capacity: { kind: "result-bytes" },
  });
  expect(Buffer.byteLength(JSON.stringify(selected))).toBeLessThanOrEqual(
    1024 * 1024,
  );
  const unknowns = await call("inspect_analysis_view", {
    source: {
      kind: "retained-evidence",
      evidence_id: selected.parent_evidence_id,
    },
    view: {
      kind: "javascript-routes",
      collection: "unknowns",
      where: { kinds: ["capacity"] },
      fields: ["reason"],
    },
  });
  expect(unknowns.isError).not.toBe(true);
  expect(
    javaScriptRoutesViewResultSchema.parse(
      parseEvidence(unknowns.structuredContent).normalized_result,
    ).items.length,
  ).toBeGreaterThan(0);
}, 60000);
