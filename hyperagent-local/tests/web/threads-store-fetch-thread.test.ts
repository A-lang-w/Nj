import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useThreadsStore } from "../../web/src/stores/threads-store";

/**
 * fetchThread currency: overlapping navigations resolve in arbitrary order.
 * The store already drops stale successes; stale rejections must also be
 * swallowed — otherwise a slow 404 for thread A paints loadError over
 * thread B after the user navigated on (the detail page renders loadError
 * before the active thread). The newest request always owns the outcome.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function detail(id: number) {
  return {
    id,
    workspaceId: 1,
    agentId: null,
    title: `Thread ${id}`,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [],
  };
}

describe("threads store fetchThread currency", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { location: { origin: "http://localhost:5173" } });
    useThreadsStore.getState().resetAccountData();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("swallows a stale rejection after a newer fetch resolves", async () => {
    const staleGate = deferred<unknown>();
    vi.stubGlobal("fetch", (url: unknown) => {
      const u = String(url);
      if (u.endsWith("/api/threads/999999")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => staleGate.promise,
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(detail(1)),
      } as Response);
    });

    const stale = useThreadsStore.getState().fetchThread(999999);
    await useThreadsStore.getState().fetchThread(1);
    expect(useThreadsStore.getState().activeThread?.id).toBe(1);

    // The 404 for thread A lands late: it must not throw (which the page
    // would render as loadError over thread B) and must not touch state.
    staleGate.reject(new Error("Not found"));
    await expect(stale).resolves.toBeUndefined();
    expect(useThreadsStore.getState().activeThread?.id).toBe(1);
  });

  it("still throws when the current fetch rejects", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error("boom")),
      } as Response),
    );

    await expect(
      useThreadsStore.getState().fetchThread(999999),
    ).rejects.toThrow("boom");
    expect(useThreadsStore.getState().activeThread).toBeNull();
  });
});
