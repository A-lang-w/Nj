import { isAbsolute } from "node:path";
import { CaptureFormatError } from "../CaptureFormatError.js";
import {
  CaptureRedaction,
  isCaptureCredentialHeader,
} from "../CaptureRedaction.js";
import { createHash } from "node:crypto";
import { readStableArtifact } from "../../../artifacts/readStableArtifact.js";
import type { ArtifactResourceScope } from "../../../artifacts/ArtifactResourceScope.js";
import { AnalysisInputError } from "../../../domain/analysisErrorCore.js";
import { redactExplicitText } from "../../../domain/explicitSensitiveValues.js";
import {
  WEB_NETWORK_CAPTURE_LIMITS,
  type InspectWebNetworkCaptureInput,
  type WebNetworkCapture,
  type WebNetworkCaptureRecord,
} from "../../../domain/webNetworkCapture.js";
import type { JsonValue } from "../../../domain/jsonValue.js";
import { ProtobufBudget } from "./ProtobufWire.js";
import type { ProtobufSchema } from "./ProtobufSchema.js";
import {
  PROTOBUF_FRAMING,
  PROTOBUF_LIMITATIONS,
  decodeProtobufBody,
} from "./ProtobufBody.js";
import type { ProtobufDecoding } from "../../../domain/protobufWire.js";

const object = (
  value: JsonValue | undefined,
): Readonly<Record<string, JsonValue>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;

/** Exclude the original encoded representation as well as its decoding sidecar. */
const excludeBody = (
  record: WebNetworkCaptureRecord,
  pointer: string,
  reason: "explicit-sensitive-value" | "transport-credential",
) => {
  record.binary_fields = record.binary_fields.map((field) =>
    field.pointer !== pointer
      ? field
      : {
          pointer: field.pointer,
          representation: field.representation,
          state: "redacted",
          content_base64: null,
          bytes: null,
          sha256: null,
        },
  );
  const parts = pointer
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let parent: JsonValue | undefined = record.reported;
  for (const part of parts.slice(0, -1)) {
    if (
      parent === null ||
      typeof parent !== "object" ||
      !Object.hasOwn(parent, part)
    ) {
      parent = undefined;
      break;
    }
    parent = Array.isArray(parent) ? parent[Number(part)] : parent[part];
  }
  const key = parts.at(-1);
  if (
    parent !== null &&
    typeof parent === "object" &&
    key !== undefined &&
    Object.hasOwn(parent, key)
  )
    Object.defineProperty(parent, key, {
      value: null,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  record.redactions.push({ pointer, reason });
};

/** Format-aware owner of body metadata; callers never reinterpret producer JSON. */
const bodyMetadata = (
  record: WebNetworkCaptureRecord,
  pointer: string,
  format: string,
  binaryByPointer: ReadonlyMap<
    string,
    WebNetworkCaptureRecord["binary_fields"][number]
  >,
) => {
  const side = /^\/(request|response)\//.exec(pointer)?.[1];
  if (
    side === undefined ||
    ![
      "/request/postData/text",
      "/response/content/text",
      "/request/body",
      "/response/body",
      "/request/content",
      "/response/content",
    ].includes(pointer)
  )
    return undefined;
  const message = object(object(record.reported)?.[side]);
  if (message === undefined) return undefined;
  const headers = new Map<string, string | undefined>();
  if (Array.isArray(message.headers)) {
    for (const [index, item] of message.headers.entries()) {
      const pair = object(item);
      const text = (
        value: JsonValue | undefined,
        coordinate: string,
      ): string | undefined => {
        const binary = binaryByPointer.get(coordinate);
        if (binary !== undefined)
          return binary.state === "retained"
            ? Buffer.from(binary.content_base64, "base64").toString("latin1")
            : undefined;
        return typeof value === "string" ? value : undefined;
      };
      const name = Array.isArray(item)
        ? text(item[0], `/${side}/headers/${index}/0`)
        : pair?.name;
      const value = Array.isArray(item)
        ? text(item[1], `/${side}/headers/${index}/1`)
        : pair?.value;
      if (typeof name === "string" && typeof value === "string") {
        const key = name.toLowerCase();
        headers.set(
          key,
          headers.has(key) && headers.get(key) !== value ? undefined : value,
        );
      }
    }
  }
  if (format === "har") {
    if (
      pointer !== `/${side}/${side === "request" ? "postData" : "content"}/text`
    )
      return undefined;
    const content = object(
      message[side === "request" ? "postData" : "content"],
    );
    return {
      contentType:
        typeof content?.mimeType === "string"
          ? content.mimeType
          : headers.get("content-type"),
      encoded: false,
    };
  }
  if (pointer !== `/${side}/body` && pointer !== `/${side}/content`)
    return undefined;
  return {
    contentType: headers.get("content-type"),
    encoded: ["content-encoding", "transfer-encoding"].some(
      (name) =>
        headers.has(name) && headers.get(name)?.toLowerCase() !== "identity",
    ),
  };
};

/** Enrich selected records once, inside the capture adapter's owned operation. */
export const decodeCaptureProtobuf = async (
  capture: WebNetworkCapture,
  input: InspectWebNetworkCaptureInput,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
  encodedSourceBytes = 0,
): Promise<void> => {
  if (input.record_ordinals === undefined) return;
  capture.protobuf_coverage = {
    status: "partial",
    selected_records: input.record_ordinals.length,
    inspected_records: 0,
  };
  let incomplete = false;
  const budget = new ProtobufBudget(signal);
  budget.charge(
    encodedSourceBytes +
      256 +
      Buffer.byteLength(JSON.stringify(PROTOBUF_LIMITATIONS)),
  );
  capture.limitations.push(...PROTOBUF_LIMITATIONS);
  const redactions = new CaptureRedaction(input.sensitive_values);
  const redact = (text: string) => {
    if (input.sensitive_values.length === 0) return text;
    // A literal replacement can expand one UTF-16 unit to ten; reserve JSON escaping before allocation.
    if (input.sensitive_values.some((literal) => text.includes(literal)))
      budget.charge(text.length * 60);
    return redactExplicitText(text, input.sensitive_values);
  };
  const options = input.protobuf;
  let schema: ProtobufSchema | undefined;
  let schemaSource: ProtobufDecoding["schema"];
  if (options?.schema !== undefined) {
    const path = options.schema.descriptor_set_path;
    if (!isAbsolute(path))
      throw new AnalysisInputError("inspect_web_network_capture", undefined, [
        {
          path: ["protobuf", "schema", "descriptor_set_path"],
          reason: "invalid_format",
          message: "Expected an absolute descriptor-set path",
        },
      ]);
    const snapshot = await readStableArtifact(
      path,
      WEB_NETWORK_CAPTURE_LIMITS.inputBytes,
      signal,
      undefined,
      resources,
    );
    const { ProtobufSchema } = await import("./ProtobufSchema.js");
    try {
      schema = await ProtobufSchema.read(
        snapshot.bytes,
        options.schema.message_type,
        budget,
        redact,
      );
    } catch (cause) {
      if (signal?.aborted === true && cause === signal.reason) throw cause;
      if (cause instanceof CaptureFormatError) throw cause;
      throw new AnalysisInputError("inspect_web_network_capture", undefined, [
        {
          path: ["protobuf", "schema"],
          reason: "invalid_format",
          message:
            "The selected local FileDescriptorSet or message type is invalid or exceeds decoding budgets",
        },
      ]);
    }
    schemaSource = {
      decoder: "protobuf-es-2.16.0",
      descriptor_set_path: redact(path),
      descriptor_set_sha256: snapshot.sha256,
      descriptor_set_bytes: snapshot.bytes.length,
      message_type: redact(options.schema.message_type),
    };
  }
  const pointers =
    options?.body_pointers === undefined
      ? undefined
      : new Set(options.body_pointers);
  for (const ordinal of input.record_ordinals) {
    const record = capture.records[ordinal];
    if (record === undefined) continue; // The shared application reports invalid ordinals.
    const decoded: ProtobufDecoding[] = [];
    const binaryByPointer = new Map(
      record.binary_fields.map((field) => [field.pointer, field]),
    );
    for (const field of record.binary_fields) {
      await budget.checkpoint();
      if (pointers !== undefined && !pointers.has(field.pointer)) continue;
      if (field.state !== "retained") {
        if (
          /^\/(request|response)\/(body|content|postData\/text|content\/text)$/.test(
            field.pointer,
          )
        )
          incomplete = true;
        continue;
      }
      const metadata = bodyMetadata(
        record,
        field.pointer,
        input.format,
        binaryByPointer,
      );
      const contentType = metadata?.contentType;
      const essence = contentType?.split(";", 1)[0]?.trim().toLowerCase();
      const automatic =
        essence === undefined
          ? undefined
          : PROTOBUF_FRAMING[essence as keyof typeof PROTOBUF_FRAMING];
      const framing =
        options?.framing === undefined || options.framing === "auto"
          ? automatic
          : options.framing;
      if (framing === undefined) continue;
      if (metadata?.encoded) {
        incomplete = true;
        record.limitations.push(
          "Selected protobuf body still has HTTP content/transfer encoding; its exact stored bytes remain opaque.",
        );
        continue;
      }
      // Explicit coordinate/digest exclusions must not acquire a second decoding sidecar.
      if (
        input.sensitive_values.some(
          (value) =>
            field.pointer.includes(value) ||
            field.sha256.includes(value) ||
            schemaSource?.descriptor_set_sha256.includes(value),
        )
      ) {
        incomplete = true;
        continue;
      }
      const body = Buffer.from(field.content_base64, "base64");
      if (
        body.length !== field.bytes ||
        createHash("sha256").update(body).digest("hex") !== field.sha256
      )
        throw new AnalysisInputError("inspect_web_network_capture", undefined, [
          {
            path: ["capture_path"],
            reason: "invalid_format",
            message:
              "Retained protobuf bytes contradict their source descriptor",
          },
        ]);
      budget.charge(
        2048 +
          8 *
            (field.pointer.length +
              (contentType?.length ?? 0) +
              (schemaSource?.descriptor_set_path.length ?? 0) +
              (schemaSource?.message_type.length ?? 0)),
      );
      schema?.reset();
      let exclusion:
        | "explicit-sensitive-value"
        | "transport-credential"
        | undefined;
      const result = await decodeProtobufBody(
        body,
        framing,
        {
          pointer: field.pointer,
          content_type: contentType ?? null,
          body_sha256: field.sha256,
        },
        redact,
        budget,
        schema,
        {
          decoded: (data) => {
            if (
              !redactions.sensitiveBytes(
                Buffer.from(data.buffer, data.byteOffset, data.byteLength),
              )
            )
              return false;
            exclusion = "explicit-sensitive-value";
            return true;
          },
          header: (name) => {
            if (!isCaptureCredentialHeader(name)) return false;
            exclusion = "transport-credential";
            return true;
          },
        },
      );
      if (exclusion !== undefined) {
        excludeBody(record, field.pointer, exclusion);
        binaryByPointer.delete(field.pointer);
        incomplete = true;
        continue;
      }
      if (schemaSource !== undefined) result.schema = schemaSource;
      if (
        result.status !== "complete" ||
        result.fields.some(
          (field) =>
            field.schema_status !== undefined &&
            field.schema_status !== "decoded",
        )
      )
        incomplete = true;
      decoded.push(result);
    }
    if (decoded.length > 0) record.protobuf = decoded;
    capture.protobuf_coverage.inspected_records++;
  }
  if (
    !incomplete &&
    capture.protobuf_coverage.inspected_records ===
      capture.protobuf_coverage.selected_records
  )
    capture.protobuf_coverage.status = "complete";
};
