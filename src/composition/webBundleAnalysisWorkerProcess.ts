import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  for (let index = start; index < scriptBytes.length; index += 1) {
    await send({ kind: "start", index });
    const files = webBundleWorkerFileNames(index);
    const script = webBundleWorkerScriptSchema.parse(
      await readJson(join(root, files.script), scriptBytes[index] ?? 0),
    );
    if (!isIncludedScript(script))
      throw new TypeError("Web bundle worker requires included script source");
    const text = JSON.stringify(analyzeWebBundleScript(script));
    const bytes = Buffer.byteLength(text);
    if (bytes > resultBytes) {
      await send({ kind: "oversized", index, bytes });
      continue;
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
  }
};

await execute();
