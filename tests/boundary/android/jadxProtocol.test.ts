import { expect, it } from "vitest";
import {
  parseJadxEnvelope,
  parseJadxJson,
  normalizeJadxText,
  parseJadxFailure,
  jadxHeapExhausted,
} from "../../../src/android/JadxProtocol.js";
import { androidInputSchemas } from "../../../src/domain/android/androidAnalysis.js";

it("recognizes the heap-shortage reasons without claiming other JVM memory failures", () => {
  // Both reasons are remedied by the same worker heap setting: one runs out of
  // room, the other thrashes inside it. A larger heap turns the second into the
  // first, so they share a classification rather than one being a special case.
  for (const reason of [
    "load failed: Java heap space",
    "load failed: java.lang.OutOfMemoryError: Java heap space",
    "load failed: GC overhead limit exceeded",
    "load failed: java.lang.OutOfMemoryError: GC overhead limit exceeded",
    "load failed: java.lang.OutOfMemoryError: GC Overhead Limit Exceeded",
  ])
    expect(jadxHeapExhausted(reason)).toBe(true);
  // Other JVM memory failures have different causes and different recovery, so
  // they must keep the generic startup failure rather than name the heap setting.
  for (const text of [
    "load failed: java.lang.OutOfMemoryError: Metaspace",
    "load failed: java.lang.OutOfMemoryError: Direct buffer memory",
    "load failed: java.lang.OutOfMemoryError: unable to create new native thread",
    "load failed: malformed dex",
    "",
  ])
    expect(jadxHeapExhausted(text)).toBe(false);
});

it("recognizes named bridge failures without reinterpreting arbitrary engine text", () => {
  const failure = {
    kind: "jvm-memory-failure",
    memory_area: "heap",
    exception_type: "java.lang.OutOfMemoryError",
    message: "Java heap space",
    max_heap_bytes: 67108864,
  };
  expect(parseJadxFailure(JSON.stringify(failure))).toEqual(failure);
  for (const value of [
    "load failed: cannot read /inputs/Java heap space.apk",
    "{malformed Java heap space",
    JSON.stringify({
      ...failure,
      exception_type: "java.lang.IllegalArgumentException",
    }),
    JSON.stringify({ ...failure, max_heap_bytes: -1 }),
    JSON.stringify({ ...failure, memory_area: "native" }),
    JSON.stringify({ ...failure, arbitrary: true }),
  ])
    expect(parseJadxFailure(value)).toBeUndefined();
});

it("validates provider text envelopes and rejects unsupported content rather than dropping it", () => {
  expect(
    parseJadxEnvelope(
      { content: [{ type: "text", text: "reported error" }], isError: true },
      "inspect_android_package",
    ),
  ).toEqual({ text: "reported error", failed: true });
  for (const response of [
    { content: [] },
    { content: [{ type: "image", data: "AA==", mimeType: "image/png" }] },
    {
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    },
  ])
    expect(() =>
      parseJadxEnvelope(response, "inspect_android_package"),
    ).toThrowError("unsupported MCP content envelope");
  expect(() =>
    parseJadxJson("{malformed", "inspect_android_package"),
  ).toThrowError("malformed JSON text");
});

it("retains UTF-8 source and recognizes only the producer's terminal truncation marker", () => {
  expect(normalizeJadxText("日本語")).toEqual({
    text: "日本語",
    status: "complete",
    reported_total_bytes: null,
  });
  const text = "日本語\n\n... [truncated: exceeds 9 bytes, total 100 bytes]";
  expect(normalizeJadxText(text)).toEqual({
    text,
    status: "partial",
    reported_total_bytes: 100,
  });
  expect(normalizeJadxText(text + "\nmore actual source").status).toBe(
    "complete",
  );
});

it("rejects invalid APK selectors and accepts an explicit zero overload without a confirmation flag", () => {
  const input = {
    path: "/fixture.apk",
    class_name: "fixture.Target",
    method_name: "choose",
  };
  expect(
    androidInputSchemas.inspect_android_method.safeParse({
      ...input,
      overload_index: 0,
    }).success,
  ).toBe(true);
  expect(
    androidInputSchemas.inspect_android_method.safeParse({
      ...input,
      overload_index: -1,
    }).success,
  ).toBe(false);
  expect(
    androidInputSchemas.inspect_android_method.safeParse({
      ...input,
      overload_index: 0.5,
    }).success,
  ).toBe(false);
  expect(
    androidInputSchemas.inspect_android_method.safeParse({
      ...input,
      approved: true,
    }).success,
  ).toBe(false);
  expect(
    androidInputSchemas.search_android_classes.safeParse({
      path: "/fixture.apk",
      query: "",
    }).success,
  ).toBe(true);
});
