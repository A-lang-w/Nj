import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { logger } from "./lib/logger.js";

const WEAK_JWT_PLACEHOLDER = "change-me-to-random-64-char-string";

const rawJwtSecret = process.env.JWT_SECRET;
if (!rawJwtSecret || rawJwtSecret === WEAK_JWT_PLACEHOLDER) {
  throw new Error(
    `FATAL: JWT_SECRET is not configured. Generate a secure secret (e.g., node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") and set it in your environment or .env file.`,
  );
}

const parsedSessionMaxAgeDays = parseInt(
  process.env.SESSION_MAX_AGE_DAYS || "30",
  10,
);
const parsedSkewToleranceMs = parseInt(
  process.env.SESSION_SKEW_TOLERANCE_MS || "60000",
  10,
);
// Must stay below sessionSkewToleranceMs under default config: the auth
// middleware only logs while accepting a session that is past wall-clock
// expiry but still inside the tolerance window. A threshold larger than
// the window can never fire.
const parsedSkewLogThresholdMs = parseInt(
  process.env.SESSION_SKEW_LOG_THRESHOLD_MS || "10000",
  10,
);

export const config = {
  llmBaseUrl: process.env.LLM_BASE_URL || "http://localhost:11434/v1",
  llmApiKey: process.env.LLM_API_KEY || "ollama",
  llmModel: process.env.LLM_MODEL || "claude-opus-5-5",
  jwtSecret: rawJwtSecret,
  sessionMaxAgeDays:
    Number.isFinite(parsedSessionMaxAgeDays) && parsedSessionMaxAgeDays > 0
      ? parsedSessionMaxAgeDays
      : 30,
  // Clock-skew tolerance for session expiry checks (auth/middleware.ts).
  // Validated like sessionMaxAgeDays: garbage or negative input falls back
  // to the default instead of NaN, which would fail OPEN (every comparison
  // against NaN is false, so sessions would never expire).
  sessionSkewToleranceMs:
    Number.isFinite(parsedSkewToleranceMs) && parsedSkewToleranceMs >= 0
      ? parsedSkewToleranceMs
      : 60_000,
  sessionSkewLogThresholdMs:
    Number.isFinite(parsedSkewLogThresholdMs) && parsedSkewLogThresholdMs >= 0
      ? parsedSkewLogThresholdMs
      : 10_000,
  dataDir: process.env.DATA_DIR || "./data",
  residencyStrict: process.env.RESIDENCY_STRICT !== "false",
  port: parseInt(process.env.PORT || "3000", 10),
  host: process.env.HOST || "127.0.0.1",
  // SEC-006: When false (default), rate limiting uses the socket remote address
  // to prevent bypass via spoofable x-forwarded-for / x-real-ip headers.
  // Set to true only when running behind a known trusted reverse proxy.
  trustProxy: process.env.TRUST_PROXY === "true",
  // SEC-005: Session cookie Domain. Empty (default) = host-only cookie for
  // the request Host, so both 127.0.0.1 and localhost work. The old default
  // of "localhost" broke sessions when the UI was opened on 127.0.0.1 (cookie
  // rejected or never sent). Set COOKIE_DOMAIN only behind a reverse proxy
  // that needs an explicit shared parent domain.
  cookieDomain: process.env.COOKIE_DOMAIN ?? "",
  // Secure cookies require HTTPS (or a browser that treats the host as a
  // secure context). Default off on loopback HTTP so sessions survive full
  // page loads in Chromium/automation; set COOKIE_SECURE=true behind TLS.
  cookieSecure:
    process.env.COOKIE_SECURE === "true"
      ? true
      : process.env.COOKIE_SECURE === "false"
        ? false
        : !["127.0.0.1", "localhost", "::1"].includes(
            process.env.HOST || "127.0.0.1",
          ),
} as const;

/**
 * Verifies that DATA_DIR resides on an acceptable local mount point.
 *
 * ## RESIDENCY_STRICT=false (logging-only mode)
 * When disabled, this function logs a warning and returns without performing
 * any mount-point verification. This is an **accepted risk for local development
 * and testing only**. No enforcement occurs; data may reside on any filesystem,
 * including network mounts, cloud-synced volumes, or removable media. Operators
 * acknowledge that data residency guarantees are void in this mode.
 *
 * ## RESIDENCY_STRICT=true (enforced mode — default)
 * Requires that DATA_DIR be located on a verified local (non-network) volume.
 * On Linux, parses `/proc/mounts` to identify the backing device. On macOS,
 * invokes `df -P` to resolve the mount device. Rejects known remote/network
 * filesystem prefixes (NFS, CIFS/SMB, SSHFS, AFP). Throws if the platform is
 * unsupported, the mount cannot be determined, or the path resolves to a
 * remote device.
 *
 * For Canadian data-residency compliance, ensure DATA_DIR points to a volume
 * physically located within Canada before enabling strict mode in production.
 * Mount verification confirms locality of the storage device but does not
 * certify geographic jurisdiction; combine with infrastructure attestations
 * as required by your compliance framework.
 */
export function verifyDataResidency(
  input: { dataDir: string; residencyStrict: boolean } = config,
): void {
  const absPath = path.resolve(input.dataDir);
  if (!fs.existsSync(absPath)) {
    fs.mkdirSync(absPath, { recursive: true });
  }
  logger.info("[Residency] DATA_DIR resolved", { dataDir: absPath });
  logger.info("[Residency] Strict mode", {
    residencyStrict: input.residencyStrict,
  });

  if (!input.residencyStrict) {
    logger.warn(
      "[Residency] RESIDENCY_STRICT is disabled. Data residency enforcement is OFF. " +
        "Set RESIDENCY_STRICT=true for production deployments.",
    );
    return;
  }

  // Strict mode: verify DATA_DIR is on a local mount point
  const platform = os.platform();
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error(
      `[Residency] RESIDENCY_STRICT is enabled but platform "${platform}" is not supported for mount verification. ` +
        `Supported platforms: linux, darwin.`,
    );
  }

  let mountDevice: string | null = null;

  if (platform === "linux") {
    // Parse /proc/mounts to find the device backing absPath
    try {
      const mountsContent = fs.readFileSync("/proc/mounts", "utf-8");
      const lines = mountsContent.split("\n");
      // Find the longest matching mount point for absPath
      let bestMatch = "";
      let bestDevice = "";
      // /proc/mounts octal-escapes spaces/tabs/newlines/backslashes in
      // paths (e.g. /mnt/my\040drive): unescape before comparing or a
      // space-bearing mount never matches and the path misattributes to
      // its parent (wrongly passing a remote mount or blocking a local one).
      const unescape = (s: string): string =>
        s.replace(/\\([0-7]{3})/g, (_m, oct: string) =>
          String.fromCharCode(parseInt(oct, 8)),
        );
      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length < 2) continue;
        const device = unescape(parts[0]);
        const mountPoint = unescape(parts[1]);
        // Segment-boundary match: a naive startsWith would attribute /data2
        // to a /data mount (and vice versa defeat the remote check). Root
        // matches everything; other mounts must equal the path or prefix it
        // on a separator boundary.
        const underMount =
          mountPoint === "/" ||
          absPath === mountPoint ||
          absPath.startsWith(mountPoint + "/");
        if (underMount && mountPoint.length > bestMatch.length) {
          bestMatch = mountPoint;
          bestDevice = device;
        }
      }
      if (bestDevice) {
        mountDevice = bestDevice;
      }
    } catch (err) {
      throw new Error(
        `[Residency] Failed to read /proc/mounts for residency verification: ${(err as Error).message}`,
      );
    }
  } else {
    // macOS: use df to determine the device for absPath. execFileSync (no
    // shell) so a hostile DATA_DIR value cannot inject commands.
    try {
      const dfOutput = execFileSync("df", ["-P", absPath], {
        encoding: "utf-8",
        timeout: 5000,
      });
      const lines = dfOutput.trim().split("\n");
      if (lines.length >= 2) {
        // df -P output: Filesystem 1024-blocks Used Available Capacity Mounted-on
        // The device is the first column of the second line
        const dataLine = lines[1];
        const device = dataLine.split(/\s+/)[0];
        if (device) {
          mountDevice = device;
        }
      }
    } catch (err) {
      throw new Error(
        `[Residency] Failed to run df for residency verification: ${(err as Error).message}`,
      );
    }
  }

  if (!mountDevice) {
    throw new Error(
      `[Residency] Could not determine mount device for DATA_DIR "${absPath}". ` +
        `Verify that DATA_DIR points to a valid local path.`,
    );
  }

  // Reject network/virtual filesystems by checking for known remote prefixes
  const remotePrefixes = [
    "//",
    "nfs:",
    "cifs:",
    "smb:",
    "sshfs:",
    "fuse.sshfs",
    "afp://",
  ];
  const isRemote = remotePrefixes.some((prefix) =>
    mountDevice!.startsWith(prefix),
  );
  if (isRemote) {
    throw new Error(
      `[Residency] DATA_DIR "${absPath}" is on a remote/network filesystem (${mountDevice}). ` +
        `Data residency policy requires a local mount. Set RESIDENCY_STRICT=false to override (not recommended).`,
    );
  }

  logger.info("[Residency] Verified: DATA_DIR is on local device", {
    mountDevice,
  });
}
