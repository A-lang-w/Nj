import { createServer } from "node:net";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, onTestFinished, vi } from "vitest";

import { CutterBridgeClient } from "../../../src/cutter/CutterBridgeClient.js";
import { ConfigurationError } from "../../../src/domain/configurationErrors.js";
import { AnalysisResourceConstraintError } from "../../../src/domain/analysisErrorCore.js";
import {
  authenticatedServer,
  writeDescriptor,
} from "../../fixtures/cutterBridgeProtocol.js";

const SESSION = "00000000-0000-4000-8000-000000000001";
const TOKEN = "bridge-token-0123456789abcdef";

const privateDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "rea-cutter-request-limit-"));
  await chmod(directory, 0o700);
  onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
};

const listen = async (
  server: ReturnType<typeof createServer>,
): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected an ephemeral IPv4 listener");
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  return address.port;
};

const clientFor = (directory: string, ceiling: string): CutterBridgeClient => {
  const client = new CutterBridgeClient({
    REA_CUTTER_BRIDGE_DIR: directory,
    REA_BRIDGE_MAX_REQUEST_BYTES: ceiling,
  });
  onTestFinished(() => client.close());
  return client;
};

it("rejects a bridge ceiling below the floor at client construction", () => {
  expect(
    () =>
      new CutterBridgeClient({
        REA_BRIDGE_MAX_REQUEST_BYTES: "7463",
      }),
  ).toThrow(ConfigurationError);
});

it("reports a Cutter ceiling mismatch during discovery before opening a socket", async () => {
  const directory = await privateDirectory();
  await writeDescriptor(directory, SESSION, 1, TOKEN);
  const client = clientFor(directory, "8192");
  await expect(client.listSessions()).rejects.toSatisfy((error: unknown) => {
    expect(error).toBeInstanceOf(AnalysisResourceConstraintError);
    if (!(error instanceof AnalysisResourceConstraintError)) return false;
    expect(error.operation).toBe("list_cutter_sessions");
    expect(error.reason).toContain("REA_BRIDGE_MAX_REQUEST_BYTES");
    expect(error.reason).toContain("8192");
    expect(error.reason).toContain("16777216");
    expect(error.reason).toContain("source setting");
    expect(error.reason).toContain("7464");
    expect(error.reason).toContain("536870887");
    expect(error.reason).toContain(
      "No status request was sent to the mismatched session.",
    );
    expect(error.remediationAction).toContain(
      "Set REA_BRIDGE_MAX_REQUEST_BYTES",
    );
    return true;
  });
});

it("fails discovery when one live session matches and another ceiling does not", async () => {
  const directory = await privateDirectory();
  const server = authenticatedServer(TOKEN, SESSION, () => undefined);
  const port = await listen(server);
  const other = "00000000-0000-4000-8000-000000000002";
  await writeDescriptor(directory, SESSION, port, TOKEN, {
    maxRequestBytes: 8192,
  });
  await writeDescriptor(directory, other, 1, TOKEN);
  const client = clientFor(directory, "8192");
  await expect(client.listSessions()).rejects.toSatisfy((error: unknown) => {
    expect(error).toBeInstanceOf(AnalysisResourceConstraintError);
    if (!(error instanceof AnalysisResourceConstraintError)) return false;
    expect(error.operation).toBe("list_cutter_sessions");
    expect(error.resource).toBe("transport");
    expect(error.reportedLimits).toMatchObject({
      bridge_max_request_bytes: 16_777_216,
      client_max_request_bytes: 8192,
    });
    expect(error.reason).toContain("REA_BRIDGE_MAX_REQUEST_BYTES");
    expect(error.reason).toContain("8192");
    expect(error.reason).toContain("16777216");
    expect(error.reason).toContain("source setting");
    expect(error.reason).toContain("7464");
    expect(error.reason).toContain("536870887");
    expect(error.reason).toContain(
      "No status request was sent to the mismatched session.",
    );
    return true;
  });
});

it("reports a Cutter ceiling mismatch before opening a command socket", async () => {
  const directory = await privateDirectory();
  await writeDescriptor(directory, SESSION, 1, TOKEN);
  const client = clientFor(directory, "33554432");
  await expect(
    client.execute({
      sessionId: SESSION,
      expectedGeneration: 0,
      command: "ij",
      json: false,
    }),
  ).rejects.toSatisfy((error: unknown) => {
    expect(error).toBeInstanceOf(AnalysisResourceConstraintError);
    if (!(error instanceof AnalysisResourceConstraintError)) return false;
    expect(error.reason).toContain("REA_BRIDGE_MAX_REQUEST_BYTES");
    expect(error.reason).toContain("33554432");
    expect(error.reason).toContain("16777216");
    expect(error.reason).toContain("No command was sent.");
    expect(error.reason).not.toContain("no runtime override");
    expect(error.remediationAction).toContain(
      "Set REA_BRIDGE_MAX_REQUEST_BYTES",
    );
    return true;
  });
});

it("lowers the Cutter command ceiling for both the refusal and a live command", async () => {
  const directory = await privateDirectory();
  let connections = 0;
  const server = authenticatedServer(TOKEN, SESSION, (request, respond) => {
    respond({
      ok: true,
      session_id: SESSION,
      output: request.command,
      execution_state: "complete",
      document_generation: 0,
      identity_status: "partial",
    });
  });
  server.on("connection", () => {
    connections += 1;
  });
  const port = await listen(server);
  await writeDescriptor(directory, SESSION, port, TOKEN, {
    maxRequestBytes: 8192,
  });
  const client = clientFor(directory, "8192");
  await expect(
    client.execute({
      sessionId: SESSION,
      expectedGeneration: 0,
      command: "c".repeat(8000),
      json: false,
    }),
  ).rejects.toSatisfy((error: unknown) => {
    expect(error).toBeInstanceOf(AnalysisResourceConstraintError);
    if (!(error instanceof AnalysisResourceConstraintError)) return false;
    expect(error.reason).toContain("authenticated frame limit of 8192 bytes");
    expect(error.reason).toContain("no command was sent");
    expect(error.reason).toContain("REA_BRIDGE_MAX_REQUEST_BYTES");
    expect(error.reason).not.toContain("no runtime override");
    return true;
  });
  expect(connections).toBe(0);
  await expect(
    client.execute({
      sessionId: SESSION,
      expectedGeneration: 0,
      command: "ij",
      json: false,
    }),
  ).resolves.toMatchObject({
    output: "ij",
    executionState: "complete",
  });
});

const responseEnvelopeBytes = (output: string): number => {
  const response = JSON.stringify({
    ok: true,
    output,
    execution_state: "complete",
    document_generation: 0,
    identity_status: "partial",
  });
  return Buffer.byteLength(JSON.stringify({ response, proof: "0".repeat(64) }));
};

const outputForEnvelope = (target: number): string => {
  const count = target - responseEnvelopeBytes("");
  if (responseEnvelopeBytes("A".repeat(count)) !== target)
    throw new Error(`expected an exact ${String(target)}-byte response frame`);
  return "A".repeat(count);
};

it("refuses an escaped Cutter command before serializing it", async () => {
  const directory = await privateDirectory();
  let connections = 0;
  const server = authenticatedServer(TOKEN, SESSION, (_request, respond) => {
    respond({
      ok: true,
      output: null,
      execution_state: "complete",
      document_generation: 0,
      identity_status: "partial",
    });
  });
  server.on("connection", () => {
    connections += 1;
  });
  const port = await listen(server);
  await writeDescriptor(directory, SESSION, port, TOKEN, {
    maxRequestBytes: 8192,
  });
  const client = clientFor(directory, "8192");
  const command = "\u0001".repeat(2000);
  const stringify = vi.spyOn(JSON, "stringify");
  try {
    await expect(
      client.execute({
        sessionId: SESSION,
        expectedGeneration: 0,
        command,
        json: false,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AnalysisResourceConstraintError);
      if (!(error instanceof AnalysisResourceConstraintError)) return false;
      expect(error.reason).toContain("authenticated frame limit of 8192 bytes");
      expect(error.reason).toContain("no command was sent");
      expect(error.reason).toContain("REA_BRIDGE_MAX_REQUEST_BYTES");
      return true;
    });
    expect(connections).toBe(0);
    expect(
      stringify.mock.calls.some((call) => {
        const value: unknown = call[0];
        return (
          typeof value === "object" &&
          value !== null &&
          "command" in value &&
          value.command === command
        );
      }),
    ).toBe(false);
  } finally {
    stringify.mockRestore();
  }
});

it("accepts a Cutter response at the ceiling and excludes the terminating LF", async () => {
  const directory = await privateDirectory();
  const ceiling = 8192;
  const output = outputForEnvelope(ceiling);
  const server = authenticatedServer(TOKEN, SESSION, (request, respond) => {
    if (request.kind === "ack") {
      respond({ ok: true, acknowledged: true });
      return;
    }
    const command = request.command;
    const body = {
      ok: true,
      output: command === "over" ? `${output}A` : output,
      execution_state: "complete",
      document_generation: 0,
      identity_status: "partial",
    };
    if (command === "split") respond(body, { chunkBytes: ceiling });
    else respond(body);
  });
  const port = await listen(server);
  await writeDescriptor(directory, SESSION, port, TOKEN, {
    maxRequestBytes: ceiling,
  });
  const client = clientFor(directory, String(ceiling));
  await expect(
    client.execute({
      sessionId: SESSION,
      expectedGeneration: 0,
      command: "exact",
      json: false,
    }),
  ).resolves.toMatchObject({
    output,
    executionState: "complete",
  });
  await expect(
    client.execute({
      sessionId: SESSION,
      expectedGeneration: 0,
      command: "split",
      json: false,
    }),
  ).resolves.toMatchObject({
    output,
    executionState: "complete",
  });
  const oversize = await client.execute({
    sessionId: SESSION,
    expectedGeneration: 0,
    command: "over",
    json: false,
  });
  expect(oversize).toMatchObject({
    executionState: "unknown",
    error: "transport-response-missing",
  });
  expect(oversize.message).toContain("8192");
  expect(oversize.message).toContain("REA_BRIDGE_MAX_REQUEST_BYTES");
  expect(oversize.message).toContain("may have completed");
  expect(oversize.message).not.toContain("no runtime override");
});

it("sends a Cutter command above 16 MiB when both sides raise the ceiling", async () => {
  const directory = await privateDirectory();
  const ceiling = 17 * 1024 * 1024;
  const command = "h".repeat(16 * 1024 * 1024);
  const server = authenticatedServer(TOKEN, SESSION, (request, respond) => {
    respond({
      ok: true,
      session_id: SESSION,
      output: typeof request.command === "string" ? request.command.length : 0,
      execution_state: "complete",
      document_generation: 0,
      identity_status: "partial",
    });
  });
  const port = await listen(server);
  await writeDescriptor(directory, SESSION, port, TOKEN, {
    maxRequestBytes: ceiling,
  });
  const raised = clientFor(directory, String(ceiling));
  await expect(
    raised.execute({
      sessionId: SESSION,
      expectedGeneration: 0,
      command,
      json: false,
    }),
  ).resolves.toMatchObject({
    output: command.length,
    executionState: "complete",
  });

  const directoryForDefault = await privateDirectory();
  await writeDescriptor(directoryForDefault, SESSION, port, TOKEN, {
    maxRequestBytes: ceiling,
  });
  const defaults = new CutterBridgeClient({
    REA_CUTTER_BRIDGE_DIR: directoryForDefault,
  });
  onTestFinished(() => defaults.close());
  await expect(
    defaults.execute({
      sessionId: SESSION,
      expectedGeneration: 0,
      command: "ij",
      json: false,
    }),
  ).rejects.toBeInstanceOf(AnalysisResourceConstraintError);
});
