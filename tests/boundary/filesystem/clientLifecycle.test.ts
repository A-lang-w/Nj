import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { ClientConfigurationPublication } from "../../../src/application/ClientConfigurationPublication.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { readConfigurationFile } from "../../../src/application/ClientConfigurationFiles.js";
import {
  detectClients,
  systemSetupHost,
} from "../../../src/application/SetupHost.js";
import {
  runUninstall,
  systemUninstallHost,
  type UninstallFileSystem,
} from "../../../src/application/Uninstall.js";

const roots: string[] = [];
const ownedSkillManifest = `---\nname: ${PRODUCT_IDENTITY.skillName}\n---\n# REA\n`;
beforeEach(clearClientLocationEnvironment);
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("client configuration filesystem lifecycle", () => {
  it("detects every supported client and skips absent clients", async () => {
    const home = await createTestTempDirectory("rea-detect-");
    roots.push(home);
    for (const client of supportedClients(home)) {
      if (client.markerPath === undefined) continue;
      if (client.name === "puku_cli") {
        await mkdir(join(home, ".puku-cli"), { recursive: true });
        await writeFile(join(home, ".puku-cli", "settings.json"), "{}\n");
        continue;
      }
      await mkdir(client.markerPath, { recursive: true });
    }
    const detected = await detectClients(home);
    expect(detected.map(({ name }) => name)).toEqual([
      "claude_code",
      "claude_desktop",
      "codex",
      "cursor",
      "gemini_cli",
      "windsurf",
      "devin",
      "opencode",
      "antigravity",
      "copilot_cli",
      "commandcode",
      "qwen_code",
      "kimi",
      "vscode",
      "trae",
      "workbuddy",
      "grok_build",
      "omp",
      "pi",
      "hermes",
      "qoder",
      "droid",
      "zcode",
      "puku_cli",
      "dsh",
      "grok_bot",
    ]);
    expect(
      detected.find(({ name }) => name === "claude_code")?.configPath,
    ).toBe(join(home, ".claude.json"));
    expect(detected.find(({ name }) => name === "devin")?.format).toBe("json");
    expect(detected.find(({ name }) => name === "puku_cli")).toMatchObject({
      displayName: "Puku CLI",
      configPath: join(home, ".puku-cli/.mcp.json"),
      markerPath: join(home, ".puku-cli"),
      format: "json",
    });
    expect(
      supportedClients(home).find(({ name }) => name === "puku_cli"),
    ).toMatchObject({
      configPath: join(home, ".puku-cli/.mcp.json"),
    });
    const emptyHome = await createTestTempDirectory("rea-empty-");
    roots.push(emptyHome);
    expect(await detectClients(emptyHome)).toEqual([]);
  });

  it("preserves unrelated Codex TOML and supports an installed command", async () => {
    const home = await createTestTempDirectory("rea-toml-");
    roots.push(home);
    const configPath = join(home, ".codex/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      'model = "gpt-5"\n[mcp_servers.other]\ncommand = "other"\n',
    );
    expect(
      await configureClientConfiguration(
        { name: "codex", configPath, format: "toml" },
        {
          HOPPER_LAUNCHER_PATH: "/Hopper Path",
          GHIDRA_INSTALL_DIR: "/opt/ghidra",
          JAVA_HOME: "/opt/jdk-21",
        },
        ["rea", "mcp"],
      ),
    ).toMatchObject({ status: "configured" });
    const configured = await readFile(configPath, "utf8");
    expect(configured).toContain('model = "gpt-5"');
    expect(configured).toContain("[mcp_servers.rea]");
    expect(configured).toContain('command = "rea"');
    expect(configured).toContain("startup_timeout_sec = 30");
    expect(configured).toContain("tool_timeout_sec = 450");
    expect(configured).toContain('GHIDRA_INSTALL_DIR = "/opt/ghidra"');
    expect(configured).toContain('JAVA_HOME = "/opt/jdk-21"');
    expect(
      await configureClientConfiguration(
        { name: "codex", configPath, format: "toml" },
        {
          HOPPER_LAUNCHER_PATH: "/Hopper Path",
          GHIDRA_INSTALL_DIR: "/opt/ghidra",
          JAVA_HOME: "/opt/jdk-21",
        },
        ["rea", "mcp"],
      ),
    ).toEqual({ status: "unchanged" });
  });

  it("does not rewrite an equivalent Codex registration with reordered environment keys", async () => {
    const home = await createTestTempDirectory("rea-toml-");
    roots.push(home);
    const configPath = join(home, ".codex/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `[mcp_servers.rea]\ncommand = "rea"\nargs = ["mcp"]\nstartup_timeout_sec = 30\ntool_timeout_sec = 450\n\n[mcp_servers.rea.env]\nJAVA_HOME = "/opt/jdk-21"\nHOPPER_LAUNCHER_PATH = "/Hopper Path"\nGHIDRA_INSTALL_DIR = "/opt/ghidra"\n`,
    );

    const original = await readFile(configPath, "utf8");
    expect(
      await configureClientConfiguration(
        { name: "codex", configPath, format: "toml" },
        {
          HOPPER_LAUNCHER_PATH: "/Hopper Path",
          GHIDRA_INSTALL_DIR: "/opt/ghidra",
          JAVA_HOME: "/opt/jdk-21",
        },
        ["rea", "mcp"],
      ),
    ).toEqual({ status: "unchanged" });
    expect(await readFile(configPath, "utf8")).toBe(original);
    await expect(
      readFile(`${configPath}.rea.backup`, "utf8"),
    ).rejects.toThrow();
  });
});

describe("Puku CLI filesystem detection", () => {
  it("detects Puku CLI only when its home contains a supported marker file", async () => {
    const home = await createTestTempDirectory("rea-puku-cli-");
    roots.push(home);
    const pukuHome = join(home, ".puku-cli");
    await mkdir(pukuHome, { recursive: true });

    // An empty directory is not sufficient evidence that Puku CLI is installed.
    expect(await detectClients(home)).toEqual([]);

    await writeFile(join(pukuHome, "settings.json"), "{}\n");
    expect(await detectClients(home)).toContainEqual(
      expect.objectContaining({
        name: "puku_cli",
        configPath: join(pukuHome, ".mcp.json"),
      }),
    );

    await rm(join(pukuHome, "settings.json"));
    expect(await detectClients(home)).toEqual([]);

    await writeFile(join(pukuHome, "puku-cli.json"), "{}\n");
    expect(await detectClients(home)).toContainEqual(
      expect.objectContaining({
        name: "puku_cli",
        configPath: join(pukuHome, ".mcp.json"),
      }),
    );

    await rm(join(pukuHome, "puku-cli.json"));
    expect(await detectClients(home)).toEqual([]);
  });
});
