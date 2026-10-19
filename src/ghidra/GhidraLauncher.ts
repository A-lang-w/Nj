import {
  prepareGhidraAnalysisCache,
  type GhidraAnalysisCache,
} from "./GhidraAnalysisCache.js";
import {
  ghidraAnalysisPlan,
  ghidraHeadlessArguments,
  type GhidraHeadlessArgumentOptions,
} from "./GhidraHeadlessArguments.js";
export {
  ghidraHeadlessArguments,
  type GhidraHeadlessArgumentOptions,
} from "./GhidraHeadlessArguments.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  snapshotGhidraAnalysisSeeds,
  type GhidraSeedCommitment,
} from "./GhidraAnalysisSeeds.js";
import type { GhidraLanguageOverride } from "../config/ghidraLanguageOverride.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, win32 } from "node:path";

import writeFileAtomic from "write-file-atomic";

import { windowsPrivateRuntime } from "../windows/WindowsPrivateRuntime.js";
import {
  quoteWindowsBatchToken,
  windowsBatchCommand,
  WindowsBatchCommandError,
} from "../process/WindowsBatchCommand.js";

import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { DarwinProcessOwnershipInspectionError } from "../process/DarwinProcessRunTokenReader.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";
import type { AnalysisCapturedOutput } from "../domain/analysisErrorBase.js";
import { execFileOutputFailure } from "../process/ExecFileOutput.js";
import { boundedUtf8Text } from "../process/boundedUtf8Text.js";
import { redactCapturedTransportCredential } from "../process/ProviderDiagnosticRedaction.js";
import {
  cleanupOwnedProcessGroup,
  cleanupWindowsProcessTree,
  type ProcessCleanupResult,
  type ProcessCleanupFailure,
} from "../process/ProcessOwnership.js";
import {
  type ProviderProcessLaunch,
  type SpawnedOwnedProviderProcess,
  spawnOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import { ghidraJavaEnvironment } from "./GhidraInstallation.js";
import {
  ghidraJavaLaunch,
  GhidraLaunchSupportError,
} from "./GhidraJavaLaunch.js";
import type { GhidraTransportKind } from "./GhidraTransport.js";
import {
  snapshotGhidraExtensions,
  type GhidraExtension,
} from "./extensions/GhidraExtensions.js";

import {
  inspectGhidraPspExtension,
  type GhidraPspExtension,
} from "./GhidraPspExtension.js";

/** Private paths and identity material for one headless Ghidra import. */
export interface GhidraLaunchSession {
  readonly runtimeRoot: string;
  readonly transport: GhidraTransportKind;
  readonly endpointPath: string;
  readonly token: string;
  readonly runId: string;
  readonly targetPath: string;
  readonly targetSha256: string;
  readonly providerVersion: string;
  readonly profileDigest: string;
}

/** Process plus private log coordinates returned by a Ghidra launcher. */
export type GhidraLaunch = ProviderProcessLaunch & {
  readonly projectRoot: string;
  readonly ghidraLogPath: string;
  readonly scriptLogPath: string;
  /** Value supplied to the JVM as -Xmx, not a measurement of effective memory. */
  readonly configuredMaxHeap?: string;
  readonly launchSupport?: readonly GhidraLaunchSupportDiagnostic[];
};

/** Same per-stream projection budget for helper warnings and failed commands. */
export const GHIDRA_LAUNCH_COMMAND_OUTPUT_BYTES = 8 * 1024;

/** Successful helper stderr, retained independently of the analysis JVM output. */
export type GhidraLaunchSupportDiagnostic = {
  readonly mode: "-envvars" | "-vmargs";
  readonly stderr: string;
  readonly stderr_bytes: number;
  readonly stderr_truncated: boolean;
};

/** Provider-owned capability that starts one isolated headless analysis. */
export interface GhidraLauncher {
  launch(
    session: GhidraLaunchSession,
    options?: {
      readonly signal?: AbortSignal;
      readonly resourceScope?: ArtifactResourceScope;
    },
  ): Promise<Result<GhidraLaunch, GhidraLaunchError | AnalysisCancelledError>>;
}

/** A rollback attempt failed without releasing its process owner. */
export type GhidraLaunchRollbackFailure =
  | { readonly kind: "incomplete"; readonly result: ProcessCleanupFailure }
  | { readonly kind: "rejected"; readonly cause: unknown };

/** Local launch failure retained as the cause of a provider-neutral error. */
export class GhidraLaunchError extends Error {
  readonly #partialLaunch: GhidraLaunch | undefined;
  readonly #capturedOutput: AnalysisCapturedOutput | undefined;
  readonly launchSupport: readonly GhidraLaunchSupportDiagnostic[];
  readonly rollbackFailure: GhidraLaunchRollbackFailure | undefined;
  readonly cleanupFailure: AnalysisError | undefined;
  /** Known producer outcome, independent of a signal that changes during finalization. */
  readonly primaryFailure: AnalysisError | undefined;

  constructor(
    message: string,
    options?: ErrorOptions & {
      readonly partialLaunch?: GhidraLaunch;
      readonly rollbackFailure?: GhidraLaunchRollbackFailure;
      readonly cleanupFailure?: AnalysisError;
      readonly primaryFailure?: AnalysisError;
      readonly capturedOutput?: AnalysisCapturedOutput;
      readonly launchSupport?: readonly GhidraLaunchSupportDiagnostic[];
    },
  ) {
    const {
      partialLaunch,
      capturedOutput,
      launchSupport,
      rollbackFailure,
      cleanupFailure,
      primaryFailure,
      ...errorOptions
    } = options ?? {};
    super(message, errorOptions);
    this.name = "GhidraLaunchError";
    this.#partialLaunch = partialLaunch;
    this.rollbackFailure = rollbackFailure;
    this.primaryFailure =
      primaryFailure ??
      (errorOptions.cause instanceof AnalysisError
        ? errorOptions.cause
        : errorOptions.cause instanceof GhidraLaunchError
          ? errorOptions.cause.primaryFailure
          : undefined);
    const inherited =
      errorOptions.cause instanceof DarwinProcessOwnershipInspectionError ||
      errorOptions.cause instanceof GhidraLaunchError
        ? errorOptions.cause.cleanupFailure
        : errorOptions.cause instanceof AnalysisError &&
            errorOptions.cause.cleanupIncomplete
          ? errorOptions.cause
          : undefined;
    this.cleanupFailure =
      cleanupFailure === undefined
        ? inherited
        : inherited === undefined || inherited === cleanupFailure
          ? cleanupFailure
          : analysisErrorWithCleanupFailure(
              inherited,
              cleanupFailure,
            ).bindCleanupDependencies([inherited, cleanupFailure]);
    const output =
      capturedOutput ??
      (errorOptions.cause instanceof DarwinProcessOwnershipInspectionError ||
      errorOptions.cause instanceof GhidraLaunchError
        ? errorOptions.cause.capturedOutput
        : undefined);
    this.#capturedOutput = output === undefined ? undefined : { ...output };
    this.launchSupport = (launchSupport ?? []).map((output) => ({ ...output }));
  }

  /** Process ownership retained for the client to retry an incomplete rollback. */
  get partialLaunch(): GhidraLaunch | undefined {
    return this.#partialLaunch;
  }

  /** Launcher command outcome retained when a launch command reported one. */
  get capturedOutput(): AnalysisCapturedOutput | undefined {
    return this.#capturedOutput === undefined
      ? undefined
      : { ...this.#capturedOutput };
  }
}

/**
 * Retain a failed launcher command's exit/signal and output in the shared
 * captured-output envelope. Bounds apply at projection; truncation there stays
 * explicit, matching the compiler-outcome diagnostics.
 */
const ghidraLaunchCommandOutput = (
  cause: unknown,
): AnalysisCapturedOutput | undefined => {
  if (cause instanceof DarwinProcessOwnershipInspectionError)
    return cause.capturedOutput;
  const failure = execFileOutputFailure(cause);
  if (failure === undefined) return undefined;
  return {
    stdout: failure.stdout,
    stderr: failure.stderr,
    truncated: failure.outputTruncated,
    ...(failure.stdoutBytes === undefined
      ? {}
      : { stdout_bytes: failure.stdoutBytes }),
    ...(failure.stderrBytes === undefined
      ? {}
      : { stderr_bytes: failure.stderrBytes }),
    exit_code: typeof failure.code === "number" ? failure.code : null,
    signal: failure.signal,
  };
};

/** Static coordinates for an extracted Ghidra release and packaged script. */
export interface GhidraHeadlessLauncherOptions {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly analyzeHeadlessPath: string;
  /** Release coordinate owned by installation inspection; null must not be guessed. */
  readonly configurationDirectoryName: string | null;
  readonly javaHome?: string;
  readonly javaVmName?: string;
  readonly bridgeScriptPath: string;
  readonly platform?: NodeJS.Platform;
  readonly comSpec?: string;
  /** Select the admitted 16-bit real-mode MZ import instead of auto-detection. */
  readonly dosMz?: true;
  readonly dosCom?: true;
  readonly rawBinary?: {
    readonly languageId: string;
    readonly compilerSpecId: string;
    readonly baseAddr: string;
  };
  /** Explicit import language committed by the analysis profile. */
  readonly languageOverride?: GhidraLanguageOverride;
  /** Auto-analyzers disabled before default auto-analysis, as configured. */
  readonly disabledAnalyzers?: readonly string[];
  /** Caller seeds committed by the analysis profile, applied before analysis. */
  readonly analysisSeeds?: GhidraSeedCommitment;
  readonly analysisExtensions?: readonly GhidraExtension[];
  readonly pspExtension?: GhidraPspExtension;
  /** Remap typed float storage for the soft-float o32 ABI after analysis. */
  readonly mipsSoftFloat?: true;
  /** Spawn seam for provider-boundary lifecycle tests. */
  readonly spawnProcess?: typeof spawnOwnedProviderProcess;
  /** LaunchSupport probe seam for Java-free launcher fixtures. */
  readonly javaLaunch?: typeof ghidraJavaLaunch;
}

interface LaunchContext {
  readonly session: GhidraLaunchSession;
  readonly paths: ReturnType<typeof ghidraRuntimePaths>;
  readonly platform: NodeJS.Platform;
  readonly launchSupport: GhidraLaunchSupportDiagnostic[];
  readonly signal: AbortSignal | undefined;
  readonly resourceScope: ArtifactResourceScope | undefined;
}

interface PreparedAnalysisInputs {
  readonly seedPath?: string;
  readonly extensions: readonly GhidraExtension[];
  readonly cache?: GhidraAnalysisCache;
}

/** Launch Ghidra without copying scripts into or modifying its installation. */
export class GhidraHeadlessLauncher implements GhidraLauncher {
  readonly options: GhidraHeadlessLauncherOptions;
  constructor(options: GhidraHeadlessLauncherOptions) {
    this.options = {
      ...options,
      environment: snapshotEnvironment(options.environment, options.platform),
    };
  }

  async launch(
    session: GhidraLaunchSession,
    options: {
      readonly signal?: AbortSignal;
      readonly resourceScope?: ArtifactResourceScope;
    } = {},
  ): Promise<Result<GhidraLaunch, GhidraLaunchError | AnalysisCancelledError>> {
    if (isAborted(options.signal))
      return err(
        new AnalysisCancelledError("open_binary", {
          cause: options.signal?.reason,
        }),
      );

    const context: LaunchContext = {
      session,
      paths: ghidraRuntimePaths(session.runtimeRoot),
      platform: this.options.platform ?? process.platform,
      launchSupport: [],
      signal: options.signal,
      resourceScope: options.resourceScope,
    };
    let started: SpawnedOwnedProviderProcess | undefined;
    let configuredMaxHeap: string | undefined;

    try {
      await this.validatePsp(context);
      const arguments_ = await this.prepareArguments(context);
      const command = await this.inspectCommand(context, arguments_);
      configuredMaxHeap = command.configuredMaxHeap;
      started = await this.spawn(context, command);
      await this.writeOwnership(context, started, command.command);
      if (isAborted(options.signal))
        throw new AnalysisCancelledError("open_binary", {
          cause: options.signal?.reason,
        });

      return ok(
        ownedGhidraLaunch(
          started,
          context.paths,
          context.platform,
          context.launchSupport,
          configuredMaxHeap,
        ),
      );
    } catch (cause: unknown) {
      return this.rollbackFailure(context, cause, started, configuredMaxHeap);
    }
  }

  private async validatePsp(context: LaunchContext): Promise<void> {
    const psp = this.options.pspExtension;
    if (psp !== undefined) {
      const installedRoot = await realpath(
        join(
          dirname(this.options.analyzeHeadlessPath),
          "..",
          "Ghidra",
          "Extensions",
          "ghidra-allegrex",
        ),
      );
      if (installedRoot !== psp.root)
        throw new GhidraLaunchError(
          "Allegrex profile does not belong to the selected Ghidra installation.",
        );
      if (context.resourceScope === undefined)
        throw new GhidraLaunchError(
          "PSP inspection requires a caller-owned resource scope.",
        );
      const inspected = await inspectGhidraPspExtension(
        psp.root,
        psp.ghidra_version,
        context.resourceScope,
        context.signal,
      );
      if (inspected.sha256 !== psp.sha256)
        throw new GhidraLaunchError(
          "Installed Allegrex content changed since profile resolution; reopen the target to resolve a fresh profile.",
        );
    }
  }

  private async prepareArguments(
    context: LaunchContext,
  ): Promise<readonly string[]> {
    await this.prepareRuntime(context);
    const inputs = await this.snapshotAnalysisInputs(context);
    const options = this.buildHeadlessOptions(context, inputs);
    await this.writeSessionDescriptor(context, inputs.extensions, options);

    return ghidraHeadlessArguments(options);
  }

  private async prepareRuntime(context: LaunchContext): Promise<void> {
    const { paths, platform } = context;
    if (this.options.configurationDirectoryName === null)
      throw new GhidraLaunchError(
        "Ghidra configuration directory identity is unresolved; restore application.version and application.release.name in the selected installation's application.properties.",
      );
    await createGhidraRuntimeDirectories(
      paths,
      platform,
      this.options.configurationDirectoryName,
    );
  }

  private async snapshotAnalysisInputs(
    context: LaunchContext,
  ): Promise<PreparedAnalysisInputs> {
    const { session, signal, resourceScope } = context;
    let seedPath: string | undefined;
    let extensions: readonly GhidraExtension[] = [];
    if (
      this.options.analysisSeeds !== undefined ||
      (this.options.analysisExtensions?.length ?? 0) > 0
    ) {
      if (resourceScope === undefined)
        throw new GhidraLaunchError(
          "Configured Ghidra artifacts require a caller-owned resource scope.",
        );
      if (this.options.analysisSeeds !== undefined)
        seedPath = await snapshotGhidraAnalysisSeeds(
          this.options.analysisSeeds,
          session.runtimeRoot,
          resourceScope,
          signal,
        );
      extensions = await snapshotGhidraExtensions(
        this.options.analysisExtensions ?? [],
        session.runtimeRoot,
        resourceScope,
        signal,
      );
    }
    if (isAborted(signal))
      throw new AnalysisCancelledError("open_binary", {
        cause: signal?.reason,
      });

    const cache = await prepareGhidraAnalysisCache(
      session,
      this.options,
      signal,
    );

    return {
      ...(seedPath === undefined ? {} : { seedPath }),
      extensions,
      ...(cache === undefined ? {} : { cache }),
    };
  }

  private buildHeadlessOptions(
    context: LaunchContext,
    inputs: PreparedAnalysisInputs,
  ): GhidraHeadlessArgumentOptions {
    const { session, paths, platform } = context;
    return {
      ...(inputs.cache === undefined ? {} : { analysisCache: inputs.cache }),
      platform,
      ...(this.options.pspExtension === undefined
        ? {}
        : { psp: true as const }),
      ...(this.options.mipsSoftFloat === undefined
        ? {}
        : { mipsSoftFloat: this.options.mipsSoftFloat }),
      projectRoot: paths.projectRoot,
      targetPath: session.targetPath,
      bridgeScriptPath: this.options.bridgeScriptPath,
      descriptorPath: paths.descriptorPath,
      ghidraLogPath: paths.ghidraLogPath,
      scriptLogPath: paths.scriptLogPath,
      ...(this.options.dosCom === undefined
        ? {}
        : { dosCom: this.options.dosCom }),
      ...(this.options.dosMz === undefined
        ? {}
        : { dosMz: this.options.dosMz }),
      ...(this.options.rawBinary === undefined
        ? {}
        : { rawBinary: this.options.rawBinary }),
      ...(this.options.languageOverride === undefined
        ? {}
        : { languageOverride: this.options.languageOverride }),
      ...(inputs.seedPath === undefined ? {} : { seedPath: inputs.seedPath }),
      ...(this.options.disabledAnalyzers === undefined
        ? {}
        : { disabledAnalyzers: this.options.disabledAnalyzers }),
    };
  }

  private async writeSessionDescriptor(
    context: LaunchContext,
    extensions: readonly GhidraExtension[],
    headlessOptions: GhidraHeadlessArgumentOptions,
  ): Promise<void> {
    const { session, paths, platform } = context;
    const analysis = ghidraAnalysisPlan(headlessOptions);
    await writeGhidraRuntimeFile(
      paths.descriptorPath,
      `${JSON.stringify({
        transport: session.transport,
        endpoint_path: session.endpointPath,
        token: session.token,
        run_id: session.runId,
        target_sha256: session.targetSha256,
        provider_version: session.providerVersion,
        profile_digest: session.profileDigest,
        analysis: {
          required: analysis.required,
          post_scripts: analysis.postAnalysisScripts.map((script) => ({
            name: script.name,
            arguments: script.arguments,
          })),
        },
        ...(extensions.length === 0 ? {} : { analysis_extensions: extensions }),
      })}\n`,
      platform,
    );
  }

  private async inspectCommand(
    context: LaunchContext,
    headlessArguments: readonly string[],
  ): Promise<Awaited<ReturnType<typeof ghidraJavaLaunch>>> {
    const { paths, platform, signal } = context;
    const scriptCommand = ghidraHeadlessCommand({
      environment: this.options.environment,
      platform,
      analyzeHeadlessPath: this.options.analyzeHeadlessPath,
      arguments: headlessArguments,
      ...(this.options.comSpec === undefined
        ? {}
        : { comSpec: this.options.comSpec }),
    });
    const environment = ghidraLaunchEnvironment(
      paths,
      this.options.javaHome,
      platform,
      scriptCommand.command,
      this.options.environment,
    );
    if (platform !== "win32" && this.options.javaHome === undefined)
      throw new GhidraLaunchError(
        "POSIX Ghidra requires its inspected JDK home",
      );
    const inspectedJavaLaunch = await (
      this.options.javaLaunch ?? ghidraJavaLaunch
    )({
      platform,
      analyzeHeadlessPath: this.options.analyzeHeadlessPath,
      ...(this.options.javaHome === undefined
        ? {}
        : { javaHome: this.options.javaHome }),
      ...(this.options.javaVmName === undefined
        ? {}
        : { javaVmName: this.options.javaVmName }),
      homeRoot: paths.homeRoot,
      tempRoot: paths.tempRoot,
      arguments: headlessArguments,
      environment,
      onStderr: (mode, stderr) =>
        this.captureLaunchSupport(context, mode, stderr),
      ...(signal === undefined ? {} : { signal: signal }),
    });
    return platform === "win32"
      ? { ...scriptCommand, environment }
      : inspectedJavaLaunch;
  }

  private async spawn(
    context: LaunchContext,
    command: Awaited<ReturnType<typeof ghidraJavaLaunch>>,
  ): Promise<SpawnedOwnedProviderProcess> {
    const { session, platform, signal } = context;
    return await (this.options.spawnProcess ?? spawnOwnedProviderProcess)({
      command: command.command,
      arguments: command.arguments,
      runId: session.runId,
      // POSIX launches the inspected JVM directly; script wrappers cannot
      // preserve JVM property paths containing spaces as single arguments.
      expectedCommand: platform !== "win32" ? command.command : null,
      windowsVerbatimArguments: platform === "win32",
      platform,
      env: command.environment,
      hostEnvironment: {},
      ...(signal === undefined ? {} : { signal: signal }),
    }).catch((cause: unknown) => {
      // The spawn boundary throws the exact opaque reason at preparation
      // checkpoints. Wrap it before interpreting any typed provider facts.
      if (signal?.aborted === true && cause === signal.reason)
        throw new AnalysisCancelledError("open_binary", { cause });
      throw cause;
    });
  }

  private captureLaunchSupport(
    context: LaunchContext,
    mode: GhidraLaunchSupportDiagnostic["mode"],
    stderr: string,
  ): void {
    if (stderr === "") return;

    const bytes = Buffer.byteLength(stderr);
    const redacted = redactCapturedTransportCredential(
      { text: stderr, bytes, observedBytes: bytes },
      context.session.token,
      "[REDACTED]",
    );
    const bounded = boundedUtf8Text(
      redacted,
      GHIDRA_LAUNCH_COMMAND_OUTPUT_BYTES,
    );
    context.launchSupport.push({
      mode,
      stderr: bounded.text,
      stderr_bytes: bytes,
      stderr_truncated: bounded.truncated,
    });
  }

  private async writeOwnership(
    context: LaunchContext,
    started: SpawnedOwnedProviderProcess,
    command: string,
  ): Promise<void> {
    const { session, paths, platform } = context;
    await writeGhidraRuntimeFile(
      paths.ownershipPath,
      `${JSON.stringify({
        run_id: session.runId,
        transport: session.transport,
        endpoint_path: session.endpointPath,
        pid: started.ownership.leaderPid,
        process_group_id: started.ownership.processGroupId,
        parent_pid: process.pid,
        ownership_kind:
          platform === "win32" ? "windows-job-object" : "posix-process-group",
        launcher: command,
        headless_script: this.options.analyzeHeadlessPath,
        created_at: new Date().toISOString(),
      })}\n`,
      platform,
    );
  }

  private describeLaunchFailure(
    context: LaunchContext,
    cause: unknown,
  ): GhidraLaunchError {
    const { launchSupport } = context;
    const cancellation =
      cause instanceof AnalysisCancelledError
        ? cause
        : (cause instanceof GhidraLaunchSupportError ||
              cause instanceof DarwinProcessOwnershipInspectionError) &&
            cause.cancellation !== undefined
          ? new AnalysisCancelledError("open_binary", {
              cause: cause.cancellation.reason,
            })
          : undefined;
    const capturedOutput = ghidraLaunchCommandOutput(cause);
    return new GhidraLaunchError("Ghidra headless launch failed", {
      cause,
      ...(cancellation === undefined ? {} : { primaryFailure: cancellation }),
      launchSupport,
      ...(capturedOutput === undefined ? {} : { capturedOutput }),
    });
  }

  private async rollbackFailure(
    context: LaunchContext,
    cause: unknown,
    started: SpawnedOwnedProviderProcess | undefined,
    configuredMaxHeap: string | undefined,
  ): Promise<Result<GhidraLaunch, GhidraLaunchError>> {
    const failure = this.describeLaunchFailure(context, cause);
    if (started === undefined) return err(failure);

    const rollback = await this.cleanupFailedLaunch(started, context.platform);
    if (rollback.ok) return err(failure);

    const partialLaunch = ownedGhidraLaunch(
      started,
      context.paths,
      context.platform,
      context.launchSupport,
      configuredMaxHeap,
    );
    const primaryMessage =
      failure.primaryFailure?.message ??
      `Ghidra headless launch failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    return err(
      new GhidraLaunchError(
        `${primaryMessage}; process cleanup remains incomplete`,
        {
          cause: new AggregateError(
            [
              failure,
              rollback.error.kind === "rejected"
                ? rollback.error.cause
                : rollback.error.result,
            ],
            "Ghidra launch rollback did not release its process",
            { cause: failure },
          ),
          partialLaunch,
          rollbackFailure: rollback.error,
          ...(failure.primaryFailure === undefined
            ? {}
            : { primaryFailure: failure.primaryFailure }),
          ...(failure.cleanupFailure === undefined
            ? {}
            : { cleanupFailure: failure.cleanupFailure }),
          ...(failure.capturedOutput === undefined
            ? {}
            : { capturedOutput: failure.capturedOutput }),
          launchSupport: context.launchSupport,
        },
      ),
    );
  }

  private async cleanupFailedLaunch(
    started: SpawnedOwnedProviderProcess,
    platform: NodeJS.Platform,
  ): Promise<Result<null, GhidraLaunchRollbackFailure>> {
    try {
      const result = await cleanupStartedProcess(started, platform);
      return result.cleaned ? ok(null) : err({ kind: "incomplete", result });
    } catch (cause: unknown) {
      return err({ kind: "rejected", cause });
    }
  }
}

const ownedGhidraLaunch = (
  spawned: SpawnedOwnedProviderProcess,
  paths: ReturnType<typeof ghidraRuntimePaths>,
  platform: NodeJS.Platform,
  launchSupport: readonly GhidraLaunchSupportDiagnostic[],
  configuredMaxHeap?: string,
): GhidraLaunch => ({
  ...ownedGhidraProcess(spawned, platform),
  projectRoot: paths.projectRoot,
  ghidraLogPath: paths.ghidraLogPath,
  scriptLogPath: paths.scriptLogPath,
  ...(configuredMaxHeap === undefined ? {} : { configuredMaxHeap }),
  ...(launchSupport.length === 0 ? {} : { launchSupport: [...launchSupport] }),
});

const ownedGhidraProcess = (
  spawned: SpawnedOwnedProviderProcess,
  platform: NodeJS.Platform,
): Pick<
  Extract<ProviderProcessLaunch, { readonly ownsProcessLifetime: true }>,
  "process" | "ownsProcessLifetime" | "ownership" | "cleanup"
> => ({
  process: spawned.process,
  ownsProcessLifetime: true,
  ownership: spawned.ownership,
  cleanup: () => cleanupStartedProcess(spawned, platform),
});

/** Exact executable and argv passed to shell-free process creation. */
export interface GhidraHeadlessCommand {
  readonly command: string;
  readonly arguments: readonly string[];
}

/** Build a direct POSIX launch or a conservatively quoted Windows batch call. */
export const ghidraHeadlessCommand = (options: {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly platform: NodeJS.Platform;
  readonly analyzeHeadlessPath: string;
  readonly arguments: readonly string[];
  readonly comSpec?: string;
}): GhidraHeadlessCommand => {
  if (options.platform !== "win32")
    return {
      command: options.analyzeHeadlessPath,
      arguments: [...options.arguments],
    };
  const command = ghidraBatchStep(() =>
    windowsBatchCommand({
      environment: options.environment,
      batchPath: options.analyzeHeadlessPath,
      arguments: options.arguments,
      ...(options.comSpec === undefined ? {} : { comSpec: options.comSpec }),
    }),
  );
  if ((command.arguments.at(-1)?.length ?? 0) > 30_000)
    throw new GhidraLaunchError(
      "Windows Ghidra command exceeds the P0 length limit",
    );
  return command;
};

/** Keep Ghidra's launch error type and P0 wording for shared batch checks. */
const ghidraBatchStep = <T>(step: () => T): T => {
  try {
    return step();
  } catch (cause: unknown) {
    if (!(cause instanceof WindowsBatchCommandError)) throw cause;
    throw new GhidraLaunchError(
      cause.reason === "metacharacter"
        ? "Windows Ghidra P0 paths cannot contain command-interpreter metacharacters"
        : cause.message,
      { cause },
    );
  }
};

const cleanupStartedProcess = (
  started: SpawnedOwnedProviderProcess,
  platform: NodeJS.Platform,
): Promise<ProcessCleanupResult> =>
  started.cleanup !== undefined
    ? started.cleanup()
    : platform === "win32"
      ? cleanupWindowsProcessTree(started.ownership.leaderPid)
      : cleanupOwnedProcessGroup(started.ownership);

const ghidraRuntimePaths = (runtimeRoot: string) => ({
  projectRoot: join(runtimeRoot, "project"),
  homeRoot: join(runtimeRoot, "home"),
  tempRoot: join(runtimeRoot, "tmp"),
  cacheRoot: join(runtimeRoot, "cache"),
  configRoot: join(runtimeRoot, "config"),
  dataRoot: join(runtimeRoot, "data"),
  descriptorPath: join(runtimeRoot, "session.json"),
  ownershipPath: join(runtimeRoot, "ownership.json"),
  ghidraLogPath: join(runtimeRoot, "ghidra.log"),
  scriptLogPath: join(runtimeRoot, "script.log"),
});

/**
 * Ghidra's launch support resolves its JDK before the headless run and then
 * persists that choice under `<config>/ghidra/<release directory>`. Inside
 * REA's Windows private runtime a child JVM cannot create those directories
 * itself, so startup aborted with "Failed to create directory" and reported
 * that no supported JDK was found. Create the release directory while this
 * process still owns the runtime, leaving Ghidra only a file write inside it.
 */
const createGhidraRuntimeDirectories = async (
  paths: ReturnType<typeof ghidraRuntimePaths>,
  platform: NodeJS.Platform,
  configReleaseDirectory: string,
): Promise<void> => {
  if (platform === "win32") {
    const runtime = windowsPrivateRuntime(dirname(paths.projectRoot));
    for (const path of [
      paths.projectRoot,
      paths.homeRoot,
      paths.tempRoot,
      paths.cacheRoot,
      paths.configRoot,
      paths.dataRoot,
    ])
      runtime.mkdir(basename(path));
    // Each level needs its parent first: the native owner opens every existing
    // component and creates only the final one.
    const configRoot = basename(paths.configRoot);
    runtime.mkdir(win32.join(configRoot, "ghidra"));
    runtime.mkdir(win32.join(configRoot, "ghidra", configReleaseDirectory));
    return;
  }
  await Promise.all(
    [
      paths.projectRoot,
      paths.homeRoot,
      paths.tempRoot,
      paths.cacheRoot,
      paths.configRoot,
      paths.dataRoot,
      join(paths.configRoot, "ghidra", configReleaseDirectory),
    ].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
};

const writeGhidraRuntimeFile = async (
  path: string,
  content: string,
  platform: NodeJS.Platform,
): Promise<void> => {
  if (platform === "win32") {
    windowsPrivateRuntime(dirname(path)).writeFile(basename(path), content);
    return;
  }
  await writeFileAtomic(path, content, { encoding: "utf8", mode: 0o600 });
};

const ghidraLaunchEnvironment = (
  paths: ReturnType<typeof ghidraRuntimePaths>,
  javaHome: string | undefined,
  platform: NodeJS.Platform,
  executable: string,
  selectedEnvironment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv => {
  return {
    ...ghidraJavaEnvironment(javaHome, selectedEnvironment, platform),
    ...ghidraHeadlessJavaOptions(paths.homeRoot, paths.tempRoot, platform),
    HOME: paths.homeRoot,
    TMPDIR: paths.tempRoot,
    ...(platform === "win32"
      ? {
          // Batch FOR /F launches another command interpreter through ComSpec.
          // Use the same executable with the spelling consumed by cmd.exe.
          ComSpec: executable.replaceAll("/", "\\"),
          USERPROFILE: paths.homeRoot,
          APPDATA: paths.configRoot,
          LOCALAPPDATA: paths.cacheRoot,
          TEMP: paths.tempRoot,
          TMP: paths.tempRoot,
        }
      : {}),
    XDG_CACHE_HOME: paths.cacheRoot,
    XDG_CONFIG_HOME: paths.configRoot,
    XDG_DATA_HOME: paths.dataRoot,
  };
};

/** Encode provider-owned JVM paths for the platform launcher that consumes them. */
export const ghidraHeadlessJavaOptions = (
  homeRoot: string,
  tempRoot: string,
  platform: NodeJS.Platform,
): Pick<
  NodeJS.ProcessEnv,
  "JDK_JAVA_OPTIONS" | "GHIDRA_HEADLESS_JAVA_OPTIONS"
> => {
  const options = [`-Duser.home=${homeRoot}`, `-Djava.io.tmpdir=${tempRoot}`];
  if (platform === "win32")
    return {
      JDK_JAVA_OPTIONS: [...options, "-XX:-UsePerfData"]
        .map((option) => ghidraBatchStep(() => quoteWindowsBatchToken(option)))
        .join(" "),
      GHIDRA_HEADLESS_JAVA_OPTIONS: "",
    };
  // POSIX launches the JVM directly, so these properties travel as separate
  // argv items instead of the shell-split analyzeHeadless option list.
  return { JDK_JAVA_OPTIONS: "", GHIDRA_HEADLESS_JAVA_OPTIONS: "" };
};

const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;
