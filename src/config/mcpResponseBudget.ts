import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

// This override supports clients with larger frames. Keep the configuration
// parser independent of the SDK's eager server imports; conformance verifies
// this floor against the pinned SDK's actual default receive-buffer size.
export const MINIMUM_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Facts for a completed or failed MCP result that exceeded the stdio receive
 * budget. The effective value is the configured receive buffer, including the
 * envelope reservation, not Node's separate string ceiling.
 */
export const stdioResponseBudgetRecovery = (
  effectiveResponseBytes: number,
  stringCeilingCodeUnits: number,
): string =>
  `The effective REA_MCP_MAX_RESPONSE_BYTES value is ${String(effectiveResponseBytes)} bytes (floor ${String(MINIMUM_RESPONSE_BYTES)} bytes, 10 MiB). A change requires restarting the REA process and a matching client receive buffer. It does not raise Node's separate single-string ceiling of ${String(stringCeilingCodeUnits)} UTF-16 code units, which has no runtime override.`;

/** Facts for the Node string ceiling. This setting is not REA_MCP_MAX_RESPONSE_BYTES. */
export const nodeStringCeilingRecovery = (
  stringCeilingCodeUnits: number,
): string =>
  `Node's single-string ceiling is ${String(stringCeilingCodeUnits)} UTF-16 code units. This release has no runtime override, and REA_MCP_MAX_RESPONSE_BYTES does not raise it.`;

/** Optional stdio response budget, including room for the protocol envelope. */
export const mcpResponseBudgetSchema = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .transform(Number)
  .pipe(z.number().int().safe().min(MINIMUM_RESPONSE_BYTES));

const budgetConstraint = `REA_MCP_MAX_RESPONSE_BYTES must be a decimal safe integer at least ${String(MINIMUM_RESPONSE_BYTES)} bytes, the default stdio receive-buffer size.`;

/** Parse only the MCP-specific budget without loading unrelated provider settings. */
export const parseMcpResponseBudget = (
  value: string | undefined,
): Result<number | undefined, ConfigurationError> => {
  if (value === undefined) return ok(undefined);
  const parsed = mcpResponseBudgetSchema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err(
        new ConfigurationError(budgetConstraint, {
          settings: [
            {
              setting: "REA_MCP_MAX_RESPONSE_BYTES",
              constraint: budgetConstraint,
            },
          ],
        }),
      );
};
