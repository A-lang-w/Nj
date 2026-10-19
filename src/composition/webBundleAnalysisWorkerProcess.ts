import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import {
  analyzeWebBundleScript,
  isIncludedScript,
} from "../domain/webBundleAnalyzerInspection.js";
import {
  WEB_BUNDLE_ANALYSIS_WORKER_LIMITS as LIMITS,
  WEB_BUNDLE_WORKER_MANIFEST,
  webBundleWorkerFileNames,
  webBundleWorkerFrameSchema,
  webBundleWorkerManifestSchema,
  webBundleWorkerRequestSchema,
  webBundleWorkerScriptSchema,
  type WebBundleWorkerFrame,
} from "../browser/WebBundleAnalysisWorkerProtocol.js";

const send = async (input: WebBundleWorkerFrame): Promise<void> => {
  const frame = `${JSON.stringify(webBundleWorkerFrameSchema.parse(input))}\n`;
  if (Buffer.byteLength(frame) > LIMITS.frameBytes)
    throw new RangeError("Web bundle worker frame exceeds its byte budget");
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(frame, (error) =>
      error === null || error === undefined ? resolve() : reject(error),
    );
  });
};

const count = (value: string | undefined): number => {
  if (value === undefined || !/^(?:0|[1-9][0-9]{0,15})$/u.test(value))
    throw new TypeError("Web bundle worker arguments are invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new TypeError("Web bundle worker arguments are invalid");
  return parsed;
};

/** Read one parent-written private JSON file of an exact byte length. */
const readJson = async (path: string, bytes: number): Promise<unknown> => {
  const data = await readStableArtifact(path, bytes);
  if (data.bytes.length !== bytes)
    throw new RangeError("Web bundle worker input size changed");
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(data.bytes),
  );
};

/** Analyze scripts from the parent-selected index, one private file each. */
const execute = async (): Promise<void> => {
  const root = process.cwd();
  const manifestBytes = count(process.argv[2]);
  const start = count(process.argv[3]);
  const resultBytes = count(process.argv[4]);
  const { script_bytes: scriptBytes } = webBundleWorkerManifestSchema.parse(
    await readJson(join(root, WEB_BUNDLE_WORKER_MANIFEST), manifestBytes),
  );
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const requests = input[Symbol.asyncIterator]();
  try {
    await send({ kind: "ready" });
    for (let index = start; index < scriptBytes.length; index += 1) {
      const next = await requests.next();
      if (next.done || Buffer.byteLength(next.value) > LIMITS.frameBytes)
        throw new TypeError(
          "Web bundle worker request is missing or oversized",
        );
      const raw: unknown = JSON.parse(next.value);
      const request = webBundleWorkerRequestSchema.parse(raw);
      if (request.index !== index)
        throw new TypeError(
          "Web bundle worker request names an unexpected script",
        );
      await analyzeScript(root, index, scriptBytes[index] ?? 0, resultBytes);
    }
  } finally {
    input.close();
    process.stdin.pause();
  }
};

/** Release the current script's source and facts before waiting for admission. */
const analyzeScript = async (
  root: string,
  index: number,
  scriptBytes: number,
  resultBytes: number,
): Promise<void> => {
  await send({ kind: "start", index });
  const files = webBundleWorkerFileNames(index);
  const script = webBundleWorkerScriptSchema.parse(
    await readJson(join(root, files.script), scriptBytes),
  );
  if (!isIncludedScript(script))
    throw new TypeError("Web bundle worker requires included script source");
  const text = JSON.stringify(analyzeWebBundleScript(script));
  const bytes = Buffer.byteLength(text);
  if (bytes > resultBytes) {
    await send({ kind: "oversized", index, bytes });
    return;
  }
  await writeFile(join(root, files.facts), text, {
    flag: "wx",
    mode: 0o600,
  });
  await send({
    kind: "done",
    index,
    bytes,
    sha256: createHash("sha256").update(text).digest("hex"),
  });
};

await execute();
