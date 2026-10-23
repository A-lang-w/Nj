import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadHopperPackage } from "./HopperDownload.js";

const responseAt = (url: string, body: string): Response => {
  const response = new Response(body, { status: 200 });
  Object.defineProperty(response, "url", { value: url });
  return response;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("downloadHopperPackage redirect origin", () => {
  it("returns the bytes when a redirect stays on the requested origin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        responseAt("https://www.hopperapp.com/releases/pkg.deb", "payload"),
      ),
    );

    const result = await downloadHopperPackage(
      "https://www.hopperapp.com/download",
    );
    expect(result).toEqual({ ok: true, bytes: Buffer.from("payload") });
  });

  it("refuses a response a redirect moved to another origin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        responseAt("https://cdn.example.net/pkg.deb", "payload"),
      ),
    );

    const result = await downloadHopperPackage(
      "https://www.hopperapp.com/download",
    );
    expect(result.ok).toBe(false);
    expect(result.bytes).toHaveLength(0);
  });
});
