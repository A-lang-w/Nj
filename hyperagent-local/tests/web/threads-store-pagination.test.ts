import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useThreadsStore } from "../../web/src/stores/threads-store";
import type { Thread } from "../../web/src/types/api";

/**
 * Pagination overlap: fetchThreads/loadMore/createThread race on the same
 * list. A refresh (SSE thread.created, workspace switch, manual refetch)
 * that resolves while loadMore is in flight must invalidate the stale
 * page — appending it produces gaps, duplicate React keys, and a stuck
 * hasMore. Latest refresh wins; a create prepend invalidates too.
 *
 * The store is driven with a stubbed global fetch (api-client reads only
 * window.location.origin, stubbed here). No DOM or React rendering needed.
 */

function makeThread(id: number): Thread {
  return {
    id,
    workspaceId: 1,
    agentId: null,
    title: `Thread ${id}`,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as Thread;
}

function page(ids: number[], total: number) {
  return { items: ids.map(makeThread), total, limit: 50, offset: 0 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function okJson(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload),
  } as Response;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

describe("threads store pagination overlap", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { location: { origin: "http://localhost:5173" } });
    useThreadsStore.getState().resetAccountData();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("discards a loadMore page when a refresh resolves first", async () => {
    const page1Gate = deferred<unknown>();
    let calls = 0;
    vi.stubGlobal("fetch", (url: unknown) => {
      const u = String(url);
      if (u.includes("/api/threads?") && u.includes("offset=50")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => page1Gate.promise,
        } as Response);
      }
      calls += 1;
      // First refresh: ids 1-50; second (post-create ordering): ids 101-150.
      const ids = calls === 1 ? range(1, 50) : range(101, 150);
      return Promise.resolve(okJson(page(ids, calls === 1 ? 52 : 53)));
    });

    await useThreadsStore.getState().fetchThreads(1);
    expect(useThreadsStore.getState().threads).toHaveLength(50);

    const pending = useThreadsStore.getState().loadMore(1);
    expect(useThreadsStore.getState().isLoadingMore).toBe(true);

    // SSE thread.created refresh lands while loadMore is in flight.
    await useThreadsStore.getState().fetchThreads(1);
    expect(useThreadsStore.getState().threads.map((t) => t.id)).toEqual(
      range(101, 150),
    );

    // The stale page resolves late: it must not append.
    page1Gate.resolve(page([51, 52], 52));
    await pending;

    const state = useThreadsStore.getState();
    expect(state.threads.map((t) => t.id)).toEqual(range(101, 150));
    expect(state.isLoadingMore).toBe(false);
    expect(state.hasMore).toBe(true);
    expect(state.fetchError).toBeNull();
  });

  it("lets the latest of two overlapping refreshes win", async () => {
    const firstGate = deferred<unknown>();
    let calls = 0;
    vi.stubGlobal("fetch", () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => firstGate.promise,
        } as Response);
      }
      return Promise.resolve(okJson(page(range(201, 250), 50)));
    });

    const first = useThreadsStore.getState().fetchThreads(1);
    await useThreadsStore.getState().fetchThreads(1);
    expect(useThreadsStore.getState().threads.map((t) => t.id)).toEqual(
      range(201, 250),
    );

    firstGate.resolve(page(range(1, 50), 50));
    await first;

    expect(useThreadsStore.getState().threads.map((t) => t.id)).toEqual(
      range(201, 250),
    );
    expect(useThreadsStore.getState().isLoading).toBe(false);
  });

  it("discards a loadMore page when a create prepends first", async () => {
    const page1Gate = deferred<unknown>();
    vi.stubGlobal("fetch", (url: unknown, init?: { method?: string }) => {
      const u = String(url);
      if (init?.method === "POST" && u === "/api/threads") {
        return Promise.resolve(okJson(makeThread(999)));
      }
      if (u.includes("offset=50")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => page1Gate.promise,
        } as Response);
      }
      return Promise.resolve(okJson(page(range(1, 50), 52)));
    });

    await useThreadsStore.getState().fetchThreads(1);
    const pending = useThreadsStore.getState().loadMore(1);
    expect(useThreadsStore.getState().isLoadingMore).toBe(true);

    await useThreadsStore.getState().createThread(1, null, "New");
    expect(useThreadsStore.getState().threads[0].id).toBe(999);

    page1Gate.resolve(page([51, 52], 52));
    await pending;

    const state = useThreadsStore.getState();
    expect(state.threads).toHaveLength(51);
    expect(state.threads[0].id).toBe(999);
    expect(state.isLoadingMore).toBe(false);
  });
});
