import { describe, expect, it } from "vitest";

import { PRODUCT_IDENTITY } from "../identity.js";
import {
  materializeRegistrationRunnerCache,
  registrationPrewarmCommand,
  type RegistrationRunnerSpawn,
} from "./SetupRegistrationPrewarm.js";

const specifier = PRODUCT_IDENTITY.registrationPackageSpecifier;

describe("registrationPrewarmCommand", () => {
  it("replaces the server subcommand of an npx registration", () => {
    expect(registrationPrewarmCommand(["npx", "-y", specifier, "mcp"])).toEqual(
      ["npx", "-y", specifier, "--version"],
    );
  });

  it("keeps the Windows command wrapper", () => {
    expect(
      registrationPrewarmCommand([
        "cmd.exe",
        "/d",
        "/c",
        "npx",
        "-y",
        specifier,
        "mcp",
      ]),
    ).toEqual(["cmd.exe", "/d", "/c", "npx", "-y", specifier, "--version"]);
  });

  it("replaces the server subcommand of a bunx registration", () => {
    expect(registrationPrewarmCommand(["bunx", specifier, "mcp"])).toEqual([
      "bunx",
      specifier,
      "--version",
    ]);
  });

  it("keeps direct launchers and non-server commands undefined", () => {
    expect(registrationPrewarmCommand(["/opt/rea/rea", "mcp"])).toBeUndefined();
    expect(
      registrationPrewarmCommand(["npx", "-y", specifier, "doctor"]),
    ).toBeUndefined();
    expect(registrationPrewarmCommand([])).toBeUndefined();
  });
});

describe("materializeRegistrationRunnerCache", () => {
  it("skips direct launchers without spawning", async () => {
    let spawned = 0;
    const spawn: RegistrationRunnerSpawn = async () => {
      spawned += 1;
    };
    const result = await materializeRegistrationRunnerCache(
      ["/opt/rea/rea", "mcp"],
      {},
      spawn,
    );
    expect(result).toEqual({ status: "skipped", reason: "direct_launcher" });
    expect(spawned).toBe(0);
  });

  it("materializes the pinned spec once and reports warmed", async () => {
    const launches: (readonly string[])[] = [];
    const spawn: RegistrationRunnerSpawn = async (
      command,
      arguments_,
      options,
    ) => {
      launches.push([command, ...arguments_]);
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.env.REA_PREWARM_PROBE).toBe("1");
      expect(options.cwd.length).toBeGreaterThan(0);
    };
    const result = await materializeRegistrationRunnerCache(
      ["npx", "-y", specifier, "mcp"],
      { REA_PREWARM_PROBE: "1" },
      spawn,
    );
    expect(result).toEqual({ status: "warmed" });
    expect(launches).toEqual([["npx", "-y", specifier, "--version"]]);
  });

  it("reports a bounded failure reason with command output facts", async () => {
    const failure = Object.assign(
      new Error("Command failed: npx -y rea-agents@0.0.0 --version"),
      { stdout: "", stderr: "spawn EPERM\n", code: 1 },
    );
    const result = await materializeRegistrationRunnerCache(
      ["npx", "-y", specifier, "mcp"],
      {},
      async () => {
        throw failure;
      },
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toContain("exit 1");
    expect(result.reason).toContain("spawn EPERM");
    expect(result.reason).not.toMatch(/[\n\r]/u);
    expect(result.reason).toContain("first client start");
  });

  it("reports a timeout failure without command output facts", async () => {
    const result = await materializeRegistrationRunnerCache(
      ["npx", "-y", specifier, "mcp"],
      {},
      async () => {
        throw new Error("Command timed out after 180000 ms: npx");
      },
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.reason).toContain("timed out after 180000 ms");
  });
});
