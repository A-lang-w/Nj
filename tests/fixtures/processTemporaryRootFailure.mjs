import filesystem, { appendFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, isAbsolute } from "node:path";

const marker = process.env.REA_TEST_PROCESS_TEMP_FAILURE_MARKER;
if (marker === undefined || !isAbsolute(marker))
  throw new Error(
    "Process temporary-root fixture requires an absolute marker path",
  );

const mkdtemp = filesystem.mkdtemp;
filesystem.mkdtemp = async (prefix, options) => {
  // Keep platform ownership preflight (including rea-process-token- roots) real.
  if (typeof prefix === "string" && basename(prefix) === "rea-process-") {
    await appendFile(
      marker,
      `${JSON.stringify({ syscall: "mkdtemp", prefix })}\n`,
    );
    throw Object.assign(
      new Error("controlled process temporary-root failure"),
      {
        code: "ENOENT",
        syscall: "mkdtemp",
        path: prefix,
      },
    );
  }
  return mkdtemp(prefix, options);
};
syncBuiltinESMExports();
