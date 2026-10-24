import { statSync } from "node:fs";
import { join } from "node:path";

import type { ProviderRejectionCode } from "../contracts/providerSelection.js";
import type { JsonValue } from "../domain/jsonValue.js";

/** Settings this inspection admits; both are optional and never probed from PATH. */
export interface BinaryNinjaHeadlessSettings {
  readonly binaryNinjaInstallDir?: string | undefined;
  readonly binaryNinjaPythonPath?: string | undefined;
}

/** Host facts the inspection reads; tests inject them instead of the real filesystem. */
export interface BinaryNinjaHeadlessInstallationHost {
  readonly platform: NodeJS.Platform;
  /** Windows `ProgramFiles`; the default install root lives below it. */
  readonly programFiles?: string | undefined;
  isRegularFile(path: string): boolean;
  isDirectory(path: string): boolean;
}

/** Install facts REA binds into a session; every path was observed, not guessed. */
export interface AvailableBinaryNinjaHeadlessInstallation {
  readonly status: "available";
  readonly installDir: string;
  readonly installDirSource: "setting" | "default";
  /** Directory that contains the `binaryninja` Python package. */
  readonly apiDir: string;
  readonly pythonPath: string;
  readonly pythonSource: "setting" | "bundled";
}

export interface UnavailableBinaryNinjaHeadlessInstallation {
  readonly status: "unavailable";
  readonly code: ProviderRejectionCode;
  readonly reason: string;
  readonly installDir: string | null;
  readonly installDirSource: "setting" | "default" | null;
}

export type BinaryNinjaHeadlessInstallation =
  | AvailableBinaryNinjaHeadlessInstallation
  | UnavailableBinaryNinjaHeadlessInstallation;

const INSTALL_DIR_SETTING = "BINARY_NINJA_INSTALL_DIR";
const PYTHON_SETTING = "REA_BINARY_NINJA_PYTHON";

/** Vendor default install roots; Linux installs are unpacked wherever the user chose. */
const defaultInstallDir = (
  host: BinaryNinjaHeadlessInstallationHost,
): string | undefined => {
  switch (host.platform) {
    case "win32":
      return join(
        host.programFiles ?? "C:\\Program Files",
        "Vector35",
        "BinaryNinja",
      );
    case "darwin":
      return "/Applications/Binary Ninja.app/Contents/Resources";
    default:
      return undefined;
  }
};

const probeFilesystem = (path: string, kind: "file" | "directory"): boolean => {
  try {
    const stats = statSync(path);
    return kind === "file" ? stats.isFile() : stats.isDirectory();
  } catch {
    return false;
  }
};

/** Read the real host; production composition passes nothing else. */
export const systemBinaryNinjaHeadlessInstallationHost = (
  platform: NodeJS.Platform = process.platform,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): BinaryNinjaHeadlessInstallationHost => ({
  platform,
  programFiles: environment.ProgramFiles ?? environment.PROGRAMFILES,
  isRegularFile: (path) => probeFilesystem(path, "file"),
  isDirectory: (path) => probeFilesystem(path, "directory"),
});

/**
 * Locate the Binary Ninja Python API and an interpreter without starting either.
 * The API directory is injected by the bridge, so Vector35's `install_api.py`
 * step is not required.
 */
export const inspectBinaryNinjaHeadlessInstallation = (
  settings: BinaryNinjaHeadlessSettings,
  host: BinaryNinjaHeadlessInstallationHost,
): BinaryNinjaHeadlessInstallation => {
  const selected = settings.binaryNinjaInstallDir;
  const installDir = selected ?? defaultInstallDir(host);
  const installDirSource = selected === undefined ? "default" : "setting";
  if (installDir === undefined)
    return {
      status: "unavailable",
      code: "not_configured",
      reason: `Set ${INSTALL_DIR_SETTING} to the Binary Ninja installation directory that contains its python/binaryninja package; this host has no vendor default location.`,
      installDir: null,
      installDirSource: null,
    };
  if (!host.isDirectory(installDir))
    return {
      status: "unavailable",
      code: selected === undefined ? "not_configured" : "runtime_missing",
      reason:
        selected === undefined
          ? `No Binary Ninja installation was found at the default location ${installDir}; set ${INSTALL_DIR_SETTING} to the installation directory.`
          : `${INSTALL_DIR_SETTING} does not name an existing directory: ${installDir}`,
      installDir,
      installDirSource,
    };
  const apiDir = join(installDir, "python");
  if (!host.isRegularFile(join(apiDir, "binaryninja", "__init__.py")))
    return {
      status: "unavailable",
      code: "runtime_missing",
      reason: `The Binary Ninja Python API package was not found at ${join(apiDir, "binaryninja")}; ${INSTALL_DIR_SETTING} must name the installation directory that contains python/binaryninja.`,
      installDir,
      installDirSource,
    };
  const selectedPython = settings.binaryNinjaPythonPath;
  if (selectedPython !== undefined) {
    if (!host.isRegularFile(selectedPython))
      return {
        status: "unavailable",
        code: "executable_missing",
        reason: `${PYTHON_SETTING} does not name an existing Python interpreter file: ${selectedPython}`,
        installDir,
        installDirSource,
      };
    return {
      status: "available",
      installDir,
      installDirSource,
      apiDir,
      pythonPath: selectedPython,
      pythonSource: "setting",
    };
  }
  // Windows installs bundle a CPython interpreter that loads the shipped API.
  const bundled =
    host.platform === "win32"
      ? join(installDir, "plugins", "python", "python.exe")
      : undefined;
  if (bundled !== undefined && host.isRegularFile(bundled))
    return {
      status: "available",
      installDir,
      installDirSource,
      apiDir,
      pythonPath: bundled,
      pythonSource: "bundled",
    };
  return {
    status: "unavailable",
    code: "executable_missing",
    reason: `Set ${PYTHON_SETTING} to a Python 3 interpreter able to load the Binary Ninja API from ${apiDir}; REA does not search PATH for one.`,
    installDir,
    installDirSource,
  };
};

/** Caller-safe facts for readiness diagnostics and Evidence. */
export const binaryNinjaHeadlessInstallationDiagnostics = (
  inspection: BinaryNinjaHeadlessInstallation,
  platform: NodeJS.Platform,
): Readonly<Record<string, JsonValue>> => ({
  platform,
  install_dir: inspection.installDir,
  install_dir_source: inspection.installDirSource,
  ...(inspection.status === "available"
    ? {
        api_dir: inspection.apiDir,
        python_path: inspection.pythonPath,
        python_source: inspection.pythonSource,
      }
    : { api_dir: null, python_path: null, python_source: null }),
  engine_probed: false,
});
