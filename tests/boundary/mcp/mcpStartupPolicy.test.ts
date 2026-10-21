import { describe, expect, it } from "vitest";

import {
  createEsmModuleProfileCollector,
  fixedMcpStartupPhaseBudgetRecovery,
  parseLinuxVmRssBytes,
} from "../../../scripts/lib/mcp-startup-probe.mjs";
import {
  fixedMcpPhaseBudgetRecovery,
  mcpDoctorDeadlineRecovery,
  MCP_STARTUP_POLICY,
} from "../../../src/mcpStartupPolicy.js";

describe("MCP startup policy", () => {
  it("names fixed phase budgets without turning Codex's 30s into a REA knob", () => {
    const initialize = fixedMcpPhaseBudgetRecovery(
      "MCP initialize phase budget",
      MCP_STARTUP_POLICY.initializeBudgetMs,
      "ms",
    );
    expect(initialize).toBe(
      "REA's fixed MCP initialize phase budget is 15000 ms and this release has no runtime override.",
    );
    expect(initialize).toBe(
      fixedMcpStartupPhaseBudgetRecovery(
        "MCP initialize phase budget",
        MCP_STARTUP_POLICY.initializeBudgetMs,
        "ms",
      ),
    );
    expect(
      fixedMcpStartupPhaseBudgetRecovery(
        "MCP tools/list phase budget",
        MCP_STARTUP_POLICY.toolsListBudgetMs,
        "ms",
      ),
    ).toContain("5000 ms");
    expect(
      fixedMcpStartupPhaseBudgetRecovery(
        "MCP first-catalog phase budget",
        MCP_STARTUP_POLICY.firstCatalogBudgetMs,
        "ms",
      ),
    ).toContain("20000 ms");
    const doctor = mcpDoctorDeadlineRecovery(
      MCP_STARTUP_POLICY.doctorDeadlineMs,
    );
    expect(doctor).toContain("30000 ms");
    expect(doctor).toContain("no runtime override");
    expect(doctor).toContain(
      "Codex startup_timeout_sec of 30 seconds is client guidance",
    );
    expect(doctor).toContain("does not enforce");
    expect(doctor).not.toContain("REA_MCP_STARTUP");
  });

  it("parses Linux resident memory without accepting other fields", () => {
    expect(
      parseLinuxVmRssBytes("Name:\tnode\nVmRSS:\t  12345 kB\nThreads:\t7\n"),
    ).toBe(12_641_280);
    expect(parseLinuxVmRssBytes("VmSize:\t12345 kB\n")).toBeNull();
  });

  it("profiles unique file-backed ESM modules without retaining paths", () => {
    const collector = createEsmModuleProfileCollector();
    collector.append(
      "ESM 1: Storing file:///opt/rea/dist/main.js\n" +
        "ESM 1: Translating StandardModule file:///opt/rea/dist/main.js\n" +
        "ESM 1: Storing file:///opt/rea/node_modules/zod/index.js",
    );

    expect(collector.result()).toEqual({
      supported: true,
      method: "node-debug-esm",
      unique_file_modules: 2,
      unique_package_modules: 0,
      unique_dependency_modules: 1,
      debug_lines: 3,
      truncated: false,
    });
  });
});
