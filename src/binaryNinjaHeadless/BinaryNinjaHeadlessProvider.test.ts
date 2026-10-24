import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseConfig } from "../config/parseConfig.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import type { BinaryNinjaHeadlessInstallationHost } from "./BinaryNinjaHeadlessInstallation.js";
import { BinaryNinjaHeadlessProvider } from "./BinaryNinjaHeadlessProvider.js";
import {
  BINARY_NINJA_HEADLESS_OPERATIONS,
  BINARY_NINJA_HEADLESS_PROVIDER_IDENTITY,
} from "./BinaryNinjaHeadlessProviderCapabilities.js";

const config = (environment: Record<string, string> = {}) => {
  const parsed = parseConfig(environment);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};

/** A fake host whose only existing paths are the ones the test lists. */
const host = (
  platform: NodeJS.Platform,
  files: readonly string[],
  directories: readonly string[],
): BinaryNinjaHeadlessInstallationHost => ({
  platform,
  programFiles: "C:\\Program Files",
  isRegularFile: (path) => files.includes(path),
  isDirectory: (path) => directories.includes(path),
});

const peTarget: BinaryTarget = {
  path: "C:\\samples\\where.exe",
  sha256: "f".repeat(64),
  kind: "executable",
  format: "pe",
  architecture: "x86_64",
  availableArchitectures: ["x86_64"],
  executableRole: "application",
  managed: false,
};

describe("Binary Ninja headless availability", () => {
  it("reports not_configured on a host without a vendor default location", () => {
    const provider = new BinaryNinjaHeadlessProvider(
      config(),
      {},
      {
        platform: "linux",
        installationHost: host("linux", [], []),
      },
    );
    expect(provider.inspectAvailability()).toMatchObject({
      status: "unavailable",
      code: "not_configured",
      reason: expect.stringContaining("BINARY_NINJA_INSTALL_DIR"),
      diagnostics: { install_dir: null, engine_probed: false },
    });
  });

  it("probes the Windows vendor default without reading PATH", () => {
    const installDir = join("C:\\Program Files", "Vector35", "BinaryNinja");
    const api = join(installDir, "python", "binaryninja", "__init__.py");
    const python = join(installDir, "plugins", "python", "python.exe");
    const provider = new BinaryNinjaHeadlessProvider(
      config(),
      {},
      {
        platform: "win32",
        installationHost: host("win32", [api, python], [installDir]),
      },
    );
    expect(provider.inspectAvailability()).toMatchObject({
      status: "available",
      diagnostics: {
        install_dir: installDir,
        install_dir_source: "default",
        python_path: python,
        python_source: "bundled",
        engine_probed: false,
      },
    });
  });

  it("requires the Python API package below the selected installation", () => {
    const installDir = "/opt/binaryninja";
    const provider = new BinaryNinjaHeadlessProvider(
      config({ BINARY_NINJA_INSTALL_DIR: installDir }),
      {},
      { platform: "linux", installationHost: host("linux", [], [installDir]) },
    );
    expect(provider.inspectAvailability()).toMatchObject({
      status: "unavailable",
      code: "runtime_missing",
      reason: expect.stringContaining("python/binaryninja"),
    });
  });

  it("requires an explicit interpreter where none is bundled", () => {
    const installDir = "/opt/binaryninja";
    const api = join(installDir, "python", "binaryninja", "__init__.py");
    const provider = new BinaryNinjaHeadlessProvider(
      config({ BINARY_NINJA_INSTALL_DIR: installDir }),
      {},
      {
        platform: "linux",
        installationHost: host("linux", [api], [installDir]),
      },
    );
    expect(provider.inspectAvailability()).toMatchObject({
      status: "unavailable",
      code: "executable_missing",
      reason: expect.stringContaining("REA_BINARY_NINJA_PYTHON"),
    });
    const configured = new BinaryNinjaHeadlessProvider(
      config({
        BINARY_NINJA_INSTALL_DIR: installDir,
        REA_BINARY_NINJA_PYTHON: "/usr/bin/python3",
      }),
      {},
      {
        platform: "linux",
        installationHost: host(
          "linux",
          [api, "/usr/bin/python3"],
          [installDir],
        ),
      },
    );
    expect(configured.inspectAvailability()).toMatchObject({
      status: "available",
      diagnostics: {
        python_path: "/usr/bin/python3",
        python_source: "setting",
      },
    });
  });

  it("advertises live, read-only, process-launching capabilities", () => {
    const provider = new BinaryNinjaHeadlessProvider(
      config(),
      {},
      {
        platform: "linux",
        installationHost: host("linux", [], []),
      },
    );
    const capabilities = provider.capabilities();
    expect(capabilities.map(({ operation }) => operation)).toEqual([
      ...BINARY_NINJA_HEADLESS_OPERATIONS,
    ]);
    for (const capability of capabilities)
      expect(capability).toMatchObject({
        provider: BINARY_NINJA_HEADLESS_PROVIDER_IDENTITY,
        available: true,
        cachePolicy: "live",
        effects: {
          mutatesArtifact: false,
          launchesProcess: true,
          mayShowUi: false,
          mayAccessNetwork: false,
        },
      });
  });
});

describe("Binary Ninja headless target support", () => {
  const provider = new BinaryNinjaHeadlessProvider(
    config(),
    {},
    {
      platform: "linux",
      installationHost: host("linux", [], []),
    },
  );

  it("admits native PE, ELF and thin Mach-O executables", () => {
    expect(provider.inspectTargetSupport(peTarget)).toMatchObject({
      status: "supported",
    });
    expect(
      provider.inspectTargetSupport({
        path: "/tmp/a.out",
        sha256: "a".repeat(64),
        kind: "executable",
        format: "elf",
        architecture: "arm64",
        availableArchitectures: ["arm64"],
      }),
    ).toMatchObject({ status: "supported" });
  });

  it("declines managed PE images toward the managed-code tools", () => {
    expect(
      provider.inspectTargetSupport({ ...peTarget, managed: true }),
    ).toMatchObject({
      status: "unsupported",
      code: "managed_target_unsupported",
    });
  });

  it("declines universal Mach-O containers and headerless loads", () => {
    expect(
      provider.inspectTargetSupport({
        path: "/tmp/fat",
        sha256: "a".repeat(64),
        kind: "executable",
        format: "mach-o-universal",
        architecture: "arm64",
        availableArchitectures: ["arm64", "x86_64"],
        universalSlice: { offset: 0x4000, size: 0x1000 },
      }),
    ).toMatchObject({
      status: "unsupported",
      code: "target_format_unsupported",
      reason: expect.stringContaining("lipo -thin"),
    });
    expect(
      provider.inspectTargetSupport({
        path: "/tmp/ecu.bin",
        sha256: "a".repeat(64),
        kind: "executable",
        format: "raw-binary",
        architecture: "arm",
        availableArchitectures: ["arm"],
        entryPoint: "0x8000000",
        entryPointSource: "0x8000000",
      }),
    ).toMatchObject({
      status: "unsupported",
      code: "target_format_unsupported",
    });
  });

  it("declines unverified architectures and non-executable targets", () => {
    expect(
      provider.inspectTargetSupport({
        path: "/tmp/chre.so",
        sha256: "a".repeat(64),
        kind: "executable",
        format: "elf",
        architecture: "hexagon",
        availableArchitectures: ["hexagon"],
      }),
    ).toMatchObject({
      status: "unsupported",
      code: "architecture_unsupported",
    });
    expect(
      provider.inspectTargetSupport({
        path: "/tmp/app.zip",
        sha256: "a".repeat(64),
        kind: "archive",
        format: "zip",
      }),
    ).toMatchObject({ status: "unsupported", code: "target_kind_unsupported" });
  });
});

describe("Binary Ninja headless profile resolution", () => {
  const installDir = "/opt/binaryninja";
  const api = join(installDir, "python", "binaryninja", "__init__.py");
  const provider = new BinaryNinjaHeadlessProvider(
    config({
      BINARY_NINJA_INSTALL_DIR: installDir,
      REA_BINARY_NINJA_PYTHON: "/usr/bin/python3",
    }),
    {},
    {
      platform: "linux",
      installationHost: host("linux", [api, "/usr/bin/python3"], [installDir]),
    },
  );

  it("commits the observed installation without starting an interpreter", async () => {
    const resolved = await provider.resolveAnalysisProfile(peTarget);
    if (!resolved.ok) throw resolved.error;
    expect(resolved.value.profile).toMatchObject({
      provider: BINARY_NINJA_HEADLESS_PROVIDER_IDENTITY,
      parameters: {
        mode: "owned-headless",
        api_dir: join(installDir, "python"),
        python_path: "/usr/bin/python3",
        user_plugins: "disabled",
        cache_policy: "live",
      },
    });
    expect(resolved.value.createClient).toBeTypeOf("function");
  });

  it("binds the client factory to the resolved target and profile", async () => {
    const resolved = await provider.resolveAnalysisProfile(peTarget);
    if (!resolved.ok || resolved.value.createClient === undefined)
      throw new Error("expected a bound client factory");
    const profile = resolved.value.profile;
    if (profile === null) throw new Error("expected a resolved profile");
    const foreign = resolved.value.createClient(
      { ...peTarget, sha256: "e".repeat(64) },
      profile,
    );
    const outcome = await foreign.execute("list_procedures", {});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBeInstanceOf(ProviderAdapterError);
    expect(outcome.error.userMessage).toContain("different from the resolved");
    expect(await foreign.close()).toMatchObject({ ok: true });
  });

  it("fails profile resolution closed while the installation is unavailable", async () => {
    const unavailable = new BinaryNinjaHeadlessProvider(
      config(),
      {},
      {
        platform: "linux",
        installationHost: host("linux", [], []),
      },
    );
    const resolved = await unavailable.resolveAnalysisProfile(peTarget);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBeInstanceOf(ProviderAdapterError);
    expect(resolved.error.diagnostics).toMatchObject({
      availability_code: "not_configured",
    });
  });
});
