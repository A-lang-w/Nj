import type { FileCloseResourceOwner } from "../application/AnalysisProvider.js";
import type { DoctorProviderInspection } from "../application/Doctor.js";
import { AscProvider } from "./AscProvider.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";

/** Optional Python/core discovery never opens a target or installs a dependency. */
export const inspectAscProvider = async (
  environment: Readonly<Record<string, string | undefined>>,
  resourceOwner: FileCloseResourceOwner,
  signal?: AbortSignal,
): Promise<DoctorProviderInspection> => {
  const provider = new AscProvider(environment);
  const close = async () => {
    try {
      await provider.close();
    } catch (cause: unknown) {
      resourceOwner.retain(provider, "asc:prerequisites");
      throw cause;
    }
  };
  const availability = await provider.inspectAvailability(signal).then(
    async (value) => {
      await close();
      return value;
    },
    async (failure: unknown) => {
      try {
        await close();
      } catch (cleanup: unknown) {
        if (
          failure instanceof AnalysisError &&
          cleanup instanceof AnalysisError
        )
          throw analysisErrorWithCleanupFailure(
            failure,
            cleanup,
            "doctor",
          ).bindCleanupDependencies([failure, cleanup]);
        throw new AggregateError(
          [failure, cleanup],
          "ASC discovery and cleanup failed",
          { cause: failure },
        );
      }
      throw failure;
    },
  );
  const available = availability.status === "available";
  const code = availability.code;
  const classification =
    code === "unsupported_host"
      ? "unsupported_host"
      : code === "open_options_invalid"
        ? "config_drift"
        : code === "runtime_unavailable" || code === "version_unresolved"
          ? "runtime_failure"
          : "missing_dependency";
  const remediation =
    code === "unsupported_host"
      ? "Use ASC on Linux or macOS, or select the existing JADX backend on a supported host. Installing Python does not enable ASC on this host."
      : code === "open_options_invalid"
        ? "Correct the selected REA_ASC_PYTHON or REA_ASC_* budget reported above, then rerun rea doctor --provider asc."
        : code === "runtime_unavailable" || code === "version_unresolved"
          ? "Inspect the selected interpreter and its DroidASC imports/diagnostics, then retry rea doctor --provider asc."
          : "Set REA_ASC_PYTHON to an existing Python 3.10+ environment containing DroidASC, then run rea doctor --provider asc. REA does not install it.";
  return {
    id: "asc",
    configured: environment.REA_ASC_PYTHON !== undefined,
    available,
    providerVersion: null,
    // Do not persist PYTHONPATH or any other ambient Python environment.
    registrationEnvironment: available
      ? Object.fromEntries(
          [
            "REA_ASC_PYTHON",
            "REA_ASC_OPERATION_TIMEOUT_MS",
            "REA_ASC_MAX_APK_BYTES",
            "REA_ASC_MAX_DEX_BYTES",
            "REA_ASC_MAX_OUTPUT_BYTES",
          ].flatMap((key) =>
            environment[key] === undefined ? [] : [[key, environment[key]!]],
          ),
        )
      : {},
    checks: [
      {
        name: "configuration",
        ok: available,
        code: availability.code,
        detail: available
          ? "Selected Python imports the required DroidASC core interfaces; this does not qualify APK capacity or JADX-equivalent class identities."
          : availability.reason,
        remediation: available ? null : remediation,
        classification,
        details: availability.diagnostics,
      },
    ],
  };
};
