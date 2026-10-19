import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

cliTest.for(
  (["CLI", "stdio MCP"] as const).flatMap((surface) =>
    [false, true].map((replaced) => ({ surface, replaced })),
  ),
)(
  "retains exported app setter uncertainty (replaced=$replaced) through $surface",
  async ({ surface, replaced }, { cli }) => {
    const root = await createTestTempDirectory("rea-exported-app-path-");
    await writeFixtureFiles(root, {
      "a/package.json": '{"main":"main.mjs"}',
      "a/main.mjs": `throw new Error('Static fixture must never execute');import {app,change} from '../shared/change.mjs';import {BrowserWindow} from 'electron';change.call(app,'./lib');new BrowserWindow().loadFile('index.html');`,
      "a/index.html": "application page",
      "shared/change.mjs": `throw new Error('Static fixture must never execute');import {app} from 'electron';${replaced ? "app.setAppPath=()=>{};" : ""}const change=app.setAppPath;export {app,change};`,
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
