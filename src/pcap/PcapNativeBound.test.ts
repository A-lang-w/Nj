import { expect, it } from "vitest";

const onLinux = it.skipIf(process.platform !== "linux");
import type { ArtifactAnalysisResources } from "../process/ArtifactAnalysisResources.js";
import {
  BOUNDED_PRODUCER_LIMITS,
  prlimitCeilingArguments,
  type LinuxResourceLimits,
} from "../process/LinuxResourceLimits.js";
import { preparePcapNativeBound } from "./PcapNativeBound.js";

const resources = {
  readLimits: (limits: LinuxResourceLimits) => Promise.resolve(limits),
} as ArtifactAnalysisResources;

it("uses the shared 1 GiB ceiling for the Windows job memory limit", async () => {
  const previousPlatform = process.platform;
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "win32",
  });
  try {
    await expect(preparePcapNativeBound({}, resources)).resolves.toMatchObject(
      {
        nativeBound: {
          memoryLimitBytes: BOUNDED_PRODUCER_LIMITS.address_space_bytes,
        },
      },
    );
  } finally {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: previousPlatform,
    });
  }
});

onLinux("pins capture ceilings through the shared prlimit prefix and keeps 300 CPU seconds", async () => {
  const prepared = await preparePcapNativeBound(
    { REA_TSHARK_PRLIMIT_COMMAND: "/usr/bin/prlimit" },
    resources,
  );
  const limits = {
    address_space_bytes: BOUNDED_PRODUCER_LIMITS.address_space_bytes,
    file_bytes: BOUNDED_PRODUCER_LIMITS.file_bytes,
    cpu_seconds: 300,
  };
  expect(prepared.nativeBound.limiter?.arguments).toEqual(
    prlimitCeilingArguments(limits),
  );
  expect(prepared.limitations[0]).toContain(String(limits.cpu_seconds));
});
