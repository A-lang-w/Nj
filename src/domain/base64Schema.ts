import { z } from "zod";

/** Canonical padded base64 with portable, stack-safe advertised constraints. */
export const canonicalBase64Schema = z
  .string()
  .regex(/^(?:....)*$/)
  .regex(/^[A-Za-z0-9+\x2f]*(?:[AQgw]==|[AEIMQUYcgkosw048]=)?$/);
