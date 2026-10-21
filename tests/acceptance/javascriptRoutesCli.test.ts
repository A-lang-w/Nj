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
    `const routes=defineRoutes({reports:{_$:'reports',settings:{_$:'settings'},history:{}}});createBrowserRouter([{path:'/account',children:[{path:':id'}]}]);`,
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
    expect(view.coverage).toMatchObject({ total: 3, next_offset: 2 });
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
    ).toHaveLength(1);
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
it("serves retained route batches and provenance through the production SDK schemas", async () => {
  const path = await fixture(),
    { call } = await connectLocalToolsMcp();
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
});

cliTest(
  "projects captured route facts through both browser adapters",
  async ({ cli }) => {
    const { startFakeCdpBrowser } =
      await import("../fixtures/fakeCdpBrowser.js");
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Debugger.getScriptSource"
          ? {
              scriptSource: `createBrowserRouter([{path:'/reports',children:[{path:'settings'}]}]);`,
            }
          : undefined,
    });
    try {
      const view = {
        kind: "javascript-routes",
        collection: "routes",
        where: { paths: ["/reports/settings"] },
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
      expect(selected.items).toHaveLength(1);
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
      expect(result.items).toHaveLength(1);
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
