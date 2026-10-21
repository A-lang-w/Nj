import type { ProgressReporter } from "../application/ProgressReporter.js";
import type {
  CaptureWebScreenshotInput,
  WebScreenshot,
} from "../domain/webScreenshot.js";
import { createWebScreenshotArtifact } from "../domain/webScreenshot.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { isMainFrameNavigation } from "./CdpCaptureEventHelpers.js";
import type { CdpEndpointDiscovery, CdpEndpointTarget } from "./CdpEndpoint.js";
import type { CdpConnection, CdpEvent } from "./CdpConnection.js";
import {
  allowedSanitizedUrl,
  recordValue,
  cdpStringValue,
  numberValue,
} from "./CdpCaptureValues.js";
import { mainFrameUrl } from "./CdpCaptureDocuments.js";
import { captureFrames } from "./CdpCaptureDocuments.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import { decodeCanonicalBase64 } from "../domain/webScreenshot.js";
import { readPngHeaderDimensions } from "../domain/pngHeader.js";

interface ScreenshotContext {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
  readonly discovery: CdpEndpointDiscovery;
  readonly target: CdpEndpointTarget;
  readonly input: CaptureWebScreenshotInput;
  readonly signal?: AbortSignal;
  readonly progress?: ProgressReporter;
}

/** Capture the current viewport without navigation, evaluation, or page mutation. */
export const captureCdpScreenshot = async (
  context: ScreenshotContext,
): Promise<WebScreenshot> => {
  const origins = new Set(context.input.allowed_origins);
  await context.progress?.report({
    phase: "browser_observation",
    completed: 1,
    total: 2,
    message: "Authorizing current screenshot frame",
  });
  await context.connection.send(
    "Page.enable",
    {},
    context.sessionId,
    context.signal,
  );
  const before = await context.connection.send(
    "Page.getFrameTree",
    {},
    context.sessionId,
    context.signal,
  );
  const beforeUrl = mainFrameUrl(before);
  const authorized = allowedSanitizedUrl(beforeUrl, origins);
  const mainFrame = captureFrames(before, origins, 1).items[0];
  if (authorized === undefined || mainFrame === undefined)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  const initialFrame = recordValue(
    recordValue(recordValue(before)?.frameTree)?.frame,
  );
  const navigation = {
    changed: false,
    leftScope: false,
    url: beforeUrl,
    loaderId: cdpStringValue(initialFrame?.loaderId),
  };
  const removeListener = context.connection.onEvent((event) => {
    if (event.sessionId !== context.sessionId) return;
    observeScreenshotNavigation(event, mainFrame.frame_id, origins, navigation);
  });
  let screenshot: Awaited<ReturnType<typeof captureScreenshotImage>>;
  let after: unknown;
  try {
    const metrics = recordValue(
      await context.connection.send(
        "Page.getLayoutMetrics",
        {},
        context.sessionId,
        context.signal,
      ),
    );
    const visualViewport = recordValue(metrics?.visualViewport);
    const cssViewport = recordValue(metrics?.cssVisualViewport);
    const pageX = numberValue(cssViewport?.pageX);
    const pageY = numberValue(cssViewport?.pageY);
    const width = numberValue(cssViewport?.clientWidth);
    const height = numberValue(cssViewport?.clientHeight);
    const scale = numberValue(cssViewport?.scale);
    const pixelWidth = numberValue(visualViewport?.clientWidth);
    const pixelHeight = numberValue(visualViewport?.clientHeight);
    const pixelScale = numberValue(visualViewport?.scale);
    if (
      pageX === undefined ||
      pageY === undefined ||
      width === undefined ||
      height === undefined ||
      scale === undefined ||
      pixelWidth === undefined ||
      pixelHeight === undefined ||
      pixelScale !== scale ||
      width <= 0 ||
      height <= 0 ||
      scale <= 0 ||
      pixelWidth <= 0 ||
      pixelHeight <= 0
    )
      throw new BrowserObservationError("inspect_web_page", "protocol_error");
    // Keep ordinary surface captures, including their scrollbars and pixel
    // density. The visual viewport excludes scrollbars and supplies only a
    // lower bound on the expected image size, allowing subpixel rounding.
    const minimumWidth = Math.max(1, Math.floor(pixelWidth * scale));
    const minimumHeight = Math.max(1, Math.floor(pixelHeight * scale));
    if (
      !Number.isSafeInteger(minimumWidth) ||
      !Number.isSafeInteger(minimumHeight)
    )
      throw new BrowserObservationError("inspect_web_page", "protocol_error");
    const coversViewport = (
      image: Awaited<ReturnType<typeof captureScreenshotImage>>,
    ) =>
      image.dimensions.width >= minimumWidth &&
      image.dimensions.height >= minimumHeight;
    screenshot = await captureScreenshotImage(context);
    if (!coversViewport(screenshot)) {
      if (navigation.leftScope)
        throw new BrowserObservationError(
          "inspect_web_page",
          "target_not_allowed",
        );
      if (navigation.changed)
        throw new BrowserObservationError("inspect_web_page", "target_changed");
      // A smaller compositor surface must not truncate the visible content.
      // Clip coordinates use CSS units, not the device pixels of visualViewport.
      // Client dimensions already reflect page scale; do not divide again.
      screenshot = await captureScreenshotImage(context, {
        x: pageX,
        y: pageY,
        width,
        height,
        scale,
      });
      if (!coversViewport(screenshot))
        throw new BrowserObservationError(
          "inspect_web_page",
          "protocol_error",
          {
            detail:
              "The screenshot does not cover the reported visual viewport.",
          },
        );
    }
    after = await context.connection.send(
      "Page.getFrameTree",
      {},
      context.sessionId,
      context.signal,
    );
  } finally {
    removeListener();
  }
  const { bytes, dimensions } = screenshot;
  if (navigation.leftScope)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  const afterUrl = mainFrameUrl(after);
  if (
    navigation.changed ||
    afterUrl !== beforeUrl ||
    allowedSanitizedUrl(afterUrl, origins) === undefined
  )
    throw new BrowserObservationError("inspect_web_page", "target_changed");
  await context.progress?.report({
    phase: "browser_observation",
    completed: 2,
    total: 2,
    message: "Screenshot capture complete",
    terminal: true,
  });
  return {
    browser: context.discovery.version,
    target: {
      target_id: context.target.id,
      url: authorized.url,
      origin: authorized.origin ?? "",
    },
    captured_at: new Date().toISOString(),
    viewport: dimensions,
    artifact: createWebScreenshotArtifact(bytes),
    completeness: new CdpCaptureCompleteness().snapshot(),
    limitations: [
      "The screenshot contains the visible viewport, including on-screen content.",
      "REA does not scroll, evaluate JavaScript, or capture beyond the current viewport.",
    ],
  };
};

interface ScreenshotClip {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

/** Decode every capture at the same boundary, including a clipped recovery. */
const captureScreenshotImage = async (
  context: ScreenshotContext,
  clip?: ScreenshotClip,
) => {
  const result = recordValue(
    await context.connection.send(
      "Page.captureScreenshot",
      {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: clip !== undefined,
        ...(clip === undefined ? {} : { clip }),
      },
      context.sessionId,
      context.signal,
    ),
  );
  const encoded = cdpStringValue(result?.data);
  const bytes =
    encoded === undefined ? undefined : decodeCanonicalBase64(encoded);
  if (bytes === undefined)
    throw new BrowserObservationError("inspect_web_page", "protocol_error");
  const dimensions = readPngHeaderDimensions(bytes);
  if (dimensions === undefined)
    throw new BrowserObservationError("inspect_web_page", "protocol_error");
  return { bytes, dimensions };
};

const observeScreenshotNavigation = (
  event: CdpEvent,
  mainFrameId: string,
  origins: ReadonlySet<string>,
  state: {
    changed: boolean;
    leftScope: boolean;
    readonly url: string | undefined;
    readonly loaderId: string | undefined;
  },
): void => {
  if (!isMainFrameNavigation(event, mainFrameId)) return;
  const params = recordValue(event.params);
  if (params === undefined) return;
  const frame =
    event.method === "Page.frameNavigated" ? recordValue(params.frame) : params;
  if (
    event.method === "Page.frameNavigated" &&
    state.loaderId !== undefined &&
    state.loaderId !== "" &&
    cdpStringValue(frame?.loaderId) === state.loaderId &&
    cdpStringValue(frame?.url) === state.url
  )
    return;

  state.changed = true;
  if (allowedSanitizedUrl(frame?.url, origins) === undefined)
    state.leftScope = true;
};
