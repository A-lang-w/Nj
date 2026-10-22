import type { OwnedProviderProcessSpawnOptions } from "../process/ProviderProcess.js";
import {
  McpStdioTransport,
  type McpProcessLauncher,
  type McpTransportFailure,
} from "../providers/McpStdioTransport.js";

/** Shared stdio MCP transport attributed to the JADX bridge. */
export class JadxMcpTransport extends McpStdioTransport {
  constructor(
    options: Omit<OwnedProviderProcessSpawnOptions, "runId" | "stdin">,
    launcher?: McpProcessLauncher,
  ) {
    super(options, launcher, "jadx");
  }
}

export type JadxLauncher = McpProcessLauncher;
export type JadxTransportFailure = McpTransportFailure;
