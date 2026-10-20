import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { describe, expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  environmentServeSource,
  environmentStateServeFixture,
  writeEnvironmentServeFiles,
  writeEnvironmentStateServeFiles,
} from "../../fixtures/environmentServe.js";
import { startListeningProcess } from "../../support/mcp/streamableHttpProcess.js";
import {
  processTest,
  type TestProcesses,
} from "../../support/process/processFixture.js";

const HTTP_BOUNDARY_TIMEOUT_MS = 90_000;
const CARD_PATH = "/.well-known/agent-env.json";

/** Serve the fixture pair through the built CLI and connect an SDK client to it. */
const serveFixture = async (
  processes: TestProcesses,
  environment: Readonly<Record<string, string>> = {},
) => {
  const root = await createTestTempDirectory("rea-environment-serve-mcp-");
  const files = await writeEnvironmentServeFiles(root);
  const started = await startListeningProcess(
    processes,
    [
      "environment-serve",
      files.manifestPath,
      "--evidence",
      files.capturePath,
      "--port",
      "0",
    ],
    environment,
  );
  return { ...started, root };
};

const connect = async (url: URL) => {
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: "environment-boundary", version: "1" });
  await client.connect(transport);
  return client;
};

describe("rea environment-serve", () => {
  processTest(
    "lists one tool per manifest tool and replays exact and best-effort records as untrusted target content",
    async ({ processes }) => {
      const source = environmentServeSource();
      const started = await serveFixture(processes);
      expect(started.url.hostname).toBe("127.0.0.1");
      expect(started.url.pathname).toBe("/mcp");
      const client = await connect(started.url);
      try {
        const { tools } = await client.listTools();
        expect(tools).toHaveLength(source.manifest.tools.length);
        expect(tools.map(({ name }) => name).sort()).toEqual(
          source.manifest.tools.map(({ name }) => name).sort(),
        );
        const exact = await client.callTool({
          name: "get_users_by_id",
          arguments: { id: "2" },
        });
        expect(exact.isError).toBeFalsy();
        expect(exact.structuredContent).toMatchObject({
          status: 200,
          content_type: "application/json",
          body: { login: "probe" },
          replay: {
            exact_match: true,
            evidence_id: source.evidenceId,
            recorded_path: "/api/users/2",
            truncated: false,
          },
        });
        expect(exact._meta).toMatchObject({
          provenance: { untrusted_content: true, source: "analysis_target" },
        });
        const inexact = await client.callTool({
          name: "get_users_by_id",
          arguments: { id: "999" },
        });
        expect(inexact.structuredContent).toMatchObject({
          body: { login: "probe" },
          replay: { exact_match: false },
        });
        const folder = await client.callTool({
          name: "get_folders_by_uid",
          arguments: { uid: "general" },
        });
        expect(folder.structuredContent).toMatchObject({
          replay: { recorded_path: "/api/folders/general" },
        });
      } finally {
        await client.close();
      }
    },
    HTTP_BOUNDARY_TIMEOUT_MS,
  );

  processTest(
    "serves the environment card named by ENVIRONMENT_NAME and refuses every data-plane method",
    async ({ processes }) => {
      const source = environmentServeSource();
      const started = await serveFixture(processes, {
        ENVIRONMENT_NAME: "renamed",
      });
      const origin = new URL(started.url).origin;
      const card = await fetch(new URL(CARD_PATH, origin));
      expect(card.status).toBe(200);
      const body: unknown = await card.json();
      expect(body).toMatchObject({
        name: "renamed",
        protocolVersion: "1.0",
        url: "/agentenv",
        preferredTransport: "JSONRPC",
        additionalInterfaces: [{ url: "/mcp", transport: "mcp" }],
        capabilities: { extensions: null, operations: [] },
        children_environments: null,
      });
      expect(
        (body as { capabilities: { tools: unknown[] } }).capabilities.tools,
      ).toHaveLength(source.manifest.tools.length);
      const rpc = await fetch(new URL("/agentenv", origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "data/reset" }),
      });
      await expect(rpc.json()).resolves.toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "method not found: data/reset" },
      });
      expect(started.stderr()).toContain('"transport":"streamable-http"');
    },
    HTTP_BOUNDARY_TIMEOUT_MS,
  );
});

describe("rea environment-serve --state", () => {
  processTest(
    "serves read tools from --state and loads a replacement state through the data plane",
    async ({ processes }) => {
      const root = await createTestTempDirectory("rea-environment-state-mcp-");
      const fixture = environmentStateServeFixture();
      const files = await writeEnvironmentStateServeFiles(root, fixture);
      const started = await startListeningProcess(processes, [
        "environment-serve",
        files.manifestPath,
        "--evidence",
        files.capturePath,
        "--state",
        files.statePath,
        "--port",
        "0",
      ]);
      const origin = new URL(started.url).origin;
      const card = (await (await fetch(new URL(CARD_PATH, origin))).json()) as {
        capabilities: { operations: string[]; tools: { name: string }[] };
      };
      expect(card.capabilities.operations).toEqual([
        "data/reset",
        "data/add",
        "data/get",
      ]);
      const names = card.capabilities.tools.map(({ name }) => name);
      expect(names).toContain("get_users_by_id");
      for (const write of [
        "post_annotations",
        "delete_dashboards_by_uid",
        "post_folders",
        "put_folders_by_uid",
        "delete_teams_by_id",
      ])
        expect(names).not.toContain(write);
      const rpc = async (method: string, params?: unknown) =>
        (
          await fetch(new URL("/agentenv", origin), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          })
        ).json() as Promise<{
          result?: {
            parts: [{ data: { rea_state: { entities: unknown[] } } }];
          };
          error?: { code: number };
        }>;
      await expect(rpc("data/add", { parts: [] })).resolves.toMatchObject({
        error: { code: -32602 },
      });
      const current = await rpc("data/get");
      const document = current.result?.parts[0].data;
      expect(document?.rea_state.entities.length).toBeGreaterThan(0);
      const client = await connect(started.url);
      try {
        const before = await client.callTool({
          name: "get_users_by_id",
          arguments: { id: "3" },
        });
        expect(before.structuredContent).toMatchObject({
          body: { login: "viewer" },
          state: { source: "state", view: "item", id: "3" },
        });
        await expect(
          rpc("data/add", {
            parts: [
              {
                kind: "data",
                data: { rea_state: { ...document?.rea_state, entities: [] } },
              },
            ],
          }),
        ).resolves.toMatchObject({ result: {} });
        const emptied = await client.callTool({
          name: "get_users_by_id",
          arguments: { id: "3" },
        });
        expect(emptied.isError).toBe(true);
        expect(emptied._meta).toMatchObject({
          provenance: { untrusted_content: true },
        });
        await expect(rpc("data/reset")).resolves.toMatchObject({ result: {} });
        const restored = await client.callTool({
          name: "get_users_by_id",
          arguments: { id: "3" },
        });
        expect(restored.structuredContent).toMatchObject({
          body: { login: "viewer" },
        });
      } finally {
        await client.close();
      }
    },
    HTTP_BOUNDARY_TIMEOUT_MS,
  );
});
