import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { activityEvents, threads } from "../db/schema.js";
import { subscribe } from "../domain/events.js";
import { logger } from "../lib/logger.js";

/** Events too chatty for durable inbox rows. */
const SKIP_EVENTS = new Set(["message.delta"]);

/**
 * Persist domain events that resolve to a workspaceId so the Inbox activity
 * feed has a producer. Failures are logged and never thrown — activity is
 * best-effort telemetry, not a write-path dependency.
 */
export function startActivitySink(): () => void {
  return subscribe((event, data) => {
    if (SKIP_EVENTS.has(event)) return;
    void persistActivity(event, data);
  });
}

async function persistActivity(event: string, data: unknown): Promise<void> {
  if (data === null || typeof data !== "object") return;
  const payload = data as Record<string, unknown>;
  let workspaceId =
    typeof payload.workspaceId === "number" &&
    Number.isInteger(payload.workspaceId)
      ? payload.workspaceId
      : null;
  if (
    workspaceId === null &&
    typeof payload.threadId === "number" &&
    Number.isInteger(payload.threadId)
  ) {
    try {
      const [row] = await db
        .select({ workspaceId: threads.workspaceId })
        .from(threads)
        .where(eq(threads.id, payload.threadId))
        .limit(1);
      workspaceId = row?.workspaceId ?? null;
    } catch {
      return;
    }
  }
  if (workspaceId === null) return;

  const userId = typeof payload.userId === "number" ? payload.userId : null;
  const targetId =
    typeof payload.id === "number"
      ? payload.id
      : typeof payload.threadId === "number"
        ? payload.threadId
        : typeof payload.messageId === "number"
          ? payload.messageId
          : null;
  const targetType = inferTargetType(event, payload);

  try {
    await db.insert(activityEvents).values({
      workspaceId,
      userId,
      eventType: event,
      targetType,
      targetId,
      metadataJson: payload,
    });
  } catch (err) {
    logger.warn("Failed to persist activity event", {
      event,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function inferTargetType(
  event: string,
  payload: Record<string, unknown>,
): string | null {
  if (typeof payload.targetType === "string") return payload.targetType;
  if (event.startsWith("thread.") || event.startsWith("message."))
    return "thread";
  if (event.startsWith("memory.")) return "memory";
  if (event.startsWith("skill.") || event.startsWith("community.skill."))
    return "skill";
  if (event.startsWith("agent.")) return "agent";
  if (event.startsWith("file.")) return "file";
  if (event.startsWith("mcp_server.")) return "mcp_server";
  return null;
}
