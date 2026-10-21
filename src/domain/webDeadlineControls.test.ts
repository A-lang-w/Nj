import { describe, expect, it } from "vitest";

import {
  cdpCleanupGraceExpired,
  cdpCommandDeadlineRecovery,
} from "./browserDeadline.js";
import { listBrowserTargetsInputSchema } from "./browserObservation.js";
import {
  analyzeWebBundleInputSchema,
  webBundleScriptTimeoutRecovery,
} from "./webBundleAnalysis.js";
import {
  inspectWebNetworkCaptureInputSchema,
  webNetworkCaptureTimeoutRecovery,
} from "./webNetworkCapture.js";
import {
  webSourceLocationInputSchema,
  webSourceMapDecodeTimeoutRecovery,
} from "./webSourceLocation.js";

const bundle = {
  cdp_endpoint: "http://127.0.0.1:9222",
  target_id: "page",
};

describe("web deadline controls", () => {
  it("rejects a per-script deadline above the total", () => {
    const parsed = analyzeWebBundleInputSchema.safeParse({
      ...bundle,
      analysis_timeout_ms: 40_000,
      total_analysis_timeout_ms: 30_000,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(
      parsed.error.issues.map((issue) => issue.message).join(" "),
    ).toContain("analysis_timeout_ms");
  });

  it("keeps omitted web-bundle deadlines at today's defaults", () => {
    const parsed = analyzeWebBundleInputSchema.parse(bundle);
    expect(parsed.analysis_timeout_ms).toBeUndefined();
    expect(parsed.total_analysis_timeout_ms).toBeUndefined();
    expect(parsed.max_heap_mb).toBeUndefined();
    expect(parsed.source_map_fetch_timeout_ms).toBeUndefined();
    expect(parsed.command_timeout_ms).toBeUndefined();
  });

  it("accepts the promoted deadlines inside 1..2147483647", () => {
    expect(
      analyzeWebBundleInputSchema.safeParse({
        ...bundle,
        command_timeout_ms: 2_147_483_647,
      }).success,
    ).toBe(true);
    expect(
      listBrowserTargetsInputSchema.safeParse({
        cdp_endpoint: "http://127.0.0.1:9222",
        command_timeout_ms: 1_500,
      }).success,
    ).toBe(false);
    expect(
      inspectWebNetworkCaptureInputSchema.safeParse({
        capture_path: "/tmp/capture.har",
        format: "har",
        capture_timeout_ms: 0,
      }).success,
    ).toBe(false);
    expect(
      webSourceLocationInputSchema.safeParse({
        manifest_path: "/tmp/manifest.json",
        script_index: 0,
        source_map: {
          path: "/tmp/app.js.map",
          url: "https://example.test/app.js.map",
        },
        generated_position: { line: 1, column: 0 },
        decode_timeout_ms: 20_000,
      }).success,
    ).toBe(true);
  });

  it("names each deadline and the fixed budgets it does not raise", () => {
    expect(webBundleScriptTimeoutRecovery(30_000).userMessage).toContain(
      "analysis_timeout_ms",
    );
    expect(
      webNetworkCaptureTimeoutRecovery(30_000).remediationAction,
    ).toContain("no runtime override");
    expect(webSourceMapDecodeTimeoutRecovery(20_000).userMessage).toContain(
      "decode_timeout_ms",
    );
    expect(
      cdpCommandDeadlineRecovery(20_000, "handshake").userMessage,
    ).toContain("command_timeout_ms");
    expect(cdpCleanupGraceExpired()).toContain("5000 ms");
    expect(cdpCleanupGraceExpired()).toContain("no runtime override");
    const inspector = cdpCommandDeadlineRecovery(
      20_000,
      "handshake",
      undefined,
      false,
    );
    expect(inspector.userMessage).not.toContain("command_timeout_ms");
    expect(inspector.remediationAction).not.toContain("--command-timeout-ms");
    expect(inspector.remediationAction).toContain("no runtime override");
  });
});
