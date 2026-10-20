import { constants as bufferConstants } from "node:buffer";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import type { ProviderRejectionCode } from "../contracts/providerSelection.js";
import type { JsonValue } from "../domain/jsonValue.js";

/** Explicit caller-owned Python and independent input, expansion and wire budgets. */
export interface AscConfiguration {
  readonly python: string;
  readonly timeoutMs: number;
  readonly maxApkBytes: number;
  readonly maxDexBytes: number;
  readonly maxOutputBytes: number;
}

const unavailable = (
  operation: string,
  code: ProviderRejectionCode,
  reason: string,
  context: {
    readonly remediation: string;
    readonly diagnostics?: Readonly<Record<string, JsonValue>>;
  },
) =>
  new AnalysisCapabilityUnavailableError("asc", operation, reason, {
    diagnostics: { ...context.diagnostics, asc_availability_code: code },
    remediationAction: context.remediation,
  });

/** Validate every optional bound before opening a target or starting Python. */
export const resolveAscConfiguration = async (
  environment: Readonly<Record<string, string | undefined>>,
  operation: string,
): Promise<AscConfiguration> => {
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw unavailable(
      operation,
      "unsupported_host",
      "DroidASC is enabled only on Linux and macOS through the shared owned-process API; Windows worker supervision is not enabled.",
      {
        remediation:
          "Select Linux or macOS for the optional ASC backend, or keep the existing JADX workflow on a supported host.",
        diagnostics: { platform: process.platform },
      },
    );
  const python = environment.REA_ASC_PYTHON;
  if (python === undefined)
    throw unavailable(
      operation,
      "not_configured",
      "REA_ASC_PYTHON is not configured.",
      {
        remediation:
          "Set REA_ASC_PYTHON to an existing absolute Python executable with a caller-supplied compatible DroidASC installation or PYTHONPATH; REA installs nothing.",
      },
    );
  if (python.length === 0 || !isAbsolute(python) || python.includes("\0"))
    throw unavailable(
      operation,
      "open_options_invalid",
      "REA_ASC_PYTHON must select one explicit absolute Python executable.",
      {
        remediation:
          "Set REA_ASC_PYTHON to one existing absolute Python executable path without NUL characters.",
        diagnostics: { setting: "REA_ASC_PYTHON", selected_python: python },
      },
    );
  const number = (
    name: string,
    fallback: number,
    maximum = Number.MAX_SAFE_INTEGER,
  ): number => {
    const text = environment[name];
    if (text === undefined) return fallback;
    const value = Number(text);
    if (
      !/^[0-9]+$/u.test(text) ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > maximum
    )
      throw unavailable(
        operation,
        "open_options_invalid",
        `${name} must be a decimal integer from 1 to ${String(maximum)}.`,
        {
          remediation: `Set ${name} to a decimal integer from 1 to ${String(maximum)}, or unset it to use the default.`,
          diagnostics: {
            setting: name,
            selected_value: text,
            minimum: 1,
            maximum,
          },
        },
      );
    return value;
  };
  const configuration: AscConfiguration = {
    python,
    timeoutMs: number("REA_ASC_OPERATION_TIMEOUT_MS", 120_000, 2_147_483_647),
    maxApkBytes: number("REA_ASC_MAX_APK_BYTES", 1024 * 1024 * 1024),
    maxDexBytes: number("REA_ASC_MAX_DEX_BYTES", 512 * 1024 * 1024),
    maxOutputBytes: number(
      "REA_ASC_MAX_OUTPUT_BYTES",
      32 * 1024 * 1024,
      bufferConstants.MAX_STRING_LENGTH,
    ),
  };
  try {
    await access(python, constants.X_OK);
    if (!(await stat(python)).isFile())
      throw new Error("Selected Python is not a regular executable file");
  } catch (cause: unknown) {
    throw new AnalysisCapabilityUnavailableError(
      "asc",
      operation,
      `Selected REA_ASC_PYTHON is not executable: ${python}`,
      {
        cause,
        diagnostics: {
          asc_availability_code: "executable_missing",
          python_executable: python,
        },
        remediationAction:
          "Select an existing executable Python interpreter with REA_ASC_PYTHON; REA does not install Python or DroidASC.",
      },
    );
  }
  return configuration;
};
