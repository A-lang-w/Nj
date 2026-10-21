import path from "node:path";
import fs from "node:fs";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

export interface ResidencyCheckInput {
  dataDir: string;
  residencyStrict: boolean;
  llmBaseUrl: string;
}

export function verifyResidency(input: ResidencyCheckInput = config): void {
  const absDataDir = path.resolve(input.dataDir);

  if (!fs.existsSync(absDataDir)) {
    fs.mkdirSync(absDataDir, { recursive: true });
  }

  const stat = fs.statSync(absDataDir);
  if (!stat.isDirectory()) {
    throw new Error(`DATA_DIR is not a directory: ${absDataDir}`);
  }

  logger.info("[Residency] DATA_DIR resolved", { dataDir: absDataDir });
  logger.info("[Residency] Strict mode", {
    residencyStrict: input.residencyStrict,
  });
  // Log via the redacting logger: embedded credentials in a base URL must
  // not land in plaintext console output.
  logger.info("[Residency] LLM endpoint", { llmBaseUrl: input.llmBaseUrl });

  // Hostnames are case-insensitive: match lowercased so GHOSTCLI.CLOUD
  // cannot bypass the strict-mode block.
  if (
    input.residencyStrict &&
    input.llmBaseUrl.toLowerCase().includes("ghostcli.cloud")
  ) {
    logger.warn(
      "[Residency] ghostcli.cloud routes through US infrastructure (Virginia). " +
        "This violates strict Canadian data residency. Set RESIDENCY_STRICT=false to allow.",
    );
    throw new Error(
      "Strict residency mode blocks non-Canadian LLM endpoint. Use local Ollama or set RESIDENCY_STRICT=false.",
    );
  }
}
