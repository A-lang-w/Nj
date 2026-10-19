import { compareWasmInterfaces } from "../application/wasm/WasmInterfaceComparisonService.js";
import { parseCliJsonInput } from "../cliJsonInput.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { z } from "incur";
import { wasmArtifactModule } from "../composition/wasm.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

/** Resolve all caller-selected artifact paths through the shared workflow. */
export const registerWasmCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  cli.command(CLI_COMMANDS.compareWasmInterfaces, {
    description:
      "Compare core WASM interfaces from two exact inspection Evidence records",
    args: z.object({
      input: z
        .string()
        .describe(
          "Inline JSON or input file containing left/right complete Evidence and required scope",
        ),
    }),
    run: ({ args }) =>
      withCommandCancellation(async (signal) =>
        logCliCommand(logger, CLI_COMMANDS.compareWasmInterfaces, async () => {
          const input = await parseCliJsonInput(
            args.input,
            "compare_wasm_interfaces",
          );
          if (!input.ok) return input.error;
          const result = await compareWasmInterfaces(input.value, { signal });
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
  const service = wasmArtifactModule.create(environment);
  cli.command(wasmArtifactModule.cliCommand, {
    description: "Inspect an explicit local WASM artifact with WABT",
    args: z.object({
      path: z.string().describe("Local WASM artifact"),
    }),
    options: z.object({
      glue_paths: z
        .array(z.string())
        .optional()
        .describe("Selected local JavaScript glue paths"),
      candidate_paths: z
        .array(z.string())
        .optional()
        .describe("Explicit local WASM candidates"),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, wasmArtifactModule.cliCommand, () =>
          finishAnalysisCommand(
            () =>
              service.inspect(
                {
                  path: absoluteCallerPath(args.path),
                  glue_paths: options.glue_paths?.map((path) =>
                    absoluteCallerPath(path),
                  ),
                  candidate_paths: options.candidate_paths?.map((path) =>
                    absoluteCallerPath(path),
                  ),
                },
                { signal },
              ),
            service,
            "wabt-artifact",
            "inspect_wasm_artifact",
            signal,
          ),
        ),
      ),
  });
  cli.command(CLI_COMMANDS.inspectWasmComponent, {
    description:
      "Decode an explicit local WebAssembly component without executing it",
    args: z.object({
      path: z.string().describe("Local WebAssembly component"),
    }),
    run: ({ args }) =>
      withCommandCancellation(async (signal) => {
        // The decoder and its result schema load only when this command runs.
        const { createWasmComponentService } =
          await import("../composition/wasmComponent.js");
        const service = createWasmComponentService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectWasmComponent,
          async () =>
            finishAnalysisCommand(
              () =>
                service.inspect(
                  { path: absoluteCallerPath(args.path) },
                  { signal },
                ),
              service,
              "wasm-component-binary",
              "inspect_wasm_component",
              signal,
            ),
        );
      }),
  });
};
