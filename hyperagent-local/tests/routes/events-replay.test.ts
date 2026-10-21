import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
import { db } from "../../src/db/connection.js";
import { sessions } from "../../src/db/schema.js";
import { signToken } from "../../src/auth/tokens.js";
import { eventsRouter } from "../../src/routes/events.js";
import {
  emitEvent,
  getBootEpoch,
  __dangerousResetEventsForTests,
} from "../../src/domain/events.js";

const app = new Hono();
app.route("/events", eventsRouter);

let cookie = "";

beforeAll(async () => {
  const jti = "events-test-jti-001";
  await db.insert(sessions).values({
    id: "events-test-session-001",
    userId: 1,
    jti,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  const token = await signToken({ userId: 1, email: "test@test.com" }, jti);
  cookie = `ha_session=${token}`;
});

beforeEach(() => {
  __dangerousResetEventsForTests();
});

interface SseFrame {
  event: string;
  data: string;
  id: string | null;
}

function parseFrames(text: string): SseFrame[] {
  return text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0 && !chunk.startsWith(":"))
    .map((chunk) => {
      let event = "message";
      let data = "";
      let id: string | null = null;
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:"))
          event = line.slice("event:".length).trim();
        else if (line.startsWith("data:"))
          data += line.slice("data:".length).trim();
        else if (line.startsWith("id:")) id = line.slice("id:".length).trim();
      }
      return { event, data, id };
    });
}

/** Reads SSE frames until `stop` returns true, then aborts the stream. */
async function collectFrames(
  path: string,
  stop: (frames: SseFrame[]) => boolean,
): Promise<SseFrame[]> {
  const controller = new AbortController();
  const res = await app.request(path, {
    headers: { Cookie: cookie },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 5000;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (value) text += decoder.decode(value, { stream: true });
      if (stop(parseFrames(text))) break;
      if (done) break;
    }
  } finally {
    controller.abort();
    try {
      await reader.cancel();
    } catch {
      // Stream already closed; nothing to do.
    }
  }
  return parseFrames(text);
}

describe("events stream replay", () => {
  // Tenant filter requires workspaceId; seed user 1 owns workspace 1.
  const ws = { workspaceId: 1 };

  it("replays only events after the cursor within the same epoch", async () => {
    emitEvent("test.one", { n: 1, ...ws });
    emitEvent("test.two", { n: 2, ...ws });
    emitEvent("test.three", { n: 3, ...ws });
    const epoch = getBootEpoch();

    const frames = await collectFrames(
      `/events/stream?lastEventId=1&epoch=${epoch}`,
      (f) => f.filter((x) => x.event.startsWith("test.")).length >= 2,
    );

    const replayed = frames.filter((f) => f.event.startsWith("test."));
    expect(replayed.map((f) => f.event)).toEqual(["test.two", "test.three"]);
    expect(replayed.map((f) => f.id)).toEqual(["2", "3"]);
    expect(frames.some((f) => f.event === "replay.gap")).toBe(false);
  });

  it("sends a gap and replays the whole buffer on epoch mismatch", async () => {
    emitEvent("test.one", { n: 1, ...ws });
    emitEvent("test.two", { n: 2, ...ws });

    const frames = await collectFrames(
      "/events/stream?lastEventId=1&epoch=stale-epoch-from-before-restart",
      (f) =>
        f.some((x) => x.event === "replay.gap") &&
        f.filter((x) => x.event.startsWith("test.")).length >= 2,
    );

    const gapIndex = frames.findIndex((f) => f.event === "replay.gap");
    expect(gapIndex).toBeGreaterThanOrEqual(0);
    expect(frames[gapIndex].id).toBeNull();
    const replayed = frames.filter((f) => f.event.startsWith("test."));
    // Full buffer, not just id > 1: the cursor belongs to a dead epoch.
    expect(replayed.map((f) => f.event)).toEqual(["test.one", "test.two"]);
  });

  it("still gaps when the new counter has caught up with the old cursor", async () => {
    // Simulate post-restart id reuse: fill the buffer past the stale cursor
    // so a purely numeric check would see "caught up" and skip the replay.
    for (let i = 0; i < 105; i++) {
      emitEvent("test.flood", { i, ...ws });
    }
    expect(getBootEpoch()).not.toBe("stale-epoch-from-before-restart");

    const frames = await collectFrames(
      "/events/stream?lastEventId=100&epoch=stale-epoch-from-before-restart",
      (f) =>
        f.some((x) => x.event === "replay.gap") &&
        f.filter((x) => x.event === "test.flood").length >= 2,
    );

    // Without the epoch check, 100 <= counter(105) and 100 >= oldestId(6)
    // would produce no gap and replay only ids > 100 (a single event).
    expect(frames.some((f) => f.event === "replay.gap")).toBe(true);
    const replayed = frames.filter((f) => f.event === "test.flood");
    expect(replayed.length).toBeGreaterThan(1);
  });

  it("announces the boot epoch on connect", async () => {
    const frames = await collectFrames("/events/stream", (f) =>
      f.some((x) => x.event === "server.epoch"),
    );

    const epochFrame = frames.find((f) => f.event === "server.epoch");
    expect(epochFrame).toBeDefined();
    expect(epochFrame!.id).toBeNull();
    expect(JSON.parse(epochFrame!.data)).toEqual({ epoch: getBootEpoch() });
  });
});
