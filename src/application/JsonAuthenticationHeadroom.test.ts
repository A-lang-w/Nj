import { describe, expect, it } from "vitest";
import {
  estimateJsonValueBytes,
  requireAuthenticationHeadroom,
} from "./JsonAuthenticationHeadroom.js";
describe("JSON authentication headroom", () => {
  it("estimates parsed JSON at no less than its UTF-16 text", () => {
    const text = "x".repeat(1000);
    expect(estimateJsonValueBytes(text)).toBeGreaterThanOrEqual(2000);
    expect(
      estimateJsonValueBytes({ outer: [text, { inner: text }] }),
    ).toBeGreaterThan(2 * estimateJsonValueBytes(text));
  });

  it("refuses authentication when live heap headroom cannot hold its copies", () => {
    const value = { normalized_result: "y".repeat(10_000) };
    expect(
      requireAuthenticationHeadroom(value, {
        operation: "compare_source_to_bundle",
        path: "/tmp/capture.json",
        description: "Cannot authenticate graph",
        availableBytes: 1024,
      }),
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisResourceConstraintError",
        resource: "memory",
        reportedLimits: {
          input_path: "/tmp/capture.json",
          available_heap_bytes: 1024,
        },
      },
    });
    expect(
      requireAuthenticationHeadroom(value, {
        operation: "compare_source_to_bundle",
        path: "/tmp/capture.json",
        description: "Cannot authenticate graph",
        availableBytes: 1 << 30,
      }),
    ).toEqual({ ok: true, value: undefined });
  });
});

it.each([
  ["control characters", { text: "\u0000\u0001\b\t\n\f\r".repeat(2000) }],
  [
    "escaped keys",
    { ['\u0000\\"'.repeat(2000)]: [true, false, null, -0, 1e30] },
  ],
  ["surrogate boundaries", { text: "😀\ud800x\udfff".repeat(2000) }],
])("reserves actual escaped JSON storage for %s", (_label, value) => {
  const result = requireAuthenticationHeadroom(value, {
    operation: "inspect_analysis_view",
    path: "/tmp/bundle.json",
    description: "Cannot authenticate bundle",
    availableBytes: estimateJsonValueBytes(value) * 2 + 1,
  });
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisResourceConstraintError",
      reportedLimits: {
        serialized_json_utf16_bytes: JSON.stringify(value).length * 2,
      },
    },
  });
});
