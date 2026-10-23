import { describe, expect, it } from "vitest";

import type { WebNetworkCaptureRecord } from "../../domain/webNetworkCapture.js";
import {
  anonymousOrigin,
  credentialNamed,
  nameFromCaptureFile,
  scanCredentialNames,
} from "./environmentBuildReport.js";

const record = (
  ordinal: number,
  request: unknown,
  response: unknown,
): WebNetworkCaptureRecord =>
  ({
    ordinal,
    reported: {
      request: {
        method: "POST",
        url: "http://127.0.0.1/api",
        ...(request === undefined
          ? {}
          : {
              postData: {
                mimeType: "application/json",
                text: JSON.stringify(request),
              },
            }),
      },
      response: {
        status: 200,
        content: {
          mimeType: "application/json",
          text: JSON.stringify(response),
        },
      },
    },
    redactions: [],
    binary_fields: [],
  }) as unknown as WebNetworkCaptureRecord;

describe("credentialNamed", () => {
  it("matches whole name segments, not substrings", () => {
    for (const name of [
      "password",
      "authToken",
      "api_key",
      "apiKey",
      "sessionId",
      "client_secret",
      "X-Session",
      "refresh.token",
    ])
      expect(credentialNamed(name), name).toBe(true);
    for (const name of ["author", "authority_level", "keyboard", "tokenizer"])
      expect(credentialNamed(name), name).toBe(false);
  });
});

describe("scanCredentialNames", () => {
  it("counts string values under credential names in request and response bodies, by pointer and never by value", () => {
    const scanned = scanCredentialNames([
      record(
        3,
        { name: "Folder", secret: "s3cr3t-value" },
        { data: [{ id: 1, sessionId: "abc123def" }], hasPassword: true },
      ),
      record(4, undefined, { token: "", "a/b": { apiKey: "k-1" } }),
    ]);
    expect(scanned).toEqual({
      count: 3,
      pointers: [
        "record 3 request /secret",
        "record 3 response /data/0/sessionId",
        "record 4 response /a~1b/apiKey",
      ],
    });
    expect(JSON.stringify(scanned)).not.toContain("s3cr3t");
  });
});

describe("anonymousOrigin", () => {
  it("is true for loopback names and IP literals", () => {
    for (const origin of [
      "http://127.0.0.1:3101",
      "http://localhost:3000",
      "http://app.localhost",
      "http://[::1]:8080",
      "http://10.0.0.5",
    ])
      expect(anonymousOrigin(origin), origin).toBe(true);
    for (const origin of ["https://grafana.example", "not a url"])
      expect(anonymousOrigin(origin), origin).toBe(false);
  });
});

describe("nameFromCaptureFile", () => {
  it("drops capture suffixes and keeps a kebab-case label", () => {
    expect(nameFromCaptureFile("/w/grafana.har")).toBe("grafana");
    expect(nameFromCaptureFile("/w/grafana.capture.json")).toBe("grafana");
    expect(nameFromCaptureFile("/w/My App.scoped.HAR")).toBe("my-app-scoped");
    expect(nameFromCaptureFile("/w/--.json")).toBe("");
  });
});
