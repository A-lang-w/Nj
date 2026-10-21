import { randomUUID } from "node:crypto";

type EventListener = (event: string, data: unknown, id: string) => void;

const listeners = new Set<EventListener>();

interface BufferedEvent {
  id: string;
  event: string;
  data: unknown;
  timestamp: number;
  /** Boot epoch that issued this event; distinguishes post-restart id reuse. */
  epoch: string;
}

const EVENT_BUFFER_SIZE = 100;
const EVENT_BUFFER_TTL_MS = 5 * 60 * 1000; // 5 minutes
const EVENT_BUFFER_CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds
const eventBuffer: BufferedEvent[] = [];
let eventCounter = 0;
// Unique per process boot: event ids restart at 1 on every boot, so a
// numeric cursor alone cannot tell "caught up" from "restarted and the new
// counter has caught up with the old cursor". Clients echo this back on
// reconnect; a mismatch forces a gap + full-buffer replay.
let bootEpoch = randomUUID();

/**
 * Periodically evicts buffered events older than the configured TTL.
 * Uses batch splice instead of per-entry shift() to avoid O(n) GC pressure
 * during high-throughput bursts.
 */
const cleanupInterval = setInterval(() => {
  const cutoff = Date.now() - EVENT_BUFFER_TTL_MS;
  // Find the first index that is still within TTL
  let retainFrom = 0;
  while (
    retainFrom < eventBuffer.length &&
    eventBuffer[retainFrom].timestamp < cutoff
  ) {
    retainFrom++;
  }
  if (retainFrom > 0) {
    eventBuffer.splice(0, retainFrom);
  }
}, EVENT_BUFFER_CLEANUP_INTERVAL_MS);

// Allow the process to exit even if the interval is still running
if (typeof cleanupInterval === "object" && "unref" in cleanupInterval) {
  cleanupInterval.unref();
}

export function emitEvent(event: string, data: unknown): void {
  const id = String(++eventCounter);
  const buffered: BufferedEvent = {
    id,
    event,
    data,
    timestamp: Date.now(),
    epoch: bootEpoch,
  };
  eventBuffer.push(buffered);
  // Batch eviction: when over capacity, remove the oldest entries in one splice
  // instead of repeated shift() calls which are O(n) each.
  if (eventBuffer.length > EVENT_BUFFER_SIZE) {
    const excess = eventBuffer.length - EVENT_BUFFER_SIZE;
    eventBuffer.splice(0, excess);
  }

  for (const listener of listeners) {
    try {
      listener(event, data, id);
    } catch {
      // Listener disconnected or errored; ignore
    }
  }
}

export function subscribe(listener: EventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getEventBuffer(): readonly BufferedEvent[] {
  return eventBuffer;
}

/**
 * Returns the id of the oldest retained buffered event, or null when the
 * buffer is empty. Replay handlers compare the client's lastEventId against
 * this to detect eviction gaps: ids at or below it are gone and the client
 * must resync rather than assume a complete replay.
 */
export function getOldestBufferedId(): string | null {
  return eventBuffer.length > 0 ? eventBuffer[0].id : null;
}

/**
 * Returns the highest event id issued so far. Replay handlers use this to
 * distinguish "no new events" (cursor at counter) from total eviction
 * (empty buffer with cursor behind counter), which is a gap.
 */
export function getEventCounter(): number {
  return eventCounter;
}

/**
 * Returns this process's boot epoch. Sent to SSE clients on connect and
 * echoed back on reconnect so restarts are detectable regardless of ids.
 */
export function getBootEpoch(): string {
  return bootEpoch;
}

/**
 * Resets the event bus to a fresh-boot state. Test-only: production code
 * must never call this (it would invalidate every connected client's cursor).
 */
export function __dangerousResetEventsForTests(): void {
  eventBuffer.length = 0;
  eventCounter = 0;
  bootEpoch = randomUUID();
  listeners.clear();
}
