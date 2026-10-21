import { describe, it, expect } from "vitest";
import * as jose from "jose";
import { signToken, verifyToken } from "../../src/auth/tokens.js";

// setup-env guarantees JWT_SECRET for the suite; reuse it to mint edge-case
// tokens with the same key the verifier uses.
const secret = new TextEncoder().encode(process.env.JWT_SECRET as string);

async function signRawClaims(claims: Record<string, unknown>): Promise<string> {
  return new jose.SignJWT(claims as jose.JWTPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);
}

describe("verifyToken claim validation", () => {
  it("accepts a properly minted token", async () => {
    const token = await signToken(
      { userId: 1, email: "test@test.com" },
      "tokens-test-jti-001",
    );
    expect(await verifyToken(token)).toEqual({
      userId: 1,
      email: "test@test.com",
      jti: "tokens-test-jti-001",
    });
  });

  it("rejects a token whose userId is not a number", async () => {
    const token = await signRawClaims({
      userId: "1",
      email: "test@test.com",
      jti: "tokens-test-jti-002",
    });
    expect(await verifyToken(token)).toBeNull();
  });

  it("rejects a token whose email is not a string", async () => {
    const token = await signRawClaims({
      userId: 1,
      email: 42,
      jti: "tokens-test-jti-003",
    });
    expect(await verifyToken(token)).toBeNull();
  });

  it("rejects a token with a missing jti", async () => {
    const token = await signRawClaims({ userId: 1, email: "test@test.com" });
    expect(await verifyToken(token)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const other = new TextEncoder().encode(
      "a-different-test-secret-with-enough-bytes-00",
    );
    const token = await new jose.SignJWT({ userId: 1, email: "test@test.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setJti("tokens-test-jti-005")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(other);
    expect(await verifyToken(token)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await new jose.SignJWT({ userId: 1, email: "test@test.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setJti("tokens-test-jti-006")
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(secret);
    expect(await verifyToken(token)).toBeNull();
  });
});
