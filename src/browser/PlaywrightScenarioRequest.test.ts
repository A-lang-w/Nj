import type { Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { browserScenarioSchema } from "../domain/browserScenario.js";
import type { BrowserScenarioAction } from "../domain/browserScenarioValues.js";
import { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import { performPlaywrightScenarioAction } from "./PlaywrightScenarioActions.js";

const ORIGIN = "https://app.example.test";

const scenario = (actions: readonly unknown[], secrets: unknown[] = []) =>
  browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: "/opt/chromium/chrome" },
    start_url: { url: `${ORIGIN}/` },
    actions,
    storage: { cookies: [], local_storage: [], session_storage: [] },
    secrets,
    capture: {},
  });

const requestStep = (fields: Record<string, unknown>) => ({
  step_id: "create",
  action: "request",
  method: "POST",
  path: "/api/folders",
  ...fields,
});

const issues = (actions: readonly unknown[], secrets: unknown[] = []) => {
  const parsed = browserScenarioSchema.safeParse({
    browser: { mode: "launch", executable_path: "/opt/chromium/chrome" },
    start_url: { url: `${ORIGIN}/` },
    actions,
    storage: { cookies: [], local_storage: [], session_storage: [] },
    secrets,
    capture: {},
  });
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => issue.message);
};

describe("request step schema", () => {
  it("refuses repeated header names, User-Agent and line breaks in literal values or prefixes", () => {
    const literal = (value: string) => ({ source: "literal", value });
    expect(
      issues([
        requestStep({
          headers: [
            { name: "X-A", value: literal("one") },
            { name: "x-a", value: literal("two") },
          ],
        }),
      ]),
    ).toContainEqual(expect.stringContaining("more than once"));
    expect(
      issues([
        requestStep({
          headers: [{ name: "User-Agent", value: literal("agent") }],
        }),
      ]),
    ).toContainEqual(expect.stringContaining("cannot set"));
    expect(
      issues([requestStep({ expected_status: [200, 303] })]),
    ).toContainEqual(expect.stringContaining("3xx"));
    for (const header of [
      { name: "X-A", value: literal("a\r\nX-B: b") },
      { name: "X-A", value: literal("a"), prefix: "Bearer\n" },
    ])
      expect(issues([requestStep({ headers: [header] })])).toContainEqual(
        expect.stringContaining("line breaks"),
      );
  });

  it("accepts a same-origin request with query, headers and a JSON body", () => {
    const parsed = scenario(
      [
        requestStep({
          query: [{ name: "org", value: { source: "literal", value: "1" } }],
          headers: [
            {
              name: "X-CSRFToken",
              value: { source: "cookie", name: "csrftoken" },
            },
            {
              name: "Authorization",
              value: { source: "secret", secret_id: "token" },
              prefix: "Bearer ",
            },
          ],
          json: { title: "Scratch folder 1" },
          expected_status: [200, 201],
        }),
      ],
      [{ secret_id: "token", environment_variable: "APP_TOKEN" }],
    );
    expect(parsed.actions[0]).toMatchObject({
      action: "request",
      method: "POST",
      path: "/api/folders",
    });
  });

  it("refuses paths that leave the start origin", () => {
    for (const path of [
      "//evil.test/x",
      "/\\evil.test/x",
      "https://evil.test/",
    ])
      expect(issues([requestStep({ path })]).length, path).toBeGreaterThan(0);
  });

  it("refuses a path the URL parser rejects as a field issue", () => {
    const parsed = browserScenarioSchema.safeParse({
      browser: { mode: "launch", executable_path: "/opt/chromium/chrome" },
      start_url: { url: `${ORIGIN}/` },
      actions: [requestStep({ path: "/\n/[bad]" })],
      storage: { cookies: [], local_storage: [], session_storage: [] },
      secrets: [],
      capture: {},
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ["actions", 0, "path"],
        message: expect.stringContaining("not a URL path"),
      }),
    );
  });

  it("refuses a body on GET, a header fetch cannot set and an undeclared secret", () => {
    expect(
      issues([requestStep({ method: "GET", json: { a: 1 } })]),
    ).toContainEqual(expect.stringContaining("cannot send a body"));
    expect(
      issues([
        requestStep({
          headers: [
            { name: "Cookie", value: { source: "literal", value: "a=b" } },
          ],
        }),
      ]),
    ).toContainEqual(expect.stringContaining("cannot set this header"));
    expect(
      issues([
        requestStep({
          headers: [
            { name: "X-Key", value: { source: "secret", secret_id: "key" } },
          ],
        }),
      ]),
    ).toContainEqual(expect.stringContaining("not declared"));
  });
});

interface FakeFetch {
  readonly url: string;
  readonly init: RequestInit;
}

const fakePage = (options: {
  readonly url?: string;
  /** The origin the page reports when the request is sent, if it moved after the check. */
  readonly sendingOrigin?: string;
  readonly cookies?: readonly { name: string; value: string }[];
  readonly cookieDelayMs?: number;
  readonly storage?: Record<string, string>;
  /** The origin the page is on when each evaluate callback runs, by call. */
  readonly originAt?: (call: number) => string;
  /** Runs before each evaluate callback, as a busy page delays it. */
  readonly beforeEvaluate?: (call: number) => void | Promise<void>;
  readonly afterEvaluate?: (call: number) => void;
}) => {
  const url = options.url ?? `${ORIGIN}/dashboard`;
  let evaluations = 0;
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => options.storage?.[key] ?? null,
  });
  vi.stubGlobal("location", {
    origin: options.sendingOrigin ?? new URL(url).origin,
  });
  return {
    url: () => url,
    context: () => ({
      cookies: async () => {
        if (options.cookieDelayMs !== undefined)
          await new Promise((resolve) =>
            setTimeout(resolve, options.cookieDelayMs),
          );
        return options.cookies ?? [];
      },
    }),
    evaluate: async <Arg, Result>(
      fn: (arg: Arg) => Result | Promise<Result>,
      arg: Arg,
    ): Promise<Result> => {
      const call = evaluations;
      evaluations += 1;
      await options.beforeEvaluate?.(call);
      const origin = options.originAt?.(call);
      if (origin !== undefined) vi.stubGlobal("location", { origin });
      try {
        return await fn(arg);
      } finally {
        options.afterEvaluate?.(call);
      }
    },
  } as unknown as Page;
};

const stubFetch = (status: number) => {
  const calls: FakeFetch[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("{}", { status });
  });
  return calls;
};

const perform = async (
  page: Page,
  action: BrowserScenarioAction,
  secrets: BrowserScenarioSecrets,
) =>
  performPlaywrightScenarioAction({
    page,
    action,
    secrets,
    startOrigin: ORIGIN,
  });

const resolved = (parsed: ReturnType<typeof scenario>, environment = {}) => {
  const secrets = BrowserScenarioSecrets.resolve(parsed, environment);
  if (!secrets.ok) throw secrets.error;
  return secrets.value;
};

describe("request step execution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the declared request through the page's fetch with its cookies", async () => {
    const calls = stubFetch(201);
    const parsed = scenario([
      requestStep({
        query: [{ name: "org", value: { source: "literal", value: "1" } }],
        json: { title: "Scratch folder 1" },
      }),
    ]);
    await perform(fakePage({}), parsed.actions[0]!, resolved(parsed));
    expect(calls).toEqual([
      {
        url: `${ORIGIN}/api/folders?org=1`,
        init: expect.objectContaining({
          method: "POST",
          credentials: "same-origin",
          headers: [["content-type", "application/json"]],
          body: '{"title":"Scratch folder 1"}',
        }),
      },
    ]);
  });

  it("reads header values from a cookie and from stored JSON, and redacts them afterwards", async () => {
    const calls = stubFetch(200);
    const parsed = scenario([
      requestStep({
        headers: [
          {
            name: "X-CSRFToken",
            value: { source: "cookie", name: "csrftoken" },
          },
          {
            name: "Authorization",
            value: {
              source: "local_storage",
              key: "auth",
              json_pointer: "/token",
            },
            prefix: "Bearer ",
          },
        ],
      }),
    ]);
    const secrets = resolved(parsed);
    await perform(
      fakePage({
        cookies: [{ name: "csrftoken", value: "csrf-value-123" }],
        storage: { auth: JSON.stringify({ token: "jwt-value-456" }) },
      }),
      parsed.actions[0]!,
      secrets,
    );
    expect(calls[0]!.init.headers).toEqual([
      ["X-CSRFToken", "csrf-value-123"],
      ["Authorization", "Bearer jwt-value-456"],
    ]);
    const redacted = secrets.redact("csrf-value-123 and jwt-value-456");
    expect(redacted).not.toContain("csrf-value-123");
    expect(redacted).not.toContain("jwt-value-456");
    expect(redacted).toContain("[REDACTED:page:create.X-CSRFToken]");
  });

  it("refuses to run off the start origin, and fails on an unexpected status or a missing cookie", async () => {
    stubFetch(403);
    const parsed = scenario([requestStep({ expected_status: [200, 201] })]);
    const action = parsed.actions[0]!;
    await expect(
      perform(
        fakePage({ url: "https://other.test/" }),
        action,
        resolved(parsed),
      ),
    ).rejects.toThrow("start origin");
    await expect(
      perform(fakePage({}), action, resolved(parsed)),
    ).rejects.toThrow("answered 403; expected 200 or 201");
    const withCookie = scenario([
      requestStep({
        headers: [{ name: "X-T", value: { source: "cookie", name: "absent" } }],
      }),
    ]);
    await expect(
      perform(fakePage({}), withCookie.actions[0]!, resolved(withCookie)),
    ).rejects.toThrow("cookie absent is not set");
  });

  it("completes on any status when none is expected and reports fetch errors", async () => {
    stubFetch(500);
    const parsed = scenario([requestStep({})]);
    await expect(
      perform(fakePage({}), parsed.actions[0]!, resolved(parsed)),
    ).resolves.toBeUndefined();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(
      perform(fakePage({}), parsed.actions[0]!, resolved(parsed)),
    ).rejects.toThrow("Failed to fetch");
  });
});

describe("request step confinement", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows no redirect and sends nothing once the page has left the start origin", async () => {
    const calls: FakeFetch[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        type: "opaqueredirect",
        status: 0,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    });
    const parsed = scenario([requestStep({})]);
    await expect(
      perform(fakePage({}), parsed.actions[0]!, resolved(parsed)),
    ).rejects.toThrow("request steps do not follow");
    expect(calls[0]!.init.redirect).toBe("manual");
    await expect(
      perform(
        fakePage({ sendingOrigin: "https://other.test" }),
        parsed.actions[0]!,
        resolved(parsed),
      ),
    ).rejects.toThrow("the page moved");
    expect(calls).toHaveLength(1);
  });

  it("sends nothing when its time runs out while header values are read, or the step is cancelled", async () => {
    const calls = stubFetch(200);
    const parsed = scenario([
      requestStep({
        timeout_ms: 5,
        headers: [{ name: "X-T", value: { source: "cookie", name: "t" } }],
      }),
    ]);
    const cookies = [{ name: "t", value: "token-value-1" }];
    await expect(
      perform(
        fakePage({ cookies, cookieDelayMs: 30 }),
        parsed.actions[0]!,
        resolved(parsed),
      ),
    ).rejects.toThrow("ran out of time");
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      performPlaywrightScenarioAction({
        page: fakePage({ cookies }),
        action: scenario([requestStep({})]).actions[0]!,
        secrets: resolved(parsed),
        startOrigin: ORIGIN,
        signal: cancelled.signal,
      }),
    ).rejects.toThrow("ran out of time");
    expect(calls).toEqual([]);
  });

  it("appends query entries after the path's literal query without re-encoding it", async () => {
    const calls = stubFetch(200);
    const parsed = scenario([
      requestStep({
        path: "/api/items?flag&a=b%20c&s=x;y",
        query: [{ name: "q", value: { source: "literal", value: "a b" } }],
      }),
    ]);
    await perform(fakePage({}), parsed.actions[0]!, resolved(parsed));
    expect(calls[0]!.url).toBe(
      `${ORIGIN}/api/items?flag&a=b%20c&s=x;y&q=a%20b`,
    );
    for (const [path, sent] of [
      ["/api/items?", "/api/items?q=1"],
      ["/api/items#", "/api/items?q=1"],
      ["/api/items?a=1&", "/api/items?a=1&q=1"],
      ["/api/items?a=1#top", "/api/items?a=1&q=1"],
    ] as const) {
      const edge = scenario([
        requestStep({
          path,
          query: [{ name: "q", value: { source: "literal", value: "1" } }],
        }),
      ]);
      await perform(fakePage({}), edge.actions[0]!, resolved(edge));
      expect(calls.at(-1)!.url, path).toBe(`${ORIGIN}${sent}`);
    }
  });

  it("refuses page values a header cannot carry, and stored values it cannot read", async () => {
    const calls = stubFetch(200);
    const header = (value: Record<string, unknown>) =>
      scenario([requestStep({ headers: [{ name: "X-T", value }] })]);
    const cookie = header({ source: "cookie", name: "t" });
    await expect(
      perform(
        fakePage({ cookies: [{ name: "t", value: "a\r\nX-B: b" }] }),
        cookie.actions[0]!,
        resolved(cookie),
      ),
    ).rejects.toThrow("cannot carry");
    for (const [storage, pointer, message] of [
      [{}, undefined, "local storage has no auth"],
      [{ auth: "not json" }, "/token", "is not JSON"],
      [{ auth: '{"other":1}' }, "/token", "no string or number at /token"],
    ] as const) {
      const stored = header({
        source: "local_storage",
        key: "auth",
        ...(pointer === undefined ? {} : { json_pointer: pointer }),
      });
      await expect(
        perform(fakePage({ storage }), stored.actions[0]!, resolved(stored)),
      ).rejects.toThrow(message);
    }
    expect(calls).toEqual([]);
    const numeric = header({
      source: "local_storage",
      key: "auth",
      json_pointer: "/org",
    });
    await perform(
      fakePage({ storage: { auth: '{"org":42}' } }),
      numeric.actions[0]!,
      resolved(numeric),
    );
    expect(calls[0]!.init.headers).toEqual([["X-T", "42"]]);
  });
});

describe("request step delivery", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends nothing when a busy page starts the request after the step's deadline", async () => {
    const calls = stubFetch(200);
    const parsed = scenario([requestStep({ timeout_ms: 20 })]);
    await expect(
      perform(
        fakePage({
          beforeEvaluate: () =>
            new Promise((resolve) => setTimeout(resolve, 60)),
        }),
        parsed.actions[0]!,
        resolved(parsed),
      ),
    ).rejects.toThrow("ran out of time");
    expect(calls).toEqual([]);
  });

  it("sends nothing once cancelled while a busy page held the request, and hands a late request over again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const calls = stubFetch(200);
    const parsed = scenario([requestStep({})]);
    const late = () => {
      vi.setSystemTime(Date.now() + 1_001);
    };
    const cancelled = new AbortController();
    await expect(
      performPlaywrightScenarioAction({
        page: fakePage({
          beforeEvaluate: () => {
            cancelled.abort();
            late();
          },
        }),
        action: parsed.actions[0]!,
        secrets: resolved(parsed),
        startOrigin: ORIGIN,
        signal: cancelled.signal,
      }),
    ).rejects.toThrow("ran out of time");
    expect(calls).toEqual([]);
    const handed: number[] = [];
    await perform(
      fakePage({
        beforeEvaluate: (call) => {
          handed.push(call);
          if (call === 0) late();
        },
      }),
      parsed.actions[0]!,
      resolved(parsed),
    );
    expect(handed).toEqual([0, 1]);
    expect(calls).toHaveLength(1);
  });

  it("refuses to wait on a browser whose clock runs ahead of this host's", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const calls = stubFetch(200);
    const parsed = scenario([requestStep({})]);
    const now = Date.now();
    await expect(
      perform(
        fakePage({
          beforeEvaluate: () => {
            vi.setSystemTime(now + 5_000);
          },
          afterEvaluate: () => {
            vi.setSystemTime(now);
          },
        }),
        parsed.actions[0]!,
        resolved(parsed),
      ),
    ).rejects.toThrow("clock");
    expect(calls).toEqual([]);
  });

  it("reads local storage only while the page is on the start origin", async () => {
    const calls = stubFetch(200);
    const parsed = scenario([
      requestStep({
        headers: [
          { name: "X-T", value: { source: "local_storage", key: "auth" } },
        ],
      }),
    ]);
    await expect(
      perform(
        fakePage({
          storage: { auth: "other-origin-token" },
          originAt: (call) =>
            call === 0 ? "https://login.other.test" : ORIGIN,
        }),
        parsed.actions[0]!,
        resolved(parsed),
      ),
    ).rejects.toThrow("the page moved");
    expect(calls).toEqual([]);
  });

  it("waits for the whole response without keeping its body", async () => {
    const pulled: number[] = [];
    let ended = false;
    vi.stubGlobal("fetch", async () => ({
      type: "basic",
      status: 200,
      body: new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (pulled.length === 3) {
            ended = true;
            controller.close();
            return;
          }
          pulled.push(pulled.length);
          controller.enqueue(new Uint8Array(64 * 1024));
        },
      }),
      arrayBuffer: async () => {
        throw new Error("the whole body was kept");
      },
    }));
    const parsed = scenario([requestStep({})]);
    await perform(fakePage({}), parsed.actions[0]!, resolved(parsed));
    expect(pulled).toEqual([0, 1, 2]);
    expect(ended).toBe(true);
  });
});

describe("page value redaction", () => {
  const secrets = () => resolved(scenario([requestStep({})]));

  it("keeps every admitted value redacted, even under a repeated or colliding label", () => {
    const held = secrets();
    held.admitPageValue("s.x-a", "first-secret-AAAA");
    held.admitPageValue("s.x-a", "second-secret-BBBB");
    held.admitPageValue("a.b.c", "third-secret-CCCC");
    held.admitPageValue("a.b.c", "fourth-secret-DDDD");
    const text = held.redact(
      "first-secret-AAAA second-secret-BBBB third-secret-CCCC fourth-secret-DDDD",
    );
    for (const value of ["AAAA", "BBBB", "CCCC", "DDDD"])
      expect(text).not.toContain(value);
  });

  it("keeps a value's first marker when later steps read it again", () => {
    const held = secrets();
    held.admitPageValue("create-1.X-CSRFToken", "csrf-token-value");
    held.admitPageValue("create-2.X-CSRFToken", "csrf-token-value");
    expect(held.redact("csrf-token-value")).toBe(
      "[REDACTED:page:create-1.X-CSRFToken]",
    );
  });

  it("redacts the value fetch sends when the stored one has surrounding spaces", () => {
    const held = secrets();
    held.admitPageValue("s.X-Tok", " padded-token-4f9e2a\t");
    expect(held.redact("X-Tok: padded-token-4f9e2a")).not.toContain(
      "padded-token-4f9e2a",
    );
  });

  it("does not redact values too short to tell from ids and ports", () => {
    const held = secrets();
    held.admitPageValue("s.X-Org-Id", "1");
    held.admitPageValue("s.X-Port", "3000");
    const text = "http://127.0.0.1:3000/api/items/12?page=1";
    expect(held.redact(text)).toBe(text);
  });
});
