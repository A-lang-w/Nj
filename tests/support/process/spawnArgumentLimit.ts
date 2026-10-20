import { Buffer } from "node:buffer";

/**
 * Largest single argv or environment string Linux will pass to `execve` on a
 * 4 KiB page host. The kernel's `MAX_ARG_STRLEN` is 32 pages and includes the
 * trailing NUL, so the caller-visible budget is one byte smaller. GitHub
 * Actions runners use 4 KiB pages. `ARG_MAX` (often 2 MiB) limits the combined
 * argv and environment; one argument past this per-string budget still fails
 * with `E2BIG` before the process starts.
 */
export const LINUX_4K_SINGLE_ARGUMENT_BYTES = 32 * 4096 - 1;

/** Require every argv string to fit in the Linux single-argument budget. */
export const assertSpawnArgumentsWithinLimit = (
  arguments_: readonly string[],
): void => {
  for (const argument of arguments_) {
    const bytes = Buffer.byteLength(argument);
    if (bytes > LINUX_4K_SINGLE_ARGUMENT_BYTES) {
      throw new Error(
        `spawn argument is ${bytes} bytes; one Linux argument above ${LINUX_4K_SINGLE_ARGUMENT_BYTES} bytes fails with E2BIG before the process starts. Pass the payload through a file.`,
      );
    }
  }
};
