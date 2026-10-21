import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { streamSSE } from "hono/streaming";
import { authMiddleware } from "../auth/middleware.js";
import { listOwnedWorkspaceIds } from "../auth/workspace.js";
import { db } from "../db/connection.js";
import { threads } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import {
  emitEvent,
  subscribe,
  getEventBuffer,
  getEventCounter,
  getBootEpoch,
} from "../domain/events.js";

// Re-export emitEvent so other route modules can import it from './events.js'
// instead of reaching into '../domain/events.js' directly.
export { emitEvent };

/**
 * SEC-TENANT: Drop events that clearly belong to another workspace. Payloads
 * with `workspaceId` are filtered directly; payloads with only `threadId`
 * resolve the thread's workspace. Community broadcast events (no tenant
 * fields) stay visible. Bare private ids without a tenant key are withheld.
 */
function eventVisibleToWorkspaces(
  event: string,
  data: unknown,
  owned: Set<number>,
  threadWorkspaceCache: Map<number, number | null>,
): boolean {
  if (event.startsWith("community.")) return true;
  if (data === null || typeof data !== "object") return false;
  const payload = data as { workspaceId?: unknown; threadId?: unknown };
  if (typeof payload.workspaceId === "number") {
    return owned.has(payload.workspaceId);
  }
  if (typeof payload.threadId === "number") {
    let wsId = threadWorkspaceCache.get(payload.threadId);
    if (wsId === undefined) {
      const row = db
        .select({ workspaceId: threads.workspaceId })
        .from(threads)
        .where(eq(threads.id, payload.threadId))
        .get();
      wsId = row?.workspaceId ?? null;
      threadWorkspaceCache.set(payload.threadId, wsId);
    }
    return wsId !== null && owned.has(wsId);
  }
  return false;
}

export const eventsRouter = new Hono();

interface BufferedSnapshotEntry {
  id: string;
  event: string;
  data: unknown;
}

interface ReplayPlan {
  replayEvents: BufferedSnapshotEntry[];
  cursorEvicted: boolean;
}

/**
 * Decides what a reconnecting client needs from a buffer snapshot: which
 * retained events to replay and whether its cursor is evicted (or belongs
 * to a previous boot epoch), requiring an explicit gap signal.
 */
function planReplay(
  bufferSnapshot: BufferedSnapshotEntry[],
  oldestId: string | null,
  lastSeen: number,
  epochReset: boolean,
): ReplayPlan {
  const replayEvents = epochReset
    ? bufferSnapshot
    : Number.isFinite(lastSeen)
      ? bufferSnapshot.filter((b) => Number(b.id) > lastSeen)
      : [];
  const cursorEvicted =
    epochReset ||
    (Number.isFinite(lastSeen) &&
      ((oldestId !== null && lastSeen < Number(oldestId)) ||
        (oldestId === null && lastSeen < getEventCounter())));
  return { replayEvents, cursorEvicted };
}

eventsRouter.get("/stream", authMiddleware, (c) => {
  const lastEventId = c.req.query("lastEventId") ?? null;
  const clientEpoch = c.req.query("epoch") ?? null;

  return streamSSE(c, async (stream) => {
    const ownedWorkspaces = await listOwnedWorkspaceIds(c);
    const threadWorkspaceCache = new Map<number, number | null>();
    const visible = (event: string, data: unknown) =>
      eventVisibleToWorkspaces(
        event,
        data,
        ownedWorkspaces,
        threadWorkspaceCache,
      );

    // Subscribe BEFORE replaying: replay writes await the socket, yielding
    // to the event loop, so anything emitted during replay would fall past
    // the snapshot but before a later subscribe and be lost. Live events
    // arriving mid-replay queue up and flush after the snapshot, in id order.
    // NOTE: emitEvent must only be called from the main event loop thread;
    // this ordering guards against races but does not make emitEvent thread-safe.
    let replaying = true;
    const liveQueue: Array<{ event: string; data: unknown; id: string }> = [];
    const unsubscribe = subscribe((event, data, id) => {
      if (stream.aborted) return;
      if (!visible(event, data)) return;
      if (replaying) {
        liveQueue.push({ event, data, id });
        return;
      }
      void stream
        .writeSSE({
          event,
          data: JSON.stringify(data),
          id,
        })
        .catch((err) => {
          logger.error("[events] SSE write failed", { id, error: err });
        });
    });

    try {
      // Snapshot the buffer synchronously BEFORE any await: the snapshot and
      // the live queue then partition the id space exactly — everything
      // buffered at this instant replays from the snapshot, everything
      // emitted later lands in the queue. Awaiting first would double-send
      // arrivals (queued AND re-read from the buffer) and could evict
      // unreplayed events under a full buffer.
      const bufferSnapshot = [...getEventBuffer()];
      const oldestId = bufferSnapshot.length > 0 ? bufferSnapshot[0].id : null;
      const lastSeen = lastEventId !== null ? Number(lastEventId) : NaN;
      // Epoch check: event ids restart at 1 on every boot, so a numeric
      // cursor alone cannot distinguish "caught up" from "restarted and the
      // new counter has caught up with the old cursor". A boot-epoch mismatch
      // (or, for epoch-less clients, a cursor past the current counter)
      // means a previous epoch: replay everything and signal the gap.
      const epochMismatch =
        clientEpoch !== null &&
        clientEpoch !== "" &&
        clientEpoch !== getBootEpoch();
      const epochReset =
        epochMismatch ||
        (Number.isFinite(lastSeen) && lastSeen > getEventCounter());
      const { replayEvents, cursorEvicted } = planReplay(
        bufferSnapshot,
        oldestId,
        lastSeen,
        epochReset,
      );

      // Replay missed events from the snapshot when the client reconnects
      // with a cursor, or unconditionally after an epoch reset.
      if (cursorEvicted) {
        // The client's cursor predates the retained buffer: eviction
        // dropped events this replay cannot recover. Signal the gap
        // explicitly so the client resyncs instead of assuming completeness.
        // The gap carries no id: sharing oldestId would advance the
        // cursor across the hole and drop the oldest retained event on
        // the client's next reconnect.
        await stream.writeSSE({
          event: "replay.gap",
          data: JSON.stringify({ requestedId: lastEventId, oldestId }),
        });
      }
      for (const buffered of replayEvents) {
        if (!visible(buffered.event, buffered.data)) continue;
        await stream.writeSSE({
          event: buffered.event,
          data: JSON.stringify(buffered.data),
          id: buffered.id,
        });
      }

      // Drain the queue single-writer style with it still closed: events
      // arriving during a flush await append to the queue and are written in
      // id order. Opening the live path before the drain finishes would let
      // newer events jump ahead of queued ones and rewind the client cursor.
      let head = 0;
      while (head < liveQueue.length) {
        const queued = liveQueue[head];
        head++;
        if (stream.aborted) break;
        await stream.writeSSE({
          event: queued.event,
          data: JSON.stringify(queued.data),
          id: queued.id,
        });
      }
      liveQueue.length = 0;
      replaying = false;

      // Announce the boot epoch (id-less, like pings): the client echoes it
      // on reconnect so server restarts are detectable regardless of ids.
      // Ordering vs live events is irrelevant — the client only stores the
      // string for the next reconnect — so this stays outside the drain.
      if (!stream.aborted) {
        await stream.writeSSE({
          event: "server.epoch",
          data: JSON.stringify({ epoch: getBootEpoch() }),
        });
      }

      while (!stream.aborted) {
        await stream.sleep(30_000);
        if (!stream.aborted) {
          // Pings carry no id: they must not consume replay ids or advance
          // the client's cursor, which only tracks real buffered events.
          await stream.writeSSE({ event: "ping", data: "{}" });
        }
      }
    } finally {
      unsubscribe();
    }
  });
});
