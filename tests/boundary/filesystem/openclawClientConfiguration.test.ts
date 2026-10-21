import JSON5 from "json5";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { npxRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { skillDestinations } from "../../../src/application/SetupSkill.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { systemUninstallHost } from "../../../src/application/Uninstall.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";

/**
 * The registration command setup writes on the host running the tests. Windows
 * wraps it in `cmd.exe /d /c`, so the expected entry follows the host too.
 */
const command = npxRegistrationCommand(process.platform);

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const openclawPath = (
  home: string,
  platform: NodeJS.Platform = "linux",
  env: Parameters<typeof supportedClients>[2] = {},
) =>
  supportedClients(home, platform, env).find(({ name }) => name === "openclaw");

describe("OpenClaw configuration paths", () => {
  it("resolves the openclaw.json file and marker directory", () => {
    expect(openclawPath("/home/a")).toEqual({
      name: "openclaw",
      displayName: "OpenClaw",
      configPath: join("/home/a", ".openclaw", "openclaw.json"),
      markerPath: join("/home/a", ".openclaw"),
      format: "openclaw",
    });
    expect(openclawPath("/Users/a", "darwin")?.configPath).toBe(
      join("/Users/a", ".openclaw", "openclaw.json"),
    );
    expect(openclawPath("C:\\Users\\a", "win32")?.configPath).toBe(
      win32.join("C:\\Users\\a", ".openclaw", "openclaw.json"),
    );
  });

  it("honors the OPENCLAW_HOME override", () => {
    expect(
      openclawPath("/home/a", "linux", { OPENCLAW_HOME: "/opt/openclaw" })
        ?.configPath,
    ).toBe(join("/opt/openclaw", ".openclaw", "openclaw.json"));
    expect(
      openclawPath("/home/a", "linux", { OPENCLAW_HOME: "" })?.configPath,
    ).toBe(join("/home/a", ".openclaw", "openclaw.json"));
  });

  it("honors independent state/config overrides and expands paths against the effective home", () => {
    const env = {
      OPENCLAW_HOME: " /opt/openclaw ",
      OPENCLAW_STATE_DIR: "~/state",
      OPENCLAW_CONFIG_PATH: "~/profiles/work.json5",
    };
    expect(openclawPath("/home/a", "linux", env)).toMatchObject({
      configPath: "/opt/openclaw/profiles/work.json5",
      markerPath: "/opt/openclaw/state",
    });
    expect(
      skillDestinations("/home/a", ["openclaw"], env).map(({ path }) => path),
    ).toEqual(["/opt/openclaw/state/skills/reverse-engineer-anything"]);
    expect(
      openclawPath("/home/a", "linux", { OPENCLAW_STATE_DIR: "relative-state" })
        ?.configPath,
    ).toBe(join(process.cwd(), "relative-state", "openclaw.json"));
  });

  it("follows a config-only profile for skills, while state overrides take precedence", () => {
    expect(
      skillDestinations("/home/a", ["openclaw"], {
        OPENCLAW_CONFIG_PATH: "/profile/work.json5",
      }).map(({ path }) => path),
    ).toEqual(["/profile/skills/reverse-engineer-anything"]);
  });

  it("resolves the personal skills directory beside the config root", () => {
    expect(
      skillDestinations("/home/a", ["openclaw"]).map(({ path }) => path),
    ).toEqual([
      join("/home/a", ".openclaw", "skills", "reverse-engineer-anything"),
    ]);
    expect(
      skillDestinations("/home/a", ["openclaw"], {
        OPENCLAW_HOME: "/opt/openclaw",
      }).map(({ path }) => path),
    ).toEqual([
      join("/opt/openclaw", ".openclaw", "skills", "reverse-engineer-anything"),
    ]);
  });
});

describe("OpenClaw native JSON5 registration", () => {
  it("isolates inherited OPENCLAW_HOME before registration and uninstall", async () => {
    const external = await createTestTempDirectory("rea-openclaw-external-");
    const path = join(external, "openclaw.json");
    const original = JSON.stringify({
      mcp: { servers: { rea: { command: "user-owned" } } },
    });
    await writeFile(path, original);
    vi.stubEnv("OPENCLAW_HOME", external);
    vi.stubEnv("OPENCLAW_STATE_DIR", external);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path);
    clearClientLocationEnvironment();
    const home = await createTestTempDirectory("rea-openclaw-isolated-");
    const client = supportedClients(home, process.platform).find(
      ({ name }) => name === "openclaw",
    );
    if (client?.markerPath === undefined)
      throw new Error("missing OpenClaw client");
    expect(client.configPath).toBe(join(home, ".openclaw", "openclaw.json"));
    await mkdir(client.markerPath, { recursive: true });
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    expect(await readFile(path, "utf8")).toBe(original);
  });

  const openclawClient = async () => {
    const home = await createTestTempDirectory("rea-openclaw-");
    const client = openclawPath(home, process.platform);
    if (client?.markerPath === undefined)
      throw new Error("missing OpenClaw client");
    await mkdir(client.markerPath, { recursive: true });
    return { home, client };
  };

  it("upserts rea into mcp.servers while preserving unrelated settings", async () => {
    const { home, client } = await openclawClient();
    await writeFile(
      client.configPath,
      `{
  // Keep this JSON5 comment and spelling.
  mcp: {servers: {
    other: { command: 'other-server' },
  }},
  "agents": { "defaults": { "model": "openclaw-default" } }
}`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON5.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcp.servers.other).toEqual({ command: "other-server" });
    expect(parsed.agents.defaults.model).toBe("openclaw-default");
    expect(await readFile(client.configPath, "utf8")).toContain(
      "// Keep this JSON5 comment and spelling.",
    );
    expect(await readFile(client.configPath, "utf8")).toContain(
      "other: { command: 'other-server' }",
    );
    expect(parsed.mcp.servers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
      transport: "stdio",
      enabled: true,
    });

    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          platform: process.platform,
          environment: {},
        })
      ).find(({ client }) => client === "openclaw"),
    ).toMatchObject({ state: "aligned", command });
  });

  it("creates the native mcp.servers table in an existing settings file without servers", async () => {
    const { client } = await openclawClient();
    await writeFile(
      client.configPath,
      JSON.stringify({ agents: { defaults: { verbose: true } } }, null, 2),
    );
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON5.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.agents.defaults.verbose).toBe(true);
    expect(parsed.mcp.servers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
      transport: "stdio",
      enabled: true,
    });
  });

  it("registers into an empty settings file", async () => {
    const { client } = await openclawClient();
    await writeFile(client.configPath, "");
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON5.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcp.servers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
      transport: "stdio",
      enabled: true,
    });
  });

  it("removes only the rea entry on uninstall", async () => {
    const { home, client } = await openclawClient();
    await writeFile(
      client.configPath,
      JSON.stringify(
        { mcp: { servers: { other: { command: "other-server" } } } },
        null,
        2,
      ),
    );
    await configureClientConfiguration(client, {}, command);

    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    const parsed = JSON5.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcp.servers.other).toEqual({ command: "other-server" });
    expect(parsed.mcp.servers.rea).toBeUndefined();
  });
});

it.each([
  `{mcp: {servers: {rea: {command: 'foreign'}, rea: {command: 'rea'}}}}`,
  `{mcp: {}, mcp: {servers: {}}}`,
  `{$include: 'other.json5', mcp: {servers: {}}}`,
  `{mcp: {servers: null}}`,
  `{mcp: {servers: {rea: (() => 'not-data')()}}}`,
])(
  "preserves malformed or unresolved OpenClaw ownership without writing: %s",
  async (source) => {
    const home = await createTestTempDirectory("rea-openclaw-invalid-");
    const client = openclawPath(home, process.platform)!;
    await mkdir(join(home, ".openclaw"), { recursive: true });
    await writeFile(client.configPath, source);
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("failed");
    expect(await readFile(client.configPath, "utf8")).toBe(source);
    expect(
      (await systemUninstallHost(home).removeClient(client)).status,
    ).not.toBe("removed");
    expect(await readFile(client.configPath, "utf8")).toBe(source);
  },
);

it.each(["OPENCLAW_CONFIG_READONLY", "OPENCLAW_NIX_MODE"])(
  "does not mutate a native read-only profile: %s",
  async (name) => {
    const home = await createTestTempDirectory("rea-openclaw-readonly-");
    const client = openclawPath(home, process.platform, { [name]: "1" })!;
    expect(client.configPathError).toContain("read-only");
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("failed");
  },
);

it("does not read a Claude-style table as a native OpenClaw registration", async () => {
  const home = await createTestTempDirectory("rea-openclaw-legacy-");
  const client = openclawPath(home, process.platform)!;
  await mkdir(join(home, ".openclaw"), { recursive: true });
  const source = JSON.stringify({
    mcpServers: { rea: { command: command[0], args: command.slice(1) } },
  });
  await writeFile(client.configPath, source);
  const statuses = await readClientRegistrationStatuses(home, undefined, {
    platform: process.platform,
    environment: {},
  });
  expect(statuses.find(({ client }) => client === "openclaw")?.state).toBe(
    "missing",
  );
  expect(await readFile(client.configPath, "utf8")).toBe(source);
});

it.each([
  `rea: REA, /* comma, in comment */ other: {command: 'other'}`,
  `other: {command: 'other'}, // keep this comment
 rea: REA`,
  `before: {command: 'before'}, rea: REA, after: {command: 'after'},`,
  `rea: REA, // keep this comment
`,
])(
  "removes only the native owned property and delimiter in JSON5: %s",
  async (members) => {
    const home = await createTestTempDirectory("rea-openclaw-members-");
    const client = openclawPath(home, process.platform)!;
    await mkdir(join(home, ".openclaw"), { recursive: true });
    const source = `{mcp: {servers: {${members.replace("REA", JSON.stringify({ command: command[0], args: command.slice(1) }))}}}}`;
    await writeFile(client.configPath, source);
    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    const after = await readFile(client.configPath, "utf8");
    const parsed = JSON5.parse(after);
    expect(parsed.mcp.servers.rea).toBeUndefined();
    expect(parsed.mcp.servers).toEqual(
      Object.fromEntries(
        Object.entries(JSON5.parse(source).mcp.servers).filter(
          ([key]) => key !== "rea",
        ),
      ),
    );
    if (source.includes("keep this comment"))
      expect(after).toContain("keep this comment");
  },
);
