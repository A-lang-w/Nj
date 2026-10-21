import { describe, expect, it, onTestFinished } from "vitest";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { captureWebScreenshotInputSchema } from "../../../src/domain/webScreenshot.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";

// These wire tests validate PNG headers; actual rendering has its own browser lane.
const screenshotData = (width: number, height: number) => {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
    "base64",
  );
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return { data: bytes.toString("base64") };
};

const withCssViewport = (metrics: Readonly<Record<string, unknown>>) => ({
  ...metrics,
  cssVisualViewport: metrics.visualViewport,
});

describe("screenshot visual viewport capture", () => {
  it("recovers a cropped surface using the reported viewport clip and page scale", async () => {
    let captures = 0;
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Page.getLayoutMetrics"
          ? withCssViewport({
              visualViewport: {
                pageX: 12,
                pageY: 34,
                clientWidth: 640,
                clientHeight: 360,
                scale: 2,
              },
            })
          : method === "Page.captureScreenshot"
            ? ++captures === 1
              ? screenshotData(320, 180)
              : screenshotData(1280, 720)
            : undefined,
    });
    onTestFinished(async () => {
      await browser.close();
    });
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    expect(result.ok).toBe(true);
    const layoutMetrics = browser.commands.findIndex(
      ({ method }) => method === "Page.getLayoutMetrics",
    );
    const screenshotIndex = browser.commands.findIndex(
      ({ method }) => method === "Page.captureScreenshot",
    );
    expect(layoutMetrics).toBeGreaterThanOrEqual(0);
    expect(screenshotIndex).toBeGreaterThan(layoutMetrics);
    const screenshots = browser.commands.filter(
      ({ method }) => method === "Page.captureScreenshot",
    );
    expect(screenshots).toHaveLength(2);
    expect(screenshots[0]?.params).toMatchObject({
      captureBeyondViewport: false,
    });
    expect(screenshots[0]?.params).not.toHaveProperty("clip");
    expect(screenshots[1]?.params).toMatchObject({
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 12, y: 34, width: 640, height: 360, scale: 2 },
    });
    if (!result.ok) throw result.error;
    expect(result.value.viewport).toEqual({ width: 1280, height: 720 });
  });
});

describe("screenshot CSS and device-pixel coordinates", () => {
  it("uses CSS clip coordinates when the reported viewport has twice as many device pixels", async () => {
    let captures = 0;
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Page.getLayoutMetrics"
          ? {
              cssVisualViewport: {
                pageX: 12,
                pageY: 34,
                clientWidth: 640,
                clientHeight: 360,
                scale: 1,
              },
              visualViewport: {
                pageX: 24,
                pageY: 68,
                clientWidth: 1280,
                clientHeight: 720,
                scale: 1,
              },
            }
          : method === "Page.captureScreenshot"
            ? ++captures === 1
              ? screenshotData(800, 400)
              : screenshotData(1280, 720)
            : undefined,
    });
    onTestFinished(() => browser.close());
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    expect(result.ok).toBe(true);
    const screenshots = browser.commands.filter(
      ({ method }) => method === "Page.captureScreenshot",
    );
    expect(screenshots).toHaveLength(2);
    expect(screenshots[1]?.params.clip).toEqual({
      x: 12,
      y: 34,
      width: 640,
      height: 360,
      scale: 1,
    });
  });
});

describe("screenshot surface compatibility", () => {
  it.each([
    {
      label: "scrollbars",
      width: 2033,
      height: 1521,
      imageWidth: 2048,
      imageHeight: 1536,
    },
    {
      label: "higher pixel density",
      width: 640,
      height: 360,
      imageWidth: 1280,
      imageHeight: 720,
    },
  ])(
    "preserves the original surface with $label",
    async ({ width, height, imageWidth, imageHeight }) => {
      const image = screenshotData(imageWidth, imageHeight);
      const browser = await startFakeCdpBrowser({
        commandResult: ({ method }) =>
          method === "Page.getLayoutMetrics"
            ? withCssViewport({
                visualViewport: {
                  pageX: 0,
                  pageY: 0,
                  clientWidth: width,
                  clientHeight: height,
                  scale: 1,
                },
              })
            : method === "Page.captureScreenshot"
              ? image
              : undefined,
      });
      onTestFinished(() => browser.close());
      const result = await new CdpBrowserProvider().captureScreenshot(
        captureWebScreenshotInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          allowed_origins: [browser.allowedOrigin],
          target_id: "allowed-page",
        }),
      );
      if (!result.ok) throw result.error;
      expect(result.value.viewport).toEqual({
        width: imageWidth,
        height: imageHeight,
      });
      expect(result.value.artifact.data_base64).toBe(image.data);
      expect(
        browser.commands.filter(
          ({ method }) => method === "Page.captureScreenshot",
        ),
      ).toHaveLength(1);
    },
  );

  it("refuses a clipped recovery that still omits visible content", async () => {
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Page.getLayoutMetrics"
          ? withCssViewport({
              visualViewport: {
                pageX: 0,
                pageY: 0,
                clientWidth: 2,
                clientHeight: 2,
                scale: 1,
              },
            })
          : undefined,
    });
    onTestFinished(() => browser.close());
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
    expect(
      browser.commands.filter(
        ({ method }) => method === "Page.captureScreenshot",
      ),
    ).toHaveLength(2);
  });

  it("does not retry a cropped surface after the target leaves scope", async () => {
    const browser = await startFakeCdpBrowser({
      navigateDuringScreenshotUrl: "https://outside.test/",
      commandResult: ({ method }) =>
        method === "Page.getLayoutMetrics"
          ? withCssViewport({
              visualViewport: {
                pageX: 0,
                pageY: 0,
                clientWidth: 2,
                clientHeight: 2,
                scale: 1,
              },
            })
          : undefined,
    });
    onTestFinished(() => browser.close());
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "target_not_allowed" },
    });
    expect(
      browser.commands.filter(
        ({ method }) => method === "Page.captureScreenshot",
      ),
    ).toHaveLength(1);
  });
});

describe("screenshot viewport protocol validation", () => {
  it.each([
    ["missing metrics", {}],
    [
      "non-numeric coordinates",
      {
        visualViewport: {
          pageX: "unknown",
          pageY: 0,
          clientWidth: 10,
          clientHeight: 10,
          scale: 1,
        },
      },
    ],
    [
      "non-finite coordinates",
      {
        visualViewport: {
          pageX: Number.POSITIVE_INFINITY,
          pageY: 0,
          clientWidth: 10,
          clientHeight: 10,
          scale: 1,
        },
      },
    ],
    [
      "non-positive dimensions",
      {
        visualViewport: {
          pageX: 0,
          pageY: 0,
          clientWidth: 0,
          clientHeight: 10,
          scale: 1,
        },
      },
    ],
    [
      "non-positive scale",
      {
        visualViewport: {
          pageX: 0,
          pageY: 0,
          clientWidth: 10,
          clientHeight: 10,
          scale: 0,
        },
      },
    ],
  ])("rejects %s before screenshot capture", async (_label, metrics) => {
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Page.getLayoutMetrics"
          ? withCssViewport(metrics)
          : undefined,
    });
    onTestFinished(async () => {
      await browser.close();
    });
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
    expect(
      browser.commands.some(
        ({ method }) => method === "Page.captureScreenshot",
      ),
    ).toBe(false);
  });
});

describe("screenshot committed document identity", () => {
  it.each([
    ["missing screenshot data", {}],
    ["invalid base64 screenshot data", { data: "not base64%%%" }],
  ])("reports %s as a protocol error", async (_label, result) => {
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Page.captureScreenshot" ? result : undefined,
    });
    onTestFinished(async () => {
      await browser.close();
    });
    const observation = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    expect(observation).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
  });

  it.each([
    { offset: 8, value: 14 },
    { offset: 16, value: 0x8000_0000 },
    { offset: 20, value: 0x8000_0000 },
  ])("rejects invalid screenshot IHDR metadata", async ({ offset, value }) => {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv4sAAAAASUVORK5CYII=",
      "base64",
    );
    bytes.writeUInt32BE(value, offset);
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Page.captureScreenshot"
          ? { data: bytes.toString("base64") }
          : undefined,
    });
    onTestFinished(async () => {
      await browser.close();
    });
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
  });
  it.each(["loader-main", "loader-reloaded"])(
    "distinguishes %s for the same URL",
    async (screenshotDocumentLoader) => {
      const browser = await startFakeCdpBrowser({ screenshotDocumentLoader });
      onTestFinished(async () => {
        await browser.close();
      });
      const result = await new CdpBrowserProvider().captureScreenshot(
        captureWebScreenshotInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          allowed_origins: [browser.allowedOrigin],
          target_id: "allowed-page",
        }),
      );
      if (screenshotDocumentLoader === "loader-main")
        expect(result.ok).toBe(true);
      else
        expect(result).toMatchObject({
          ok: false,
          error: { reason: "target_changed" },
        });
    },
  );
});
