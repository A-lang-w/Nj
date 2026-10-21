export type LogLevel = "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  [key: string]: unknown;
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9_-]{36,}/g,
  /xoxb-[A-Za-z0-9-]+/g,
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /password=[^\s&"']+/gi,
  /token=[^\s&"']+/gi,
  /api[_-]?key\s*=\s*[^\s&"']+/gi,
  /Authorization:\s*[^\s,;"'}\]]+/gi,
  /x-api-key:\s*[^\s,;"'}\]]+/gi,
  // Standalone JWTs (session/refresh tokens) outside an Authorization header.
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const pattern of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      result = result.replace(pattern, "[REDACTED]");
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  // Error details live on the prototype / non-enumerables, so a generic
  // Object.entries walk would drop the message: log name, redacted message,
  // the domain tag explicitly (DomainError subclasses carry `tag`), and the
  // redacted cause chain so wrapped provider reasons are not discarded.
  if (value instanceof Error) {
    const err = value as Error & { tag?: unknown; cause?: unknown };
    return {
      name: value.name,
      message: redactValue(value.message),
      ...(typeof err.tag === "string" ? { tag: err.tag } : {}),
      ...(err.cause !== undefined && err.cause !== null
        ? { cause: redactValue(err.cause) }
        : {}),
    };
  }
  if (value !== null && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      redacted[key] = redactValue(val);
    }
    return redacted;
  }
  return value;
}

function emit(
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>,
): void {
  const safeMeta = meta
    ? (redactValue(meta) as Record<string, unknown>)
    : undefined;
  const entry: LogEntry = {
    level,
    // The message channel gets the same treatment as meta: every current
    // caller passes a static string, but an interpolated secret must not
    // depend on caller discipline to stay out of the logs.
    message: redactValue(message) as string,
    timestamp: new Date().toISOString(),
    ...safeMeta,
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const logger = {
  info(message: string, meta?: Record<string, unknown>) {
    emit("info", message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>) {
    emit("warn", message, meta);
  },
  error(message: string, meta?: Record<string, unknown>) {
    emit("error", message, meta);
  },
};
