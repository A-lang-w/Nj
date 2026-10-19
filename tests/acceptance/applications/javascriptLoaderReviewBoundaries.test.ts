import { createPackageWithOptions } from "@electron/asar";
import { join } from "node:path";
import { expect } from "vitest";

import type { JavaScriptApplicationGraph } from "../../../src/domain/javascript/javascriptApplicationGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const windowSource =
  'const { BrowserWindow } = require("electron"); new BrowserWindow().loadFile("index.html");';

const expectRendererTarget = (
  graph: JavaScriptApplicationGraph,
  target: string | null,
): void => {
  const roles = graph.nodes.filter(({ kind }) => kind === "electron-renderer");
  expect(roles).toHaveLength(1);
  const role = roles[0];
  expect(role?.observations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        properties: expect.objectContaining({
          resolution_status: target === null ? "unavailable" : "resolved",
          resolved_path: target,
        }),
      }),
    ]),
  );
  expect(
    graph.edges
      .filter(
        ({ relation, source_node_id }) =>
          relation === "maps_to" && source_node_id === role?.node_id,
      )
      .map(({ properties }) => properties.resolved_path),
  ).toEqual(target === null ? [] : [target]);
};

const loaderCases = [
  {
    name: "returned module",
    source: 'const get=()=>module;get().require("../shared/window.cjs");',
    unknownOwner: true,
    unknownLoad: true,
  },
  {
    name: "returned local",
    source:
      'const get=()=>({require(){}});get().require("../shared/window.cjs");',
    unknownOwner: false,
    unknownLoad: false,
  },
  {
    name: "inactive callable default",
    source:
      'function host(){return module;}const {make=host}={make(){return {};}};make().require=()=>{};require("./local.cjs");',
    unknownOwner: false,
    unknownLoad: false,
  },
  {
    name: "active callable default",
    source:
      'function host(){return module;}const {make=host}={};make().require=()=>{};require("./local.cjs");',
    unknownOwner: true,
    unknownLoad: true,
  },
  {
    name: "inactive array callable default",
    source:
      'function host(){return module;}const [make=host]=[()=>({})];make().require=()=>{};require("./local.cjs");',
    unknownOwner: false,
    unknownLoad: false,
  },
  {
    name: "iterator callable default",
    source:
      'function host(){return module;}const values=[()=>({})];values[Symbol.iterator]=function*(){yield undefined;};const [make=host]=values;make().require=()=>{};require("./local.cjs");',
    unknownOwner: true,
    unknownLoad: true,
  },
  {
    name: "generator local result",
    source:
      'function* get(){yield module;}const api=get();api.require=()=>{};api.require("../shared/window.cjs");',
    unknownOwner: false,
    unknownLoad: false,
  },
  {
    name: "async local result",
    source:
      'async function get(){return module;}const api=get();api.require=()=>{};api.require("../shared/window.cjs");',
    unknownOwner: false,
    unknownLoad: false,
  },
  {
    name: "awaited module result",
    source:
      '(async()=>{const get=async()=>module;(await get()).require("../shared/window.cjs");})();',
    unknownOwner: true,
    unknownLoad: true,
  },
  {
    name: "awaited pending alias",
    source:
      '(async()=>{const get=async()=>module;const pending=get();const api=await pending;api.require("../shared/window.cjs");})();',
    unknownOwner: true,
    unknownLoad: true,
  },
  {
    name: "awaited generator local",
    source:
      '(async()=>{function* get(){yield module;}const api=await get();api.require=()=>{};api.require("../shared/window.cjs");})();',
    unknownOwner: false,
    unknownLoad: false,
  },
  {
    name: "awaited async local",
    source:
      '(async()=>{const get=async()=>({require(){}});const api=await get();api.require("../shared/window.cjs");})();',
    unknownOwner: false,
    unknownLoad: false,
  },
  {
    name: "prototype extra host write",
    source:
      'const [api]=[module];Array.prototype.extra=1;api.require=replacement;require("../shared/window.cjs");',
    unknownOwner: true,
    unknownLoad: true,
  },
  {
    name: "prototype extra local write",
    source:
      'const [api]=[{}];Array.prototype.extra=1;api.require=()=>{};api.require("../shared/window.cjs");',
    unknownOwner: false,
    unknownLoad: false,
  },
  {
    name: "custom iterator host write",
    source:
      'const values={*[Symbol.iterator](){yield module;}};const [api]=values;api.require=replacement;require("../shared/window.cjs");',
    unknownOwner: true,
    unknownLoad: true,
  },
  {
    name: "constructor cycle iterator",
    source:
      'Array.prototype.constructor.prototype[Symbol.iterator]=function*(){yield module;};const [api]=[];api.require("../shared/window.cjs");',
    unknownOwner: true,
    unknownLoad: true,
  },
  {
    name: "inherited array hole",
    source:
      'Array.prototype[0]=module;const [api]=[,];api.require("../shared/window.cjs");',
    unknownOwner: true,
    unknownLoad: true,
  },
  {
    name: "Object prototype array hole",
    source:
      'Object.prototype[0]=module;const [api]=[,];api.require("../shared/window.cjs");',
    unknownOwner: true,
    unknownLoad: true,
  },
  {
    name: "Object prototype extra local",
    source:
      'Object.prototype.extra=module;const [api]=[{require(){}}];api.require("../shared/window.cjs");',
    unknownOwner: false,
    unknownLoad: false,
  },
  {
    name: "replaced host method",
    source:
      'const box={make(){return {};}};box.make=()=>module;box.make().require("../shared/window.cjs");',
    unknownOwner: true,
    unknownLoad: true,
  },
  {
    name: "replaced local method",
    source:
      'const box={make(){return module;}};box.make=()=>({require(){}});box.make().require("../shared/window.cjs");',
    unknownOwner: false,
    unknownLoad: false,
  },
  {
    name: "Windows relative require",
    source: `require(${JSON.stringify("..\\shared\\window.cjs")});`,
    unknownOwner: true,
    unknownLoad: false,
  },
  {
    name: "invalid builtin backslash",
    source: `require(${JSON.stringify("node:\\fs")});`,
    unknownOwner: false,
    unknownLoad: false,
  },
  {
    name: "unrelated import pattern",
    source: 'require("#foo");',
    imports: { "#bar/*": "./proxy/*.cjs" },
    unknownOwner: false,
    unknownLoad: false,
  },
  {
    name: "matching import pattern",
    source: 'require("#foo/window");',
    imports: { "#foo/*": "./proxy/*.cjs" },
    unknownOwner: true,
    unknownLoad: false,
  },
  {
    name: "nonmatching import suffix",
    source: 'require("#foo/window.js");',
    imports: { "#foo/*.cjs": "./proxy/*.cjs" },
    unknownOwner: false,
    unknownLoad: false,
  },
] as const;

cliTest.for(
  (["CLI", "stdio MCP"] as const).flatMap((surface) =>
    loaderCases.map((testCase) => ({ surface, ...testCase })),
  ),
)(
  "preserves loader boundaries: $name through $surface",
  async (testCase, { cli }) => {
    const root = await createTestTempDirectory("rea-loader-review-");
    await writeFixtureFiles(root, {
      "a/package.json": JSON.stringify({ main: "main.cjs" }),
      "a/main.cjs": 'require("../shared/window.cjs");',
      "a/index.html": "first application page",
      "b/package.json": JSON.stringify({
        main: "main.cjs",
        ...("imports" in testCase ? { imports: testCase.imports } : {}),
      }),
      "b/main.cjs": testCase.source,
      "b/local.cjs": "module.exports = {};",
      "b/proxy/window.cjs": 'require("../../shared/window.cjs");',
      "b/index.html": "second application page",
      "shared/window.cjs": windowSource,
      "shared/index.html": "source-directory decoy",
      "index.html": "artifact-root decoy",
    });
    const { graph } = await analyzeJavaScriptDirectory(
      testCase.surface,
      cli,
      root,
    );
    expectRendererTarget(graph, testCase.unknownOwner ? null : "a/index.html");
    const unknownLoads = graph.edges.filter(
      ({ relation, properties }) =>
        relation === "imports" && properties.specifier === null,
    );
    expect(unknownLoads.length > 0).toBe(testCase.unknownLoad);
    if (testCase.name === "Windows relative require")
      expect(graph.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            relation: "imports",
            properties: expect.objectContaining({
              specifier: "..\\shared\\window.cjs",
              resolution_status: "unavailable",
              resolved_path: null,
            }),
          }),
        ]),
      );
  },
);

cliTest.for(
  (["CLI", "stdio MCP"] as const).flatMap((surface) =>
    (["app.asar", "APP.ASAR", "app.AsAr"] as const).flatMap((archive) =>
      (["inward", "outward"] as const).map((direction) => ({
        surface,
        archive,
        direction,
      })),
    ),
  ),
)(
  "preserves $direction ASAR ownership for $archive through $surface",
  async ({ surface, archive, direction }, { cli }) => {
    const root = await createTestTempDirectory("rea-asar-case-");
    const source = join(root, "source");
    const application = join(root, "application");
    const inward = direction === "inward";
    await writeFixtureFiles(
      source,
      inward
        ? { "window.cjs": windowSource, "index.html": "archive-root decoy" }
        : {
            "package.json": JSON.stringify({ main: "main.cjs" }),
            "main.cjs": 'require("../window.cjs");',
            "index.html": "archive application page",
          },
    );
    await writeFixtureFiles(
      application,
      inward
        ? {
            "a/package.json": JSON.stringify({ main: "main.cjs" }),
            "a/main.cjs": `require(${JSON.stringify(`../resources/${archive}/window.cjs`)});`,
            "a/index.html": "outer application page",
          }
        : { "resources/window.cjs": windowSource },
    );
    await createPackageWithOptions(
      source,
      join(application, `resources/${archive}`),
      {},
    );
    const { graph } = await analyzeJavaScriptDirectory(
      surface,
      cli,
      application,
    );
    expectRendererTarget(
      graph,
      inward ? "a/index.html" : `resources/${archive}/index.html`,
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: "imports",
          properties: expect.objectContaining({
            specifier: inward
              ? `../resources/${archive}/window.cjs`
              : "../window.cjs",
            resolution_status: "resolved",
            resolved_path: inward
              ? `resources/${archive}/window.cjs`
              : "resources/window.cjs",
          }),
        }),
      ]),
    );
  },
);
