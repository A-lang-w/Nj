import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import {
  installLinuxHopper,
  systemLinuxHopperInstallHost,
} from "../../../src/application/LinuxHopper.js";
import { systemSetupHost } from "../../../src/application/SetupHost.js";
import { runSetup } from "../../../src/application/Setup.js";
import type { DoctorHost } from "../../../src/application/Doctor.js";
import { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { ConfigurationError } from "../../../src/domain/configurationErrors.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

vi.mock("../../../src/application/LinuxHopper.js", async (load) => {
  const actual =
    await load<typeof import("../../../src/application/LinuxHopper.js")>();
  return {
    ...actual,
    installLinuxHopper: vi.fn(actual.installLinuxHopper),
    systemLinuxHopperInstallHost: vi.fn(actual.systemLinuxHopperInstallHost),
  };
});

afterEach(() => vi.resetAllMocks());

it("retains and releases the actual temporary directory through setup's Linux cleanup task", async () => {
  const home = await createTestTempDirectory("rea-setup-linux-cleanup-");
  const temporary = join(home, "owned-installer-staging");
  await mkdir(temporary);
  let allowCleanup = false;
  const actual = await vi.importActual<
    typeof import("../../../src/application/LinuxHopper.js")
  >("../../../src/application/LinuxHopper.js");
  const child = actual.systemLinuxHopperInstallHost(
    { HOME: home },
    async () => undefined,
  );
  vi.mocked(systemLinuxHopperInstallHost).mockReturnValue({
    ...child,
    cleanup: async (path) => {
      expect(path).toBe(temporary);
      if (!allowCleanup)
        throw new Error("Controlled owned temporary directory cleanup failure");
      await rm(path, { recursive: true });
    },
  });
  // Only the installer outcome is simulated; no package/download action runs.
  vi.mocked(installLinuxHopper).mockResolvedValue({
    status: "failed",
    reason: "cleanup_failed",
    cleanupFailure: { path: temporary, reason: "Controlled cleanup failure" },
  });
  const host = systemSetupHost(
    { platform: "linux", homeDirectory: home } as DoctorHost,
    { HOME: home },
  );
  try {
    expect(await host.installHopper(false)).toMatchObject({ status: "failed" });
    const primary = new ConfigurationError("Controlled state failure", {
      settings: [{ setting: "fixture", constraint: "controlled" }],
    });
    const failure = await runSetup(
      { approved: true, structured: true, installHopper: false },
      {
        ...host,
        initialSetupState: async () => {
          throw primary;
        },
      },
    ).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(AnalysisError);
    if (!(failure instanceof AnalysisError))
      throw new Error("Expected typed cleanup failure");
    expect(projectAnalysisError(failure)).toMatchObject({
      code: "cleanup_incomplete",
      details: { resources: [temporary] },
    });
    expect((await stat(temporary)).isDirectory()).toBe(true);
    allowCleanup = true;
    expect(await host.close?.()).toBeUndefined();
    expect(failure.cleanupIncomplete).toBe(false);
    expect(projectAnalysisError(failure)).toMatchObject(
      projectAnalysisError(primary),
    );
    expect(projectAnalysisError(failure).details).not.toHaveProperty("cleanup");
    expect(projectAnalysisError(failure).details).not.toHaveProperty(
      "resources",
    );
    expect(projectAnalysisError(failure).details).toHaveProperty(
      "cleanup_history",
    );
    await expect(stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    allowCleanup = true;
    await host.close?.();
  }
});
