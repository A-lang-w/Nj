import { refreshSessionToken } from "./api-client";

type EventCallback = (data: unknown) => void;

class SseClient {
  private eventSource: EventSource | null = null;
  private subscribers = new Map<string, Set<EventCallback>>();
  private reconnectAttempts = 0;
  private baseReconnectDelay = 1000;
  private maxReconnectDelay = 30_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  // Connection generation: disconnect()/connect() bump it so a reconnect
  // timer armed by an older generation (e.g. an onerror refresh that
  // resolves after a logout/login cycle) can never open a second socket
  // alongside the current connection.
  private connectionGeneration = 0;
  private lastEventId: string | null = null;
  // Set when the server reports a replay gap (eviction or restart): the next
  // delivered id belongs to a new epoch and must replace the cursor instead
  // of being compared against it, or the rewind guard would freeze the
  // cursor ahead of the server forever.
  private gapPending = false;
  // Boot epoch announced by the server on connect, echoed back on reconnect
  // so restarts are detectable even after the new counter catches the cursor.
  private serverEpoch: string | null = null;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt = Date.now();
  private stallTimeoutMs = 45_000;

  connect(): void {
    if (this.eventSource?.readyState === EventSource.OPEN) return;
    this.intentionalClose = false;
    this.connectionGeneration++;
    // A reconnect timer armed before this call would otherwise open a second
    // connection when it fires, orphaning one EventSource without close().
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.createConnection();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.connectionGeneration++;
    this.stopStallDetection();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.eventSource?.close();
    this.eventSource = null;
    this.reconnectAttempts = 0;
  }

  subscribe(eventType: string, callback: EventCallback): () => void {
    if (!this.subscribers.has(eventType)) {
      this.subscribers.set(eventType, new Set());
    }
    this.subscribers.get(eventType)!.add(callback);
    return () => {
      const subs = this.subscribers.get(eventType);
      if (subs) {
        subs.delete(callback);
        if (subs.size === 0) this.subscribers.delete(eventType);
      }
    };
  }

  private createConnection(): void {
    const params = new URLSearchParams();
    if (this.lastEventId) params.set("lastEventId", this.lastEventId);
    if (this.serverEpoch) params.set("epoch", this.serverEpoch);
    const query = params.toString();
    const url = query ? `/api/events/stream?${query}` : "/api/events/stream";
    // Never orphan a live socket: assigning over an existing EventSource
    // without close() leaks an open connection that keeps dispatching.
    this.eventSource?.close();
    this.eventSource = new EventSource(url, { withCredentials: true });
    this.markActivity();
    this.startStallDetection();

    this.eventSource.onopen = () => {
      this.reconnectAttempts = 0;
      this.markActivity();
    };

    this.eventSource.onerror = () => {
      this.eventSource?.close();
      this.eventSource = null;
      this.stopStallDetection();
      if (!this.intentionalClose) {
        // EventSource surfaces no status code, so a dead stream may mean an
        // expired JWT. Renew the cookie (deduped with API refreshes) before
        // reconnecting; if renewal fails, the backoff loop continues as before.
        // Bind the schedule to this generation: a logout/login cycle while
        // the refresh is in flight must not arm a timer for the new socket.
        const generation = this.connectionGeneration;
        void refreshSessionToken().finally(() =>
          this.scheduleReconnect(generation),
        );
      }
    };

    this.eventSource.addEventListener("ping", () => {
      this.markActivity();
    });

    const knownEvents = [
      "message.delta",
      "message.done",
      "thread.created",
      "thread.message",
      "memory.created",
      "memory.deleted",
      "skill.created",
      "skill.deleted",
      "file.uploaded",
      "file.deleted",
      "mcp_server.created",
      "mcp_server.updated",
      "mcp_server.deleted",
      "community.skill.submitted",
      "community.skill.approved",
      // Sent by the server when the replay cursor predates the retained
      // buffer: events were evicted and the client must resubscribe/resync
      // rather than assume a complete replay.
      "replay.gap",
    ];

    this.eventSource.addEventListener("replay.gap", () => {
      this.markActivity();
      // The gap itself carries no id; the retained tail that follows it does.
      // Accept the next delivered id unconditionally so a restarted server
      // (counter reset below our cursor) re-anchors instead of freezing.
      this.gapPending = true;
    });

    this.eventSource.addEventListener("server.epoch", (e: MessageEvent) => {
      this.markActivity();
      try {
        const parsed = JSON.parse(e.data) as { epoch?: unknown };
        if (typeof parsed.epoch === "string" && parsed.epoch) {
          this.serverEpoch = parsed.epoch;
        }
      } catch {
        // Malformed epoch frame: keep the previous value (or none) and rely
        // on the numeric cursor checks.
      }
      this.dispatch("server.epoch", e.data);
    });

    for (const eventType of knownEvents) {
      this.eventSource.addEventListener(eventType, (e: MessageEvent) => {
        this.markActivity();
        // replay.gap carries no id of its own (e.lastEventId would be the
        // previous frame's); it only arms gapPending via the listener above.
        if (e.lastEventId && eventType !== "replay.gap") {
          if (this.gapPending) {
            this.lastEventId = e.lastEventId;
            this.gapPending = false;
          } else if (
            this.lastEventId === null ||
            Number(e.lastEventId) > Number(this.lastEventId)
          ) {
            // Never rewind the cursor: an out-of-order delivery must not move
            // lastEventId backwards and skip ids on the next reconnect. The
            // event itself is still dispatched (at-least-once delivery).
            this.lastEventId = e.lastEventId;
          }
        }
        this.dispatch(eventType, e.data);
      });
    }
  }

  private markActivity(): void {
    this.lastActivityAt = Date.now();
  }

  private startStallDetection(): void {
    this.stopStallDetection();
    this.stallTimer = setInterval(
      () => {
        if (Date.now() - this.lastActivityAt > this.stallTimeoutMs) {
          // Connection appears stalled — force reconnect
          this.eventSource?.close();
          this.eventSource = null;
          this.stopStallDetection();
          if (!this.intentionalClose) {
            this.scheduleReconnect();
          }
        }
      },
      Math.min(this.stallTimeoutMs / 3, 15_000),
    );
  }

  private stopStallDetection(): void {
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private dispatch(eventType: string, rawData: string): void {
    let data: unknown;
    try {
      data = JSON.parse(rawData);
    } catch {
      data = rawData;
    }
    const subs = this.subscribers.get(eventType);
    if (subs) {
      for (const callback of subs) {
        try {
          callback(data);
        } catch {
          // Subscriber error should not break dispatch
        }
      }
    }
  }

  private scheduleReconnect(expectedGeneration?: number): void {
    // onerror chains here through `refreshSessionToken().finally(...)`: if
    // disconnect() ran while the refresh was in flight (logout, session
    // expiry, unmount), arming a timer here would resurrect the stream after
    // intentional close — and on expiry, loop forever against a dead session.
    if (this.intentionalClose) return;
    // A schedule bound to an older generation (logout/login cycled mid
    // refresh) must not arm a timer for the current connection's socket.
    if (
      expectedGeneration !== undefined &&
      expectedGeneration !== this.connectionGeneration
    )
      return;
    // onerror and the stall detector can both fire for one outage; a second
    // schedule supersedes the first so only one connection is ever re-armed.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const exponentialDelay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay,
    );
    // Add jitter: +/- 25% of computed delay to avoid thundering herd
    const jitterRange = exponentialDelay * 0.25;
    const jitter = (Math.random() * 2 - 1) * jitterRange;
    const delay = Math.max(0, Math.round(exponentialDelay + jitter));
    this.reconnectAttempts++;
    // Bind the timer to this generation: a logout/login cycle (or a fresh
    // connect) after the schedule invalidates it, so the callback must not
    // open a socket the current generation never asked for.
    const generation = this.connectionGeneration;
    this.reconnectTimer = setTimeout(() => {
      if (generation !== this.connectionGeneration || this.intentionalClose)
        return;
      this.createConnection();
    }, delay);
  }
}

export const sseClient = new SseClient();
