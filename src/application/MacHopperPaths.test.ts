import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { describe, expect, it } from "vitest";

import {
  macHopperCanonicalLauncherCandidates,
  macHopperLauncherCandidates,
  macHopperRenamedLauncherCandidates,
  toPosixHome,
} from "./MacHopperPaths.js";

describe("macOS Hopper launcher paths", () => {
  const home = "/fixture/home";

  it("keeps canonical system and user candidates ahead of renamed bundles", () => {
    expect(macHopperCanonicalLauncherCandidates(home)).toEqual([
      "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper",
      "/fixture/home/Applications/Hopper Disassembler.app/Contents/MacOS/hopper",
    ]);
    expect(
      macHopperRenamedLauncherCandidates(
        home,
        new Map([
          [
            "/Applications",
            ["Hopper z.app", "Hopper a.app", "Hopper Disassembler.app"],
          ],
          ["/fixture/home/Applications", ["Hopper User.app"]],
        ]),
      ),
    ).toEqual([
      "/Applications/Hopper a.app/Contents/MacOS/hopper",
      "/Applications/Hopper z.app/Contents/MacOS/hopper",
      "/fixture/home/Applications/Hopper User.app/Contents/MacOS/hopper",
    ]);
  });

  it("always includes the installer's canonical user destination", () => {
    expect(macHopperLauncherCandidates(home)).toContain(
      "/fixture/home/Applications/Hopper Disassembler.app/Contents/MacOS/hopper",
    );
  });

  it("preserves literal backslashes in POSIX home directory paths", () => {
    const homeWithBackslash = "/fixture/user\\name";
    expect(macHopperCanonicalLauncherCandidates(homeWithBackslash)).toEqual([
      "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper",
      "/fixture/user\\name/Applications/Hopper Disassembler.app/Contents/MacOS/hopper",
    ]);
    expect(
      macHopperRenamedLauncherCandidates(
        homeWithBackslash,
        new Map([["/fixture/user\\name/Applications", ["Hopper Preview.app"]]]),
      ),
    ).toEqual([
      "/fixture/user\\name/Applications/Hopper Preview.app/Contents/MacOS/hopper",
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "discovers renamed user bundles in a POSIX home containing literal backslashes",
    async () => {
      const temporary = await mkdtemp(join(tmpdir(), "rea-hopper-paths-"));
      const userHome = join(temporary, "user\\name");
      const appDirectory = join(userHome, "Applications", "Hopper Preview.app");
      try {
        await mkdir(appDirectory, { recursive: true });
        const candidates = [...macHopperLauncherCandidates(userHome)];
        expect(candidates).toContain(
          `${userHome}/Applications/Hopper Preview.app/Contents/MacOS/hopper`,
        );
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
  );

  it("finds renamed user bundles through the runtime filesystem scan", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "rea-hopper-paths-"));
    const appDirectory = join(temporary, "Applications", "Hopper Preview.app");
    try {
      await mkdir(appDirectory, { recursive: true });
      expect([...macHopperLauncherCandidates(temporary)]).toContain(
        posix.join(
          toPosixHome(temporary),
          "Applications/Hopper Preview.app/Contents/MacOS/hopper",
        ),
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
