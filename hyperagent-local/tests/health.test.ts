import { describe, it, expect } from "vitest";
import { Hono } from "hono";

// Build a minimal app with just the health endpoint for isolated testing
function buildHealthApp() {
  const app = new Hono();
  app.get("/api/health", (c) =>
    c.json({ status: "ok", timestamp: new Date().toISOString() }),
  );
  return app;
}

describe("health", () => {
  const app = buildHealthApp();

  it("health endpoint returns ok", async () => {
    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string; timestamp: string };
    expect(data.status).toBe("ok");
    expect(data.timestamp).toBeDefined();
    // Verify timestamp is a valid ISO date string
    expect(() => new Date(data.timestamp)).not.toThrow();
    expect(new Date(data.timestamp).toString()).not.toBe("Invalid Date");
  });
});
