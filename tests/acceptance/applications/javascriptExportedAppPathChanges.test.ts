import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

cliTest.for(
  (["CLI", "stdio MCP"] as const).flatMap((surface) =>
    (["ESM", "CommonJS"] as const).flatMap((format) =>
      [false, true].map((replaced) => ({ surface, format, replaced })),
    ),
  ),
)(
  "retains $format exported app setter uncertainty (replaced=$replaced) through $surface",
  async ({ surface, format, replaced }, { cli }) => {
    const root = await createTestTempDirectory("rea-exported-app-path-");
    const files: Record<string, string> =
      format === "CommonJS"
        ? {
            "a/package.json": '{"main":"main.cjs"}',
            "a/setter.cjs": `throw new Error('Static fixture must never execute');const {app}=require('electron');${replaced ? "app.setAppPath=()=>{};" : ""}const change=app.setAppPath;module.exports={change,app};`,
            "a/main.cjs": `throw new Error('Static fixture must never execute');const {change,app}=require('./setter.cjs');const path=require('node:path');change.call(app,path.join(__dirname,'lib'));require('./win.cjs');`,
            "a/win.cjs": `throw new Error('Static fixture must never execute');const {BrowserWindow}=require('electron');new BrowserWindow().loadFile('index.html');`,
          }
        : {
            "a/package.json": '{"main":"main.mjs"}',
            "a/main.mjs": `throw new Error('Static fixture must never execute');import {app,change} from '../shared/change.mjs';import {BrowserWindow} from 'electron';change.call(app,'./lib');new BrowserWindow().loadFile('index.html');`,
            "shared/change.mjs": `throw new Error('Static fixture must never execute');import {app} from 'electron';${replaced ? "app.setAppPath=()=>{};" : ""}const change=app.setAppPath;export {app,change};`,
          };
    await writeFixtureFiles(root, {
      ...files,
      "a/index.html": "application page",
      "a/lib/index.html": "changed application page",
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
            resolution_status: replaced ? "resolved" : "unavailable",
          }),
        }),
      ]),
    );
    const mapped = graph.edges.filter(
      ({ relation, source_node_id }) =>
        relation === "maps_to" && source_node_id === roles[0]?.node_id,
    );
    expect(mapped).toHaveLength(replaced ? 1 : 0);
    if (replaced)
      expect(mapped[0]?.properties.resolved_path).toBe("a/index.html");
  },
);
