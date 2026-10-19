import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

cliTest.for(
  (["CLI", "stdio MCP"] as const).flatMap((surface) =>
    [
      {
        name: "local helper",
        declaration: "const helper={resolve(value){return value}};",
        expression: 'helper.resolve(runtimePath,__dirname,"decoy.cjs")',
        preload: null,
      },
      {
        name: "Node path resolver",
        declaration: 'const path=require("node:path");',
        expression: 'path.resolve(runtimePath,__dirname,"decoy.cjs")',
        preload: "decoy.cjs",
      },
    ].map((testCase) => ({ surface, ...testCase })),
  ),
)(
  "requires the $name owner for preload resolve semantics through $surface",
  async ({ surface, declaration, expression, preload }, { cli }) => {
    const root = await createTestTempDirectory("rea-preload-resolve-owner-");
    await writeFixtureFiles(root, {
      "package.json": '{"main":"main.cjs"}',
      "main.cjs": `throw new Error('Static fixture must never execute');const {BrowserWindow}=require('electron');${declaration}new BrowserWindow({webPreferences:{preload:${expression}}});`,
      "decoy.cjs": "throw new Error('Static preload must never execute');",
    });
    const { graph, statistics } = await analyzeJavaScriptDirectory(
      surface,
      cli,
      root,
    );
    expect(statistics.parse_failures).toBe(0);
    const windows = graph.nodes.filter(({ kind }) => kind === "browser-window");
    expect(windows).toHaveLength(1);
    expect(windows[0]?.observations[0]?.properties.preload_path).toBe(preload);
    const associations = graph.edges.filter(
      ({ source_node_id, evidence }) =>
        source_node_id === windows[0]?.node_id &&
        evidence.extractor.operation === "associate-browser-window-preload",
    );
    if (preload === null) expect(associations).toEqual([]);
    else
      expect(associations).toEqual([
        expect.objectContaining({
          relation: "loads",
          properties: expect.objectContaining({
            resolved_path: preload,
            resolution_status: "resolved",
          }),
        }),
      ]);
  },
);
