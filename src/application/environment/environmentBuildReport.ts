import { basename } from "node:path";
import { isIP } from "node:net";

import { readRecordedResponseBody } from "../../domain/analysisView/recordedResponseBody.js";
import type { WebNetworkCaptureRecord } from "../../domain/webNetworkCapture.js";

/** A note the build report carries; warnings never change what is built. */
export interface EnvironmentBuildWarning {
  readonly code: "name-from-file" | "credential-named-members";
  readonly message: string;
  readonly pointers?: readonly string[];
}

/** Whole name segments that name credentials; `author` is not `auth`. */
const CREDENTIAL_SEGMENTS = new Set([
  "auth",
  "bearer",
  "cookie",
  "credential",
  "credentials",
  "jwt",
  "passwd",
  "password",
  "pwd",
  "secret",
  "secrets",
  "session",
  "sessionid",
  "token",
  "tokens",
  "apikey",
  "privatekey",
]);
const CREDENTIAL_PAIRS = new Set([
  "access key",
  "api key",
  "client secret",
  "private key",
  "session id",
]);

/** Split a member name into lowercase segments at case changes and separators. */
const nameSegments = (name: string): string[] =>
  name
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((segment) => segment.length > 0);

/** Whether a body member's name looks like it holds a credential. */
export const credentialNamed = (name: string): boolean => {
  const segments = nameSegments(name);
  return segments.some(
    (segment, index) =>
      CREDENTIAL_SEGMENTS.has(segment) ||
      (index > 0 && CREDENTIAL_PAIRS.has(`${segments[index - 1]} ${segment}`)),
  );
};

/** Bodies larger than this are not scanned. */
const SCAN_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
/** Pointers the report lists; the count covers every match. */
const REPORTED_POINTERS = 20;

const pointerToken = (name: string): string =>
  name.replaceAll("~", "~0").replaceAll("/", "~1");

const parsedBody = (text: string | null | undefined): unknown => {
  if (typeof text !== "string" || text.length > SCAN_BODY_LIMIT_BYTES)
    return undefined;
  const start = text.trimStart()[0];
  if (start !== "{" && start !== "[") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const requestText = (record: WebNetworkCaptureRecord): string | undefined => {
  const reported: unknown = record.reported;
  if (typeof reported !== "object" || reported === null) return undefined;
  const request: unknown = Reflect.get(reported, "request");
  if (typeof request !== "object" || request === null) return undefined;
  const postData: unknown = Reflect.get(request, "postData");
  if (typeof postData !== "object" || postData === null) return undefined;
  const text: unknown = Reflect.get(postData, "text");
  return typeof text === "string" ? text : undefined;
};

/** Credential-named members with a non-empty string value in recorded JSON bodies: a count and the first pointers, never values. */
export const scanCredentialNames = (
  records: readonly WebNetworkCaptureRecord[],
): { readonly count: number; readonly pointers: readonly string[] } => {
  let count = 0;
  const pointers: string[] = [];
  const visit = (value: unknown, pointer: string, label: string): void => {
    if (Array.isArray(value)) {
      value.forEach((child, index) =>
        visit(child, `${pointer}/${String(index)}`, label),
      );
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [name, child] of Object.entries(value)) {
      const path = `${pointer}/${pointerToken(name)}`;
      if (credentialNamed(name) && typeof child === "string" && child !== "") {
        count++;
        if (pointers.length < REPORTED_POINTERS)
          pointers.push(`${label} ${path}`);
      }
      visit(child, path, label);
    }
  };
  for (const record of records) {
    const ordinal = String(record.ordinal);
    visit(parsedBody(requestText(record)), "", `record ${ordinal} request`);
    visit(
      parsedBody(
        readRecordedResponseBody(record, SCAN_BODY_LIMIT_BYTES).bodyText,
      ),
      "",
      `record ${ordinal} response`,
    );
  }
  return { count, pointers };
};

/** Whether an origin's host is a loopback name or an IP literal, which says nothing about the application. */
export const anonymousOrigin = (origin: string): boolean => {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  return (
    bare === "localhost" || bare.endsWith(".localhost") || isIP(bare) !== 0
  );
};

/** A kebab-case name from a capture file's name: `grafana.har` and `grafana.capture.json` become `grafana`. */
export const nameFromCaptureFile = (path: string): string =>
  basename(path)
    .replace(/\.(?:har|json)$/iu, "")
    .replace(/\.capture$/iu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "");
