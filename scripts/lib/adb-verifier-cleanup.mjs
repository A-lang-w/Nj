import { adbArguments } from "../../dist/adb/AdbCommand.js";
import { execFileOutput } from "../../dist/process/ExecFileOutput.js";

const CLEANUP_TIMEOUT_MS = 10_000;
const CLEANUP_MAX_OUTPUT_BYTES = 64 * 1024;

export async function removeVerifierProbeFile(binary, serial, devicePath) {
  await execFileOutput(
    binary,
    adbArguments(serial, ["shell", "rm", "-f", "--", devicePath]),
    {
      timeout: CLEANUP_TIMEOUT_MS,
      maxBuffer: CLEANUP_MAX_OUTPUT_BYTES,
      stopSignal: "SIGTERM",
    },
  );
}
