import { z } from "zod";
import { jsonValueSchema } from "./jsonValue.js";

/** Delivery selection is separate from the provider's live session lookup. */
export const fridaSessionStatusInputSchema = z.strictObject({
  session_id: z.string().uuid(),
  detail: z.enum(["complete", "summary"]).optional(),
});

/** Canonical facts owned by the Frida session observation workflow. */
export const fridaSessionStatusSchema = z.strictObject({
  session_id: z.string().uuid(),
  device_id: z.string(),
  state: z.enum(["paused", "running", "detached"]),
  target: z.string(),
  pid: z.number().int().nonnegative(),
  mode: z.enum(["attach", "spawn"]),
  scripts: z.array(
    z.strictObject({ script_id: z.string().uuid(), name: z.string() }),
  ),
  messages: z.array(jsonValueSchema),
  messages_truncated: z.boolean(),
});
