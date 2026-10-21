import * as jose from "jose";
import { config } from "../config.js";

const secret = new TextEncoder().encode(config.jwtSecret);

export interface TokenPayload extends jose.JWTPayload {
  userId: number;
  email: string;
}

export interface VerifiedToken extends TokenPayload {
  /** JWT ID claim used for single-use refresh rotation. */
  jti: string;
}

// SEC-011: Short-lived JWTs with refresh rotation. Tokens expire in 1 hour;
// long-lived sessions are maintained via /auth/refresh which re-validates
// against the database before issuing a new token. Each token carries a
// unique jti claim that is checked against the sessions table on every
// authenticated request and rotated atomically on refresh, preventing
// replay of stolen tokens after rotation.
const JWT_EXPIRATION = "1h";

export async function signToken(
  payload: TokenPayload,
  jti: string,
): Promise<string> {
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRATION)
    .sign(secret);
}

export async function verifyToken(
  token: string,
): Promise<VerifiedToken | null> {
  try {
    const { payload } = await jose.jwtVerify(token, secret, {
      algorithms: ["HS256"],
    });
    // Validate claim types exactly like verifyTokenSignature: a valid
    // signature only proves the token was minted, not that its claims have
    // the shapes the session lookup requires. Fail closed, never cast.
    const claims = payload as unknown as Partial<TokenPayload> & {
      jti?: unknown;
    };
    if (
      typeof claims.userId !== "number" ||
      typeof claims.email !== "string" ||
      typeof claims.jti !== "string" ||
      !claims.jti
    ) {
      return null;
    }
    return { userId: claims.userId, email: claims.email, jti: claims.jti };
  } catch {
    return null;
  }
}

/**
 * Verifies the JWT signature and shape without enforcing `exp`.
 *
 * Used ONLY by the refresh endpoint: a token whose 1-hour JWT life has
 * elapsed is still eligible for rotation while its session row is alive.
 * Callers must enforce freshness themselves by matching `jti` against the
 * sessions table and checking the row's `expiresAt`. Never use this for
 * ordinary request authentication — that path must keep using verifyToken.
 */
export async function verifyTokenSignature(
  token: string,
): Promise<VerifiedToken | null> {
  try {
    const { payload, protectedHeader } = await jose.compactVerify(
      token,
      secret,
    );
    if (protectedHeader.alg !== "HS256") {
      return null;
    }
    const claims = JSON.parse(
      new TextDecoder().decode(payload),
    ) as Partial<TokenPayload> & { jti?: unknown };
    if (
      typeof claims.userId !== "number" ||
      typeof claims.email !== "string" ||
      typeof claims.jti !== "string" ||
      !claims.jti
    ) {
      return null;
    }
    return { userId: claims.userId, email: claims.email, jti: claims.jti };
  } catch {
    return null;
  }
}
