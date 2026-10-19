import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

for (const version of ["1.1", "1.2"] as const) {
  for (const style of ["entry", "child", "shadowed"] as const) {
    cliTest(
      `Hermes ${version} preserves ${style} anchor consumers through setup and uninstall`,
      async ({ cli }) => {
        const home = await createTestTempDirectory(
          "rea-hermes-anchored-entry-",
        );
        const profile = join(home, "hermes");
        const config = join(profile, "config.yaml");
        const server = {
          command: process.execPath,
          args: [resolve("scripts/rea.mjs"), "mcp"],
          env: { KEEP: "off" },
          enabled: false,
        };
        const directive = version === "1.2" ? "%YAML 1.2\n---\n" : "";
        const entry =
          `    command: ${JSON.stringify(server.command)}\n` +
          `    args: ${JSON.stringify(server.args)}\n` +
          "    enabled: false\n" +
          (style === "shadowed"
            ? "    env: *settings # Keep nested reference comment\n"
            : `    env: ${style === "child" ? "&settings " : ""}{KEEP: 'off'}\n`);
        const original =
          directive +
          "# Keep this user setting\nmodel: custom\n" +
          (style === "shadowed" ? "defaults: &settings {KEEP: 'off'}\n" : "") +
          `mcp_servers:\n  rea:${style === "child" ? "" : " &server"}\n` +
          entry +
          (style === "child"
            ? "  other:\n    command: other-server\n    env: *settings # Shared environment\n"
            : "  other: *server # Independent server\n") +
          (style === "shadowed"
            ? "later: &settings {KEEP: later}\nobserver: *server\n"
            : "");
        const other =
          style === "child"
            ? { command: "other-server", env: { KEEP: "off" } }
            : server;
        await mkdir(profile);
        await writeFile(config, original);
        const run = (arguments_: readonly string[]) =>
          cli.run({
            arguments: arguments_,
            cwd: home,
            environment: {
              HOME: home,
              USERPROFILE: home,
              HERMES_HOME: profile,
            },
            timeoutMs: 20_000,
          });
        const setup = [
          "setup",
          "--client",
          "hermes",
          "--skill=false",
          "--yes",
          "--json",
        ];
        const applied = await run(setup);
        expect(applied.exitCode, JSON.stringify(applied)).toBe(0);
        expect(applied.json).toMatchObject({ status: "ready" });
        const configured = await readFile(config, "utf8");
        expect(parse(configured, { version })).toMatchObject({
          model: "custom",
          mcp_servers: { rea: { enabled: true, env: { KEEP: "off" } }, other },
          ...(style === "shadowed"
            ? { observer: server, later: { KEEP: "later" } }
            : {}),
        });
        expect(configured).toContain("# Keep this user setting");
        expect(configured).toContain(
          style === "child" ? "# Shared environment" : "# Independent server",
        );
        if (style === "shadowed")
          expect(configured).toContain("# Keep nested reference comment");
        expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(original);
        const doctor = await run(["doctor", "--client", "hermes", "--json"]);
        expect(doctor.exitCode, JSON.stringify(doctor)).toBe(0);
        expect(doctor.json).toMatchObject({
          healthy: true,
          identity: { registrations: [{ client: "hermes", state: "aligned" }] },
        });
        const repeated = await run(setup);
        expect(repeated.exitCode, JSON.stringify(repeated)).toBe(0);
        expect(repeated.json).toMatchObject({
          plannedActions: [],
          appliedActions: [],
        });
        expect(await readFile(config, "utf8")).toBe(configured);
        const removed = await run(["uninstall", "--json"]);
        expect(removed.exitCode, JSON.stringify(removed)).toBe(0);
        expect(parse(await readFile(config, "utf8"), { version })).toEqual({
          model: "custom",
          mcp_servers: { other },
          ...(style === "shadowed"
            ? {
                defaults: { KEEP: "off" },
                later: { KEEP: "later" },
                observer: server,
              }
            : {}),
        });
        expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(original);
        const remaining = await readFile(config, "utf8");
        if (style === "shadowed")
          expect(remaining).toContain("# Keep nested reference comment");
        expect((await run(["uninstall", "--json"])).exitCode).toBe(0);
        expect(await readFile(config, "utf8")).toBe(remaining);
      },
    );
  }
}
