import { describe, it, expect, vi, afterEach } from "vitest";
import { logger } from "../../src/lib/logger.js";
import { StorageError } from "../../src/lib/result.js";

describe("logger error redaction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves name, message, and tag for DomainError values", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    logger.error("op failed", {
      error: new StorageError("disk full on volume"),
    });

    expect(writes).toHaveLength(1);
    const entry = JSON.parse(writes[0]);
    expect(entry.message).toBe("op failed");
    expect(entry.error).toMatchObject({
      name: "StorageError",
      message: "disk full on volume",
      tag: "StorageError",
    });
  });

  it("preserves the redacted cause chain", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    const cause = new Error("provider said no: Bearer abcdefghij1234567890==");
    logger.error("upstream failed", {
      error: new Error("call failed", { cause }),
    });

    const entry = JSON.parse(writes[0]);
    expect(entry.error.message).toBe("call failed");
    expect(entry.error.cause.message).toContain("[REDACTED]");
    expect(entry.error.cause.message).not.toContain("Bearer abcdefghij");
  });

  it("redacts secrets inside error messages", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    logger.error("provider call failed", {
      error: new Error("auth rejected sk-abcdefghijklmnopqrstuvwxyzz012"),
    });

    const entry = JSON.parse(writes[0]);
    expect(entry.error.message).toContain("[REDACTED]");
    expect(entry.error.message).not.toContain("sk-abcdef");
    expect(entry.error.tag).toBeUndefined();
  });

  it("redacts api_key assignments and X-API-Key headers", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    const queryValue = "Q".repeat(32);
    const headerValue = "a".repeat(32);
    logger.error("upstream 401", {
      error: new Error(
        `query had api_key=${queryValue} and X-API-Key: ${headerValue}`,
      ),
    });

    const entry = JSON.parse(writes[0]);
    expect(entry.error.message).toContain("[REDACTED]");
    expect(entry.error.message).not.toContain(queryValue);
    expect(entry.error.message).not.toContain(headerValue);
  });

  it("redacts secrets interpolated into the log message", () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const jwt = `eyJ${"Q".repeat(10)}.${"a".repeat(12)}.${"Z".repeat(10)}`;
    logger.info(`refresh failed for ${jwt}`);

    const entry = JSON.parse(writes[0]);
    expect(entry.message).toContain("[REDACTED]");
    expect(entry.message).not.toContain(jwt);
  });

  it("redacts standalone JWTs", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    const jwt = `eyJ${"Q".repeat(10)}.${"a".repeat(12)}.${"Z".repeat(10)}`;
    logger.error("session lookup failed", {
      error: new Error(`token was ${jwt}`),
    });

    const entry = JSON.parse(writes[0]);
    expect(entry.error.message).toContain("[REDACTED]");
    expect(entry.error.message).not.toContain(jwt);
  });
});
