import { z } from "zod";

/** Canonical padded base64 with portable, stack-safe advertised constraints. */
export const canonicalBase64Schema = z
  .string()
  .regex(/^(?:....)*$/)
  .regex(/^[A-Za-z0-9+\x2f]*(?:[AQgw]==|[AEIMQUYcgkosw048]=)?$/)
  // JSON Schema's end anchor may precede a terminal newline. The byte contract
  // requires an exact quartet length, including every source character.
  .refine((value) => value.length % 4 === 0);
