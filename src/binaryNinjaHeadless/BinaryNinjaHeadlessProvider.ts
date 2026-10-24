import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import type { Logger } from "pino";

import type {
  AnalysisClient,
  AnalysisClientContext,
  AnalysisProfileResolution,
  AnalysisProfileResolutionOptions,
  AnalysisProviderBoundClientFactory,
  AnalysisProviderCandidate,
  CapabilityDescriptor,
  ProviderAvailability,
  ProviderIdentity,
  ProviderTargetSupport,
} from "../application/AnalysisProvider.js";
import type { AppConfig } from "../config/types.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import {
  analysisProfilesEqual,
  createAnalysisProfile,
  type AnalysisProfileCommitment,
} from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import type { BinaryNinjaHeadlessLauncher } from "./BinaryNinjaHeadlessBridgeProcess.js";
import {
  binaryNinjaHeadlessInstallationDiagnostics,
  inspectBinaryNinjaHeadlessInstallation,
  systemBinaryNinjaHeadlessInstallationHost,
  type AvailableBinaryNinjaHeadlessInstallation,
  type BinaryNinjaHeadlessInstallation,
  type BinaryNinjaHeadlessInstallationHost,
} from "./BinaryNinjaHeadlessInstallation.js";
import {
  BINARY_NINJA_HEADLESS_PROVIDER_IDENTITY,
  binaryNinjaHeadlessCapabilities,
} from "./BinaryNinjaHeadlessProviderCapabilities.js";
import { BinaryNinjaHeadlessSessionClient } from "./BinaryNinjaHeadlessSessionClient.js";

/** Core architecture plugins Binary Ninja ships for the families REA detects. */
const SUPPORTED_ARCHITECTURES: ReadonlySet<string> = new Set([
  "x86",
  "x86_64",
  "arm",
  "arm64",
  "mips",
  "powerpc",
  "riscv",
]);

export interface BinaryNinjaHeadlessProviderOptions {
  readonly logger?: Logger | undefined;
  /** Host platform, injected so availability decisions can be exercised for any host. */
  readonly platform?: NodeJS.Platform | undefined;
  readonly installationHost?: BinaryNinjaHeadlessInstallationHost | undefined;
  readonly launcher?: BinaryNinjaHeadlessLauncher | undefined;
  readonly bridgeScriptPath?: string | undefined;
}

const PROFILE_VERSION_SCOPE = "rea-binary-ninja-headless-adapter";

/** Bring-your-own headless Binary Ninja candidate; discovery starts no interpreter. */
export class BinaryNinjaHeadlessProvider implements AnalysisProviderCandidate {
  readonly #capabilities = binaryNinjaHeadlessCapabilities();
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #platform: NodeJS.Platform;
  readonly #installationHost: BinaryNinjaHeadlessInstallationHost;
  readonly #bridgeScriptPath: string;

  constructor(
    private readonly config: AppConfig,
    environment: Readonly<NodeJS.ProcessEnv>,
    private readonly options: BinaryNinjaHeadlessProviderOptions = {},
  ) {
    this.#platform = options.platform ?? process.platform;
    this.#environment = snapshotEnvironment(environment, this.#platform);
    this.#installationHost =
      options.installationHost ??
      systemBinaryNinjaHeadlessInstallationHost(this.#platform, environment);
    this.#bridgeScriptPath =
      options.bridgeScriptPath ??
      fileURLToPath(
        new URL(
          "../../bridge/binaryninja/rea_binaryninja_bridge.py",
          import.meta.url,
        ),
      );
  }

  identity(): ProviderIdentity {
    return BINARY_NINJA_HEADLESS_PROVIDER_IDENTITY;
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return this.#capabilities;
  }

  inspectAvailability(): ProviderAvailability {
    const installation = this.#inspectInstallation();
    const diagnostics = binaryNinjaHeadlessInstallationDiagnostics(
      installation,
      this.#platform,
    );
    return installation.status === "available"
      ? { status: "available", code: null, reason: null, diagnostics }
      : {
          status: "unavailable",
          code: installation.code,
          reason: installation.reason,
          diagnostics,
        };
  }

  inspectTargetSupport(target: BinaryTarget): ProviderTargetSupport {
    const diagnostics = {
      target_kind: target.kind,
      target_format: target.format,
      architecture: target.architecture ?? null,
      managed: target.managed ?? null,
    };
    if (target.kind !== "executable")
      return {
        status: "unsupported",
        code: "target_kind_unsupported",
        reason: `Headless Binary Ninja analysis loads executable files, not ${target.kind} targets. Inventory or extract the artifact first.`,
        diagnostics,
      };
    if (target.format === "mach-o-universal")
      return {
        status: "unsupported",
        code: "target_format_unsupported",
        reason:
          "Headless Binary Ninja analysis verifies the whole loaded file against the admitted digest, so a universal Mach-O slice cannot be bound. Extract the slice with lipo -thin and analyze the thin file.",
        diagnostics,
      };
    if (
      target.format !== "pe" &&
      target.format !== "elf" &&
      target.format !== "mach-o"
    )
      return {
        status: "unsupported",
        code: "target_format_unsupported",
        reason: `Headless Binary Ninja analysis admits PE, ELF and thin Mach-O executables; ${target.format} inputs require a provider with an explicit load profile such as Ghidra.`,
        diagnostics,
      };
    if (target.format === "pe" && target.managed)
      return {
        status: "unsupported",
        code: "managed_target_unsupported",
        reason:
          "Binary Ninja does not decompile managed .NET code; use REA's managed-code tools for this PE.",
        diagnostics,
      };
    if (!SUPPORTED_ARCHITECTURES.has(target.architecture))
      return {
        status: "unsupported",
        code: "architecture_unsupported",
        reason: `Headless Binary Ninja analysis has not been verified for ${target.architecture} targets; x86, x86_64, arm, arm64, mips, powerpc and riscv are admitted.`,
        diagnostics,
      };
    return { status: "supported", code: null, reason: null, diagnostics };
  }

  async resolveAnalysisProfile(
    target: BinaryTarget,
    options?: AnalysisProfileResolutionOptions,
  ): Promise<Result<AnalysisProfileResolution, AnalysisError>> {
    if (options?.signal?.aborted === true)
      return err(
        new AnalysisCancelledError("open_binary", {
          cause: options.signal.reason,
        }),
      );
    const installation = this.#inspectInstallation();
    if (installation.status !== "available")
      return err(
        new ProviderAdapterError(
          BINARY_NINJA_HEADLESS_PROVIDER_IDENTITY.id,
          "resolve_analysis_profile",
          {
            userMessage: installation.reason,
            diagnostics: {
              availability_code: installation.code,
              ...binaryNinjaHeadlessInstallationDiagnostics(
                installation,
                this.#platform,
              ),
            },
          },
        ),
      );
    const profile = createAnalysisProfile(
      BINARY_NINJA_HEADLESS_PROVIDER_IDENTITY as AnalysisProfileCommitment["provider"],
      {
        version_scope: PROFILE_VERSION_SCOPE,
        mode: "owned-headless",
        engine_version: null,
        install_dir: installation.installDir,
        api_dir: installation.apiDir,
        python_path: installation.pythonPath,
        python_source: installation.pythonSource,
        user_plugins: "disabled",
        repository_plugins: "disabled",
        user_settings: "disabled",
        analysis: "default-auto-analysis",
        cache_policy: "live",
      },
    );
    const createClient: AnalysisProviderBoundClientFactory = (
      requestedTarget,
      requestedProfile,
      context,
    ) =>
      isDeepStrictEqual(requestedTarget, target) &&
      analysisProfilesEqual(requestedProfile, profile)
        ? this.#sessionClient(target, profile, installation, context)
        : this.#unboundClient(
            "Binary Ninja headless client factory received a target or profile different from the resolved binding.",
          );
    return ok({ profile, createClient });
  }

  createClient(
    target: BinaryTarget,
    profile?: AnalysisProfileCommitment,
    context?: AnalysisClientContext,
  ): AnalysisClient {
    const installation = this.#inspectInstallation();
    if (installation.status !== "available")
      return this.#unboundClient(installation.reason);
    if (target.kind !== "executable")
      return this.#unboundClient(
        `Headless Binary Ninja analysis cannot open ${target.kind} targets directly.`,
      );
    return this.#sessionClient(target, profile, installation, context);
  }

  #inspectInstallation(): BinaryNinjaHeadlessInstallation {
    return inspectBinaryNinjaHeadlessInstallation(
      this.config,
      this.#installationHost,
    );
  }

  #sessionClient(
    target: BinaryTarget,
    profile: AnalysisProfileCommitment | undefined,
    installation: AvailableBinaryNinjaHeadlessInstallation,
    context: AnalysisClientContext | undefined,
  ): AnalysisClient {
    return new BinaryNinjaHeadlessSessionClient({
      target,
      profile,
      installation,
      bridgeScriptPath: this.#bridgeScriptPath,
      startupTimeoutMs: this.config.binaryNinjaStartupTimeoutMs,
      hostEnvironment: this.#environment,
      platform: this.#platform,
      runId: context?.runId,
      launcher: this.options.launcher,
      logger: this.options.logger,
      regexMatchingDeadline: this.config.regexMatchingDeadline,
      regexWorkerHeapRequest: this.config.regexWorkerHeapRequest,
    });
  }

  #unboundClient(reason: string): AnalysisClient {
    return {
      execute: (operation) =>
        Promise.resolve(
          err(
            new ProviderAdapterError(
              BINARY_NINJA_HEADLESS_PROVIDER_IDENTITY.id,
              operation,
              { userMessage: reason, diagnostics: { reason } },
            ),
          ),
        ),
      close: () => Promise.resolve(ok(null)),
    };
  }
}
