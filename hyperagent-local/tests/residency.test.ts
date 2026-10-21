import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyResidency } from "../src/residency/guard.js";
import { verifyDataResidency } from "../src/config.js";

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hal-residency-"));
}

describe("verifyResidency", () => {
  it("blocks ghostcli.cloud case-insensitively in strict mode", () => {
    const dataDir = tmpDataDir();
    try {
      expect(() =>
        verifyResidency({
          dataDir,
          residencyStrict: true,
          llmBaseUrl: "https://GHOSTCLI.cloud/v1",
        }),
      ).toThrow(/Strict residency mode blocks/);
      expect(() =>
        verifyResidency({
          dataDir,
          residencyStrict: true,
          llmBaseUrl: "https://ghostcli.cloud/v1",
        }),
      ).toThrow(/Strict residency mode blocks/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("allows local endpoints in strict mode", () => {
    const dataDir = tmpDataDir();
    try {
      expect(() =>
        verifyResidency({
          dataDir,
          residencyStrict: true,
          llmBaseUrl: "http://localhost:11434/v1",
        }),
      ).not.toThrow();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("allows everything when strict mode is off", () => {
    const dataDir = tmpDataDir();
    try {
      expect(() =>
        verifyResidency({
          dataDir,
          residencyStrict: false,
          llmBaseUrl: "https://ghostcli.cloud/v1",
        }),
      ).not.toThrow();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("verifyDataResidency", () => {
  it("returns without enforcement when strict mode is off", () => {
    const dataDir = tmpDataDir();
    try {
      expect(() =>
        verifyDataResidency({ dataDir, residencyStrict: false }),
      ).not.toThrow();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("accepts a local tmp mount in strict mode", () => {
    const dataDir = tmpDataDir();
    try {
      // os.tmpdir() is a local device on supported platforms, so strict
      // verification must pass rather than throw.
      expect(() =>
        verifyDataResidency({ dataDir, residencyStrict: true }),
      ).not.toThrow();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  // The Linux /proc/mounts branch never runs on macOS CI, so drive it with
  // a mocked platform and mount table. The data dir is real (exists, so no
  // mkdir side effects); only the platform string and /proc/mounts read
  // are faked.
  describe("linux mount matching", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function mockLinuxMounts(mounts: string): void {
      vi.spyOn(os, "platform").mockReturnValue("linux");
      const origRead = fs.readFileSync;
      vi.spyOn(fs, "readFileSync").mockImplementation(((
        p: unknown,
        ...rest: unknown[]
      ) =>
        p === "/proc/mounts"
          ? mounts
          : (origRead as (...a: unknown[]) => unknown)(
              p,
              ...rest,
            )) as typeof fs.readFileSync);
    }

    it("does not attribute a path to a sibling-prefix mount", () => {
      const dataDir = tmpDataDir();
      try {
        // Sibling mount: shares a string prefix with dataDir but is not a
        // parent (differs mid-segment). Naive startsWith matching would
        // attribute dataDir to this NFS mount and wrongly throw.
        const sibling = dataDir.slice(0, -1);
        mockLinuxMounts(
          `/dev/sda1 / ext4 rw 0 0\nnfs:share ${sibling} nfs rw 0 0\n`,
        );
        expect(() =>
          verifyDataResidency({ dataDir, residencyStrict: true }),
        ).not.toThrow();
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("still rejects a path exactly on a remote mount", () => {
      const dataDir = tmpDataDir();
      try {
        mockLinuxMounts(
          `/dev/sda1 / ext4 rw 0 0\nnfs:share ${dataDir} nfs rw 0 0\n`,
        );
        expect(() =>
          verifyDataResidency({ dataDir, residencyStrict: true }),
        ).toThrow(/remote\/network filesystem/);
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("unescapes octal sequences in mount points before matching", () => {
      const parent = tmpDataDir();
      const dataDir = path.join(parent, "my drive");
      fs.mkdirSync(dataDir);
      try {
        // Real dir with a space; /proc/mounts would list it \040-escaped.
        // Without unescaping, the mount never matches and the remote mount
        // is wrongly passed via the local parent.
        const escaped = dataDir.replace(/ /g, "\\040");
        mockLinuxMounts(
          `/dev/sda1 / ext4 rw 0 0\nnfs:share ${escaped} nfs rw 0 0\n`,
        );
        expect(() =>
          verifyDataResidency({ dataDir, residencyStrict: true }),
        ).toThrow(/remote\/network filesystem/);
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    });
  });
});
