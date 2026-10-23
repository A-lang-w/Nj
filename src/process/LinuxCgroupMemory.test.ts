import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  parseLinuxCgroupMemoryMax,
  parseLinuxCgroupOomKills,
  parseLinuxCgroupV2Path,
  readLinuxCgroupMemoryState,
} from "./LinuxCgroupMemory.js";

const events = (oomKill: number) =>
  `low 0\nhigh 0\nmax 772\noom 3\noom_kill ${String(oomKill)}\noom_group_kill 0\n`;

it("reads the cgroup v2 row and ignores v1 controller rows", () => {
  expect(
    parseLinuxCgroupV2Path(
      "12:memory:/docker/abc\n0::/system.slice/rea.service\n",
    ),
  ).toBe("/system.slice/rea.service");
  expect(parseLinuxCgroupV2Path("0::/\n")).toBe("/");
});

it.each([
  "12:memory:/docker/abc\n",
  "0::/a\n0::/b\n",
  "0::relative\n",
  "0::/a/../b\n",
])("does not infer a cgroup v2 path from %j", (value) => {
  expect(parseLinuxCgroupV2Path(value)).toBeUndefined();
});

it("reads oom_kill without confusing it with oom or oom_group_kill", () => {
  expect(parseLinuxCgroupOomKills(events(1))).toBe(1);
  expect(parseLinuxCgroupOomKills("oom 3\noom_group_kill 2\n")).toBeUndefined();
  expect(parseLinuxCgroupOomKills("oom_kill 1\noom_kill 2\n")).toBeUndefined();
  expect(
    parseLinuxCgroupOomKills("oom_kill 9007199254740992\n"),
  ).toBeUndefined();
});

it("reads a byte limit and the unlimited token", () => {
  expect(parseLinuxCgroupMemoryMax("3221225472\n")).toBe(3_221_225_472);
  expect(parseLinuxCgroupMemoryMax("max\n")).toBeNull();
  expect(parseLinuxCgroupMemoryMax("3g\n")).toBeUndefined();
});

const cgroupTree = async (
  files: Readonly<Record<string, string>>,
  membership = "0::/rea\n",
) => {
  const root = await createTestTempDirectory("rea-cgroup-");
  const mountRoot = join(root, "cgroup");
  await mkdir(join(mountRoot, "rea"), { recursive: true });
  for (const [name, text] of Object.entries(files))
    await writeFile(join(mountRoot, "rea", name), text);
  const procCgroupPath = join(root, "proc-self-cgroup");
  await writeFile(procCgroupPath, membership);
  return { platform: "linux" as const, mountRoot, procCgroupPath };
};

it("reads the process's own group from the cgroup2 mount", async () => {
  const options = await cgroupTree({
    "memory.events": events(1),
    "memory.max": "3221225472\n",
  });
  await expect(readLinuxCgroupMemoryState(options)).resolves.toEqual({
    path: "/rea",
    oomKills: 1,
    memoryMax: 3_221_225_472,
  });
});

it("keeps the kill count when the group publishes no limit", async () => {
  const options = await cgroupTree({ "memory.events": events(0) });
  await expect(readLinuxCgroupMemoryState(options)).resolves.toEqual({
    path: "/rea",
    oomKills: 0,
    memoryMax: null,
  });
});

it("is unavailable without memory.events, cgroup v2, or Linux", async () => {
  const noEvents = await cgroupTree({ "memory.max": "max\n" });
  await expect(readLinuxCgroupMemoryState(noEvents)).resolves.toBeUndefined();
  const v1 = await cgroupTree(
    { "memory.events": events(0) },
    "4:memory:/rea\n",
  );
  await expect(readLinuxCgroupMemoryState(v1)).resolves.toBeUndefined();
  const linux = await cgroupTree({ "memory.events": events(0) });
  await expect(
    readLinuxCgroupMemoryState({ ...linux, platform: "darwin" }),
  ).resolves.toBeUndefined();
});
