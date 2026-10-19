import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const cases = [
  {
    name: "inherited delegate excluded from rest",
    load: 'const {...h}=module;h.require.call(module,"../shared/window.cjs");',
    possible: false,
  },
  {
    name: "own delegate retained in spread",
    load: 'module.require=module.require;const h={...module};h.require.call(module,"../shared/window.cjs");',
    possible: true,
  },
  {
    name: "nested module retained in spread",
    load: 'const h={...{loader:module}};h.loader.require("../shared/window.cjs");',
    possible: true,
  },
  {
    name: "require-named delegate",
    load: 'const h={require:module.require};h.require.call(module,"../shared/window.cjs");',
    possible: true,
  },
  {
    name: "require-named local",
    load: 'const h={require(){}};h.require.call(module,"../shared/window.cjs");',
    possible: false,
  },
  {
    name: "require-named applied delegate",
    load: 'const h={require:module.require};h.require.apply(module,["../shared/window.cjs"]);',
    possible: true,
  },
  {
    name: "require-named applied local",
    load: 'const h={require(){}};h.require.apply(module,["../shared/window.cjs"]);',
    possible: false,
  },
  {
    name: "module receiver",
    load: '(0,module).require("../shared/window.cjs");',
    possible: true,
  },
  {
    name: "captured delegate",
    load: 'const load=(0,module.require);load("../shared/window.cjs");',
    possible: true,
  },
  {
    name: "local receiver",
    load: '(module,{require(){}}).require("../shared/window.cjs");',
    possible: false,
  },
  {
    name: "local final delegate",
    load: 'const load=(module.require,()=>{});load("../shared/window.cjs");',
    possible: false,
  },
] as const;

cliTest.for(
  (["CLI", "stdio MCP"] as const).flatMap((surface) =>
    cases.map((test) => ({ ...test, surface })),
  ),
)(
  "preserves $name loader owner uncertainty through $surface",
  async ({ surface, load, possible }, { cli }) => {
    const root = await createTestTempDirectory("rea-sequence-loader-");
    await writeFixtureFiles(root, {
      "a/package.json": '{"main":"main.cjs"}',
      "a/main.cjs": `throw new Error('Static fixture must never execute');${load}`,
      "a/index.html": "possible page",
      "b/package.json": '{"main":"main.cjs"}',
      "b/main.cjs": `throw new Error('Static fixture must never execute');require('../shared/window.cjs');`,
      "b/index.html": "proven page",
      "shared/window.cjs": `throw new Error('Static fixture must never execute');const {BrowserWindow}=require('electron');new BrowserWindow().loadFile('index.html');`,
      "shared/index.html": "source-relative decoy",
      "index.html": "artifact-root decoy",
    });
    const { graph, statistics } = await analyzeJavaScriptDirectory(
      surface,
      cli,
      root,
    );
    expect(statistics.parse_failures).toBe(0);
    const roles = graph.nodes.filter(
      ({ kind }) => kind === "electron-renderer",
    );
    expect(roles).toHaveLength(1);
    expect(roles[0]?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            resolution_status: possible ? "unavailable" : "resolved",
          }),
        }),
      ]),
    );
    const mapped = graph.edges.filter(
      ({ relation, source_node_id }) =>
        relation === "maps_to" && source_node_id === roles[0]?.node_id,
    );
    expect(mapped).toHaveLength(possible ? 0 : 1);
    if (!possible)
      expect(mapped[0]?.properties.resolved_path).toBe("b/index.html");
  },
);
