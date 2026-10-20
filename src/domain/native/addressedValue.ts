import { z } from "zod";

/** Provider-normalized addressed inventory facts, with optional source metadata. */
export const addressedValue = z.object({
  address: z.string(),
  value: z.string(),
  symbol: z
    .object({
      primary: z.boolean(),
      dynamic: z.boolean(),
      external: z.boolean(),
      type: z.string(),
      source: z.enum(["default", "analysis", "ai", "imported", "user_defined"]),
    })
    .optional(),
  procedure: z
    .object({
      external: z.boolean(),
      thunk: z.boolean(),
      thunk_target: z.string().nullable(),
    })
    .optional(),
  string: z
    .object({
      encoding: z.string(),
      termination: z.enum(["missing", "present_or_not_required"]),
      byte_length: z.number().int().min(0),
    })
    .optional(),
});
