import type {
  DoctorProviderCheck,
  DoctorProviderInspection,
} from "../application/Doctor.js";
import type { RetainedResourceScope } from "../application/AnalysisProvider.js";
import {
  resolveXpandaConfiguration,
  type XpandaConfigurationFailure,
} from "./XpandaConfiguration.js";
import {
  XPANDA_PROVIDER_ID,
  XPANDA_ROOT_VARIABLE,
  XPANDA_VERIFIED_VERSION,
} from "./XpandaRelease.js";

/** Settings a registration may carry; only those the caller set explicitly. */
const REGISTRATION_SETTINGS = ["REA_XPANDA_ROOT"] as const;

/** Classification of one tagged configuration failure. */
const failureClassification = (
  failure: XpandaConfigurationFailure,
  configured: boolean,
): DoctorProviderCheck["classification"] =>
  failure.code === "unsupported_host"
    ? "unsupported_host"
    : failure.code === "not_configured"
      ? "missing_analysis_engine"
      : configured
        ? "config_drift"
        : "missing_analysis_engine";

/**
 * Project xpanda readiness into the doctor contract without starting the
 * bridge; the producer runtime itself is validated by the first operation.
 */
export const inspectXpandaProvider = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  options: {
    readonly resourceScope: RetainedResourceScope;
    readonly signal?: AbortSignal;
  },
): Promise<DoctorProviderInspection> => {
  const configured =
    environment[XPANDA_ROOT_VARIABLE] !== undefined &&
    environment[XPANDA_ROOT_VARIABLE].length > 0;
  const resolved = await resolveXpandaConfiguration(environment, (options.signal === undefined ? {} : { signal: options.signal }));
  const registrationEnvironment = Object.fromEntries(
    REGISTRATION_SETTINGS.flatMap((name) => {
      const setting = environment[name];
      return setting === undefined ? [] : [[name, setting]];
    }),
  );
  if (!resolved.ok) {
    const failure = resolved.error;
    return {
      id: XPANDA_PROVIDER_ID,
      configured,
      available: false,
      providerVersion: null,
      registrationEnvironment,
      checks: [
        {
          name: "configuration",
          ok: false,
          code: failure.code,
          detail: failure.reason,
          remediation: failure.remediation,
          classification: failureClassification(failure, configured),
        },
      ],
    };
  }
  const { value } = resolved;
  const verified = value.version === XPANDA_VERIFIED_VERSION;
  return {
    id: XPANDA_PROVIDER_ID,
    configured: true,
    available: true,
    providerVersion: value.version,
    registrationEnvironment,
    checks: [
      {
        name: "configuration",
        ok: true,
        code: null,
        detail: `${value.root} reports xpanda ${value.version}${
          verified
            ? "."
            : `; REA verified ${XPANDA_VERIFIED_VERSION}, so this release's producer surface is unverified.`
        } The producer runtime is validated by the first xpanda operation.`,
        remediation: null,
        classification: "config_drift",
        details: {
          root: value.root,
          version: value.version,
          verified_version: XPANDA_VERIFIED_VERSION,
        },
      },
    ],
  };
};
