import { expect, it } from "vitest";

import { inspectWebPageInputSchema } from "../domain/browserObservation.js";
import { captureCssVariables } from "./CdpCaptureCssVariables.js";
import { CdpCommandRejection } from "./CdpCommandRejection.js";
import type { CdpConnection } from "./CdpConnection.js";

const makeMockConnection = (
  replies: Record<string, unknown | Error>,
  sentCommands?: string[],
): CdpConnection =>
  ({
    send(method: string): Promise<unknown> {
      sentCommands?.push(method);
      const reply = replies[method];
      if (reply instanceof Error) {
        return Promise.reject(reply);
      }
      if (reply !== undefined) {
        return Promise.resolve(reply);
      }
      return Promise.reject(new Error(`Unexpected CDP command: ${method}`));
    },
  }) as unknown as CdpConnection;

it("returns not_approved when include_css_variables is false", async () => {
  const connection = makeMockConnection({});
  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: false,
      }),
    },
    limitations,
  );

  expect(result).toEqual({
    status: "not_approved",
    origin_scope: "same_origin",
    total: 0,
    retained_count: 0,
    items: [],
  });
  expect(limitations).toEqual([]);
});

it("extracts, validates, and sorts root CSS variables deterministically", async () => {
  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: [
        { name: "color", value: "red" }, // non-custom property (must be excluded)
        { name: "--zebra", value: "#000" },
        { name: "--alpha", value: "16px" },
        { name: "__proto__", value: "polluted" }, // security injection (must be excluded)
        { name: "--middle-val", value: "calc(100% - 20px)" },
        { name: "--bad-val", value: "evil\x00data" }, // control character (must be excluded)
      ],
    },
  });

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: "session_123",
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(result).toEqual({
    status: "included",
    origin_scope: "same_origin",
    total: 4,
    retained_count: 3,
    items: [
      { name: "--alpha", value: "16px" },
      { name: "--middle-val", value: "calc(100% - 20px)" },
      { name: "--zebra", value: "#000" },
    ],
  });
  expect(
    limitations.some(
      (lim) =>
        lim.includes("1 root CSS custom property was rejected") &&
        lim.includes("--bad-val"),
    ),
  ).toBe(true);
});

it("marks status as truncated when variables exceed 250 items", async () => {
  const oversizedVariables = Array.from({ length: 260 }, (_, i) => ({
    name: `--var-${String(i).padStart(3, "0")}`,
    value: `${String(i)}px`,
  }));

  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: oversizedVariables,
    },
  });

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(result.status).toBe("truncated");
  expect(result.total).toBe(260);
  expect(result.retained_count).toBe(250);
  expect(result.items).toHaveLength(250);
  expect(result.items[0]?.name).toBe("--var-000");
});

it("handles unsupported CDP CSS methods gracefully", async () => {
  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: { nodeId: 1 },
    },
    "CSS.enable": new CdpCommandRejection(
      "inspect_web_page",
      "CSS.enable",
      -32601,
      "Method not found",
    ),
  });

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(result).toEqual({
    status: "unavailable",
    origin_scope: "same_origin",
    total: 0,
    retained_count: 0,
    items: [],
  });
  expect(limitations).toContain(
    "CSS.enable was unavailable from this browser target.",
  );
});

it("disables CSS domain in finally block to prevent CDP event leaks", async () => {
  const sentCommands: string[] = [];
  const connection = makeMockConnection(
    {
      "DOM.getDocument": {
        root: {
          nodeId: 1,
          children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
        },
      },
      "CSS.enable": {},
      "CSS.getComputedStyleForNode": {
        computedStyle: [{ name: "--test-var", value: "10px" }],
      },
      "CSS.disable": {},
    },
    sentCommands,
  );

  const limitations: string[] = [];
  await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(sentCommands).toContain("CSS.disable");
});

it("handles detached node error (-32000) during in-flight navigation gracefully", async () => {
  const sentCommands: string[] = [];
  const connection = makeMockConnection(
    {
      "DOM.getDocument": {
        root: {
          nodeId: 1,
          children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
        },
      },
      "CSS.enable": {},
      "CSS.getComputedStyleForNode": new CdpCommandRejection(
        "inspect_web_page",
        "CSS.getComputedStyleForNode",
        -32000,
        "Could not find node with given id",
      ),
      "CSS.disable": {},
    },
    sentCommands,
  );

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(result.status).toBe("unavailable");
  expect(sentCommands).toContain("CSS.disable");
  expect(
    limitations.some(
      (lim) =>
        lim.includes("CSS.getComputedStyleForNode failed (CDP error -32000)") &&
        lim.includes("Could not find node with given id"),
    ),
  ).toBe(true);
});

it("preserves observed count and records rejection limitation when tokens fail schema validation", async () => {
  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: [
        { name: "--valid-token", value: "#333333" },
        { name: "--oversized-token", value: "x".repeat(600) },
        { name: "not-a-css-var", value: "ignored" },
      ],
    },
    "CSS.disable": {},
  });

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(result.total).toBe(2);
  expect(result.retained_count).toBe(1);
  expect(result.items).toEqual([{ name: "--valid-token", value: "#333333" }]);
  expect(
    limitations.some(
      (lim) =>
        lim.includes("1 root CSS custom property was rejected") &&
        lim.includes("--oversized-token"),
    ),
  ).toBe(true);
});

it("truncates excessively long rejected names and bounds preview list in limitations", async () => {
  const longName = `--${"a".repeat(150)}`;
  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: [
        { name: longName, value: "10px" },
        { name: "--bad-1", value: "x".repeat(600) },
        { name: "--bad-2", value: "x".repeat(600) },
        { name: "--bad-3", value: "x".repeat(600) },
        { name: "--bad-4", value: "x".repeat(600) },
      ],
    },
    "CSS.disable": {},
  });

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(result.total).toBe(5);
  expect(result.retained_count).toBe(0);
  expect(limitations).toHaveLength(1);
  const limitationMsg = limitations[0] ?? "";
  expect(limitationMsg).toContain(
    "5 root CSS custom properties were rejected:",
  );
  expect(limitationMsg).toContain("...");
  expect(limitationMsg).toContain("and 2 more");
  expect(limitationMsg.includes(longName)).toBe(false);
});

it("records informational limitation when CSS variables are truncated", async () => {
  const oversizedVariables = Array.from({ length: 260 }, (_, i) => ({
    name: `--var-${String(i).padStart(3, "0")}`,
    value: `${String(i)}px`,
  }));

  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: oversizedVariables,
    },
    "CSS.disable": {},
  });

  const limitations: string[] = [];
  await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(
    limitations.some((lim) => lim.includes("truncated to 250 items")),
  ).toBe(true);
});

it("redacts URL transport credentials from CSS url() values", async () => {
  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: [
        {
          name: "--bg-asset",
          value:
            "URL(  'https://alice:secret123@example.test/assets/bg.png'  )",
        },
        {
          name: "--local-asset",
          value: 'url( "/assets/bg.png" )',
        },
      ],
    },
    "CSS.disable": {},
  });

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(result.items).toHaveLength(2);
  const bgItem = result.items.find((item) => item.name === "--bg-asset");
  expect(bgItem?.value).not.toContain("secret123");
  expect(bgItem?.value).toBe("URL(  'https://example.test/assets/bg.png'  )");

  const localItem = result.items.find((item) => item.name === "--local-asset");
  expect(localItem?.value).toBe('url( "/assets/bg.png" )');
});

it("treats missing or non-array computedStyle as unavailable with limitation", async () => {
  const connection = makeMockConnection({
    "DOM.getDocument": {
      root: {
        nodeId: 1,
        children: [{ nodeId: 2, nodeType: 1, nodeName: "HTML" }],
      },
    },
    "CSS.enable": {},
    "CSS.getComputedStyleForNode": {
      computedStyle: "not-an-array",
    },
    "CSS.disable": {},
  });

  const limitations: string[] = [];
  const result = await captureCssVariables(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target_1",
        include_css_variables: true,
      }),
    },
    limitations,
  );

  expect(result.status).toBe("unavailable");
  expect(
    limitations.some((lim) =>
      lim.includes(
        "CSS.getComputedStyleForNode response omitted valid computedStyle",
      ),
    ),
  ).toBe(true);
});
