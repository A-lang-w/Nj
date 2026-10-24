import { z } from "incur";
import {
  readGuidanceSection,
  searchGuidance,
} from "../application/GuidanceAccess.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";

/** Register offline search and retrieval for the installed REA guide bundle. */
export const registerGuidanceCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.guidance, {
    description: "Search or read the installed REA workflow guidance",
    args: z.object({}),
    options: z.object({
      action: z.enum(["search", "read"]).default("search"),
      query: z.string().optional().describe("Analyst question to search for"),
      locator: z
        .string()
        .optional()
        .describe("Section locator returned by search"),
      limit: z.number().int().min(1).max(20).default(8),
      cursor: z
        .string()
        .optional()
        .describe("Continuation token returned by search"),
    }),
    run: ({ options }) =>
      logCliCommand(logger, CLI_COMMANDS.guidance, async () => {
        const result =
          options.action === "search"
            ? await searchGuidance({
                query: options.query,
                limit: options.limit,
                ...(options.cursor === undefined
                  ? {}
                  : { cursor: options.cursor }),
                ...(options.locator === undefined
                  ? {}
                  : { locator: options.locator }),
              })
            : await readGuidanceSection({
                locator: options.locator,
                ...(options.query === undefined
                  ? {}
                  : { query: options.query }),
                ...(options.cursor === undefined
                  ? {}
                  : { cursor: options.cursor }),
              });
        return result.ok ? result.value : projectAnalysisError(result.error);
      }),
  });
};
