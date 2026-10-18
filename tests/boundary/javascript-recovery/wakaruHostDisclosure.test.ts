import { expect, it } from "vitest";
import {
  RECOVERY_LIMITATIONS,
  recoveryLimitationsFor,
  wakaruHost,
} from "../../../src/javascript/recovery/WakaruRelease.js";

it("keeps every shared caveat on every host", () => {
  for (const host of [
    wakaruHost("linux", "x64", "default"),
    wakaruHost("linux", "arm64", "default"),
    wakaruHost("darwin", "arm64", "configured"),
  ]) {
    const limitations = recoveryLimitationsFor(host);
    expect(limitations).toHaveLength(RECOVERY_LIMITATIONS.length + 1);
    for (const caveat of RECOVERY_LIMITATIONS)
      expect(limitations).toContain(caveat);
  }
});

it("advertises the ceiling where the limiter can enforce it", () => {
  const limits = recoveryLimitationsFor(
    wakaruHost("linux", "x64", "default"),
  ).at(-1);
  expect(limits).toContain("linux-x64 (verified adapter)");
  expect(limits).toContain("1 GiB address-space ceiling");
  expect(limits).not.toContain("NOT enforced");
});

it("still advertises the ceiling on an unverified Linux host", () => {
  const limits = recoveryLimitationsFor(
    wakaruHost("linux", "arm64", "default"),
  ).at(-1);
  expect(limits).toContain("linux-arm64 (unverified host)");
  expect(limits).toContain("1 GiB address-space ceiling");
  expect(limits).not.toContain("NOT enforced");
});

it("reports a caller-supplied wrapper as an unknown ceiling on every host", () => {
  // Admitting a wrapper proves only that it launches, so the wrapper replaces
  // the probed default without inheriting its verified --as mapping, on Linux
  // included: the ceiling claim follows the limiter's source, not the host.
  for (const host of [
    wakaruHost("linux", "x64", "configured"),
    wakaruHost("linux", "arm64", "configured"),
    wakaruHost("darwin", "arm64", "configured"),
  ]) {
    expect(host.addressSpaceLimit).toBe("unknown");
    const limits = recoveryLimitationsFor(host).at(-1);
    expect(limits).toContain("UNKNOWN");
    expect(limits).toContain("util-linux --as");
    // A wrapper may map --as, so neither "enforced" nor a flat denial is honest.
    expect(limits).not.toContain("1 GiB address-space ceiling,");
  }
});

it("reports an absent limiter as an unenforced ceiling, not an unknown one", () => {
  const limits = recoveryLimitationsFor(
    wakaruHost("darwin", "arm64", "absent"),
  ).at(-1);
  expect(limits).toContain("darwin-arm64 (unverified host)");
  expect(limits).toContain("no address-space ceiling is applied");
  expect(limits).toContain("REA_JAVASCRIPT_PRLIMIT_COMMAND");
  expect(limits).not.toContain("UNKNOWN");
  // The in-process rails survive the missing limiter and must stay disclosed.
  expect(limits).toContain("120-second deadline");
});

it("keeps the verified label when a verified host has no limiter", () => {
  const limits = recoveryLimitationsFor(
    wakaruHost("linux", "x64", "absent"),
  ).at(-1);
  expect(limits).toContain("linux-x64 (verified adapter)");
  expect(limits).toContain("no address-space ceiling is applied");
  expect(limits).not.toContain("UNKNOWN");
  expect(limits).toContain("120-second deadline");
});

it("marks only linux x64 as verified and takes the ceiling from the limiter source", () => {
  expect(wakaruHost("linux", "x64", "default")).toMatchObject({
    verified: true,
    addressSpaceLimit: "enforced",
  });
  expect(wakaruHost("linux", "arm64", "default")).toMatchObject({
    verified: false,
    addressSpaceLimit: "enforced",
  });
  expect(wakaruHost("linux", "x64", "configured")).toMatchObject({
    verified: true,
    addressSpaceLimit: "unknown",
  });
  expect(wakaruHost("darwin", "arm64", "configured")).toMatchObject({
    verified: false,
    addressSpaceLimit: "unknown",
  });
  expect(wakaruHost("darwin", "arm64", "absent")).toMatchObject({
    verified: false,
    addressSpaceLimit: "unenforced",
  });
  expect(wakaruHost("linux", "x64", "absent")).toMatchObject({
    verified: true,
    addressSpaceLimit: "unenforced",
  });
});
