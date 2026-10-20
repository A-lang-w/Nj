import { z } from "incur";
import { AndroidAnalysisService } from "../application/android/AndroidAnalysisService.js";
import { createAndroidAnalysisProvider } from "../composition/android.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { AndroidOperation } from "../domain/android/androidAnalysis.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

const path = z.string().describe("Local standalone APK path");
const className = z.string().describe("Exact fully qualified class name");
const classQuery = z
  .string()
  .describe("Case-sensitive class-name substring; empty lists all classes");
const backend = z
  .enum(["jadx", "asc"])
  .optional()
  .describe(
    "Android backend (default: jadx); asc currently supports class discovery only",
  );
const selection = (value: "jadx" | "asc" | undefined) =>
  value === undefined ? {} : { backend: value };

/** One shared owner provides cancellation and awaited cleanup for every command. */
const createExecutor = (
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
) => {
  const provider = createAndroidAnalysisProvider(environment);
  const service = new AndroidAnalysisService(provider);
  return (name: string, operation: AndroidOperation, input: unknown) =>
    withCommandCancellation((signal) =>
      logCliCommand(logger, name, () =>
        finishAnalysisCommand(
          () => service.execute(operation, input, { signal }),
          { close: () => provider.close() },
          "android",
          operation,
          signal,
        ),
      ),
    );
};

/** Expose the same explicit APK requests through one-shot CLI commands. */
export const registerAndroidCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  const execute = createExecutor(logger, environment);
  cli.command(CLI_COMMANDS.inspectAndroidPackage, {
    description:
      "Inspect APK declarations and decoded manifest without executing it",
    args: z.object({ path }),
    options: z.object({ backend }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.inspectAndroidPackage, "inspect_android_package", {
        ...args,
        ...selection(options.backend),
      }),
  });
  cli.command(CLI_COMMANDS.searchAndroidClasses, {
    description: "Search APK class names; empty query inventories all classes",
    args: z.object({ path, query: classQuery }),
    options: z.object({ backend }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.searchAndroidClasses, "search_android_classes", {
        ...args,
        ...selection(options.backend),
      }),
  });
  cli.command(CLI_COMMANDS.inspectAndroidClass, {
    description: "Inspect one exact APK class's member inventory",
    args: z.object({ path, className }),
    options: z.object({ backend }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.inspectAndroidClass, "inspect_android_class", {
        path: args.path,
        class_name: args.className,
        ...selection(options.backend),
      }),
  });
  cli.command(CLI_COMMANDS.inspectAndroidMethod, {
    description: "Decompile one APK method with explicit overload selection",
    args: z.object({
      path,
      className,
      methodName: z.string().describe("Exact declared method name"),
    }),
    options: z.object({
      backend,
      overloadIndex: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Explicit zero-based index among same-name methods; required when ambiguous",
        ),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.inspectAndroidMethod, "inspect_android_method", {
        path: args.path,
        class_name: args.className,
        method_name: args.methodName,
        ...selection(options.backend),
        ...(options.overloadIndex === undefined
          ? {}
          : { overload_index: options.overloadIndex }),
      }),
  });
  cli.command(CLI_COMMANDS.traceAndroidReferences, {
    description:
      "Trace incoming APK using nodes for a class or selected method",
    args: z.object({ path, className }),
    options: z.object({
      backend,
      methodName: z
        .string()
        .optional()
        .describe("Declared method name; omit for class references"),
      overloadIndex: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Index among same-name methods from inspect-android-class"),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.traceAndroidReferences, "trace_android_references", {
        path: args.path,
        class_name: args.className,
        ...selection(options.backend),
        ...(options.methodName === undefined
          ? {}
          : { method_name: options.methodName }),
        ...(options.overloadIndex === undefined
          ? {}
          : { overload_index: options.overloadIndex }),
      }),
  });
};
