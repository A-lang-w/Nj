import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "Antigravity surfaces share registration without sharing skill ownership",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-antigravity-surfaces-");
    const config = join(home, ".gemini", "config", "mcp_config.json");
    const ideSkill = join(
      home,
      ".gemini",
      "config",
      "skills",
      "reverse-engineer-anything",
    );
    const cliRoot = join(home, ".gemini", "antigravity-cli");
    const cliSkill = join(cliRoot, "skills", "reverse-engineer-anything");
    const run = (arguments_: readonly string[]) =>
      cli.run({
        arguments: arguments_,
        cwd: home,
        environment: {
          HOME: home,
          USERPROFILE: home,
          ...(process.env.REA_DARWIN_SWIFTC_PATH === undefined
            ? {}
            : { REA_DARWIN_SWIFTC_PATH: process.env.REA_DARWIN_SWIFTC_PATH }),
          ...(process.env.SDKROOT === undefined
            ? {}
            : { SDKROOT: process.env.SDKROOT }),
        },
        timeoutMs: 60_000,
      });
    await mkdir(join(home, ".gemini", "config"), { recursive: true });
    const unrelated = {
      mcpServers: { notes: { command: "notes-server" } },
      telemetry: false,
    };
    await writeFile(config, JSON.stringify(unrelated));

    // A shared MCP file proves an IDE surface, not a CLI installation.
    const detected = await run([
      "setup",
      "--all-detected",
      "--dry-run",
      "--json",
    ]);
    expect(detected.exitCode, detected.stdout + detected.stderr).toBe(0);
    expect(detected.json).toMatchObject({
      plannedActions: expect.not.arrayContaining([
        expect.objectContaining({ id: "configure_client:antigravity_cli" }),
        expect.objectContaining({ id: "install_skill:antigravity_cli" }),
      ]),
    });
    await expect(access(cliRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual(unrelated);

    for (const [client, skill] of [
      ["antigravity_cli", cliSkill],
      ["antigravity", ideSkill],
    ] as const) {
      const setup = await run(["setup", "--client", client, "--yes", "--json"]);
      expect(setup.exitCode, setup.stderr).toBe(0);
      expect(setup.json).toMatchObject({ status: "ready" });
      expect(await readFile(join(skill, "SKILL.md"), "utf8")).toContain(
        "reverse-engineer-anything",
      );
      await writeFile(join(skill, "user-notes.txt"), client);
      const doctor = await run([
        "doctor",
        "--client",
        client,
        "--skill",
        "--json",
      ]);
      expect(doctor.exitCode, doctor.stderr).toBe(0);
      expect(doctor.json).toMatchObject({
        identity: {
          registrations: expect.arrayContaining([
            expect.objectContaining({
              client,
              config_path: config,
              state: "aligned",
            }),
          ]),
        },
      });
    }
    const configured = await readFile(config, "utf8");
    const repeated = await run([
      "setup",
      "--client",
      "antigravity",
      "--client",
      "antigravity_cli",
      "--yes",
      "--json",
    ]);
    expect(repeated.exitCode, repeated.stderr).toBe(0);
    expect(repeated.json).toMatchObject({
      status: "ready",
      appliedActions: [],
    });
    expect(await readFile(config, "utf8")).toBe(configured);

    const removed = await run(["uninstall", "--json"]);
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(removed.json).toMatchObject({ status: "complete" });
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual(unrelated);
    for (const [client, skill] of [
      ["antigravity_cli", cliSkill],
      ["antigravity", ideSkill],
    ] as const) {
      await expect(access(join(skill, "SKILL.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(join(skill, "user-notes.txt"), "utf8")).toBe(
        client,
      );
      const doctor = await run([
        "doctor",
        "--client",
        client,
        "--skill",
        "--json",
      ]);
      expect(doctor.exitCode, doctor.stderr).toBe(1);
      expect(doctor.json).toMatchObject({
        identity: {
          registrations: expect.arrayContaining([
            expect.objectContaining({ client, state: "missing" }),
          ]),
        },
      });
    }
  },
  120_000,
);
