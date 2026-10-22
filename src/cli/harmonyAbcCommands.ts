import { z } from "incur";
import { HarmonyAbcAnalysisService } from "../application/harmony/HarmonyAbcAnalysisService.js";
import { createHarmonyAbcAnalysisProvider } from "../composition/harmonyAbc.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { harmonyAbcInputSchemas } from "../domain/harmony/harmonyAbcAnalysis.js";
import type { HarmonyAbcOperation } from "../domain/harmony/harmonyAbcAnalysis.js";
import { localPathStringSchema } from "../domain/localPath.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

/** One-shot HarmonyOS Ark bytecode CLI commands backed by the same workflows as MCP. */
export const registerHarmonyAbcCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  const service = new HarmonyAbcAnalysisService(
    createHarmonyAbcAnalysisProvider(environment),
  );
  const path = localPathStringSchema.describe(
    "Local HarmonyOS Ark bytecode (.abc) path; parsed, never executed",
  );
  const execute = (
    name: string,
    operation: HarmonyAbcOperation,
    input: unknown,
  ) =>
    withCommandCancellation((signal) =>
      logCliCommand(logger, name, () =>
        finishAnalysisCommand(
          () => service.execute(operation, input, { signal }),
          service,
          "xpanda",
          operation,
          signal,
        ),
      ),
    );
  const input = harmonyAbcInputSchemas;
  const analysisTimeout = () => ({
    analysisTimeoutMs: input.inspect_harmony_abc.shape.analysis_timeout_ms,
  });
  cli.command(CLI_COMMANDS.inspectHarmonyAbc, {
    description: "Inspect a HarmonyOS .abc file header with xpanda",
    args: z.object({ path }),
    options: z.object(analysisTimeout()),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.inspectHarmonyAbc, "inspect_harmony_abc", {
        path: absoluteCallerPath(args.path),
        ...(options.analysisTimeoutMs === undefined
          ? {}
          : { analysis_timeout_ms: options.analysisTimeoutMs }),
      }),
  });
  const classListOptions = input.list_harmony_abc_classes.shape;
  cli.command(CLI_COMMANDS.listHarmonyAbcClasses, {
    description: "List demangled classes of a HarmonyOS .abc file",
    args: z.object({ path }),
    options: z.object({
      filter: classListOptions.filter,
      offset: classListOptions.offset,
      limit: classListOptions.limit,
      ...analysisTimeout(),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.listHarmonyAbcClasses, "list_harmony_abc_classes", {
        path: absoluteCallerPath(args.path),
        ...(options.filter === undefined ? {} : { filter: options.filter }),
        offset: options.offset,
        limit: options.limit,
        ...(options.analysisTimeoutMs === undefined
          ? {}
          : { analysis_timeout_ms: options.analysisTimeoutMs }),
      }),
  });
  const decompileClassOptions = input.decompile_harmony_abc_class.shape;
  cli.command(CLI_COMMANDS.decompileHarmonyAbcClass, {
    description: "Decompile one class of a HarmonyOS .abc file inline",
    args: z.object({ path, className: decompileClassOptions.class_name }),
    options: z.object({
      raw: z
        .boolean()
        .optional()
        .describe("Skip the producer optimizer pipeline (default runs it)"),
      ...analysisTimeout(),
    }),
    run: ({ args, options }) =>
      execute(
        CLI_COMMANDS.decompileHarmonyAbcClass,
        "decompile_harmony_abc_class",
        {
          path: absoluteCallerPath(args.path),
          class_name: args.className,
          simplify: options.raw !== true,
          ...(options.analysisTimeoutMs === undefined
            ? {}
            : { analysis_timeout_ms: options.analysisTimeoutMs }),
        },
      ),
  });
  const decompileOptions = input.decompile_harmony_abc.shape;
  cli.command(CLI_COMMANDS.decompileHarmonyAbc, {
    description:
      "Decompile every class of a HarmonyOS .abc file into an absent output directory",
    args: z.object({
      path,
      outputDirectory: decompileOptions.output_directory,
    }),
    options: z.object({
      raw: z
        .boolean()
        .optional()
        .describe("Skip the producer optimizer pipeline (default runs it)"),
      ...analysisTimeout(),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.decompileHarmonyAbc, "decompile_harmony_abc", {
        path: absoluteCallerPath(args.path),
        output_directory: absoluteCallerPath(args.outputDirectory),
        simplify: options.raw !== true,
        ...(options.analysisTimeoutMs === undefined
          ? {}
          : { analysis_timeout_ms: options.analysisTimeoutMs }),
      }),
  });
  const disassembleOptions = input.disassemble_harmony_abc_method.shape;
  cli.command(CLI_COMMANDS.disassembleHarmonyAbcMethod, {
    description: "Disassemble one method of a HarmonyOS .abc file",
    args: z.object({ path, className: disassembleOptions.class_name }),
    options: z.object({
      methodName: disassembleOptions.method_name,
      maxInstructions: disassembleOptions.max_instructions,
      ...analysisTimeout(),
    }),
    run: ({ args, options }) =>
      execute(
        CLI_COMMANDS.disassembleHarmonyAbcMethod,
        "disassemble_harmony_abc_method",
        {
          path: absoluteCallerPath(args.path),
          class_name: args.className,
          ...(options.methodName === undefined
            ? {}
            : { method_name: options.methodName }),
          max_instructions: options.maxInstructions,
          ...(options.analysisTimeoutMs === undefined
            ? {}
            : { analysis_timeout_ms: options.analysisTimeoutMs }),
        },
      ),
  });
  const stringsOptions = input.search_harmony_abc_strings.shape;
  cli.command(CLI_COMMANDS.searchHarmonyAbcStrings, {
    description: "Search the string pool of a HarmonyOS .abc file",
    args: z.object({ path, pattern: stringsOptions.pattern }),
    options: z.object({
      regex: z
        .boolean()
        .optional()
        .describe("Interpret pattern as a regular expression"),
      offset: stringsOptions.offset,
      limit: stringsOptions.limit,
      ...analysisTimeout(),
    }),
    run: ({ args, options }) =>
      execute(
        CLI_COMMANDS.searchHarmonyAbcStrings,
        "search_harmony_abc_strings",
        {
          path: absoluteCallerPath(args.path),
          pattern: args.pattern,
          regex: options.regex === true,
          offset: options.offset,
          limit: options.limit,
          ...(options.analysisTimeoutMs === undefined
            ? {}
            : { analysis_timeout_ms: options.analysisTimeoutMs }),
        },
      ),
  });
};
