import { expect, it } from "vitest";
import {
  analysisViewCaptureEvidence,
  environmentManifestCaptureFixture,
  environmentStateCaptureFixture,
} from "../../../tests/fixtures/analysisView.js";
import {
  SCENARIO_EXCHANGES,
  scenarioCaptureEvidence,
  scenarioCaptureFixture,
} from "../../../tests/fixtures/browserScenarioCapture.js";
import type { Evidence } from "../evidence.js";
import type { JsonValue } from "../jsonValue.js";
import {
  projectAnalysisView,
  type AnalysisViewParent,
  type AnalysisViewResult,
} from "./analysisView.js";
import { EnvironmentStateAccumulator } from "./EnvironmentStateAccumulator.js";

type State = Extract<AnalysisViewResult, { kind: "environment-state" }>;
const ALL_RULES = [
  "after-uid-literal",
  "opaque-token",
  "sibling-variance",
] as const;

const parentOf = (
  evidence: Evidence = analysisViewCaptureEvidence(
    environmentStateCaptureFixture(),
  ),
): AnalysisViewParent => ({
  evidenceId: evidence.evidence_id,
  operation: evidence.operation,
  normalizedResult: evidence.normalized_result,
  subject: evidence.subject,
  limitations: [],
  parameters: evidence.parameters,
});

const stateOf = (parent: AnalysisViewParent = parentOf()): State => {
  const result = projectAnalysisView(parent, {
    kind: "environment-state",
    template_rules: [...ALL_RULES],
  });
  if (!result.ok || result.value.kind !== "environment-state")
    throw new Error("Expected an environment state");
  return result.value;
};

type Row = readonly [
  method: string,
  path: string,
  body?: JsonValue,
  status?: number,
];

/** HAR entries one second apart on one origin; a string body is recorded as written. */
const captureOf = (rows: readonly Row[]): AnalysisViewParent =>
  parentOf(
    analysisViewCaptureEvidence(
      environmentManifestCaptureFixture(
        rows.map(([method, path, body = null, status = 200], index) => ({
          startedDateTime: new Date(
            Date.parse("2026-10-17T18:00:00.000Z") + index * 1000,
          ).toISOString(),
          time: 5,
          request: { method, url: `http://app.example${path}` },
          response: {
            status,
            content: {
              mimeType: "application/json",
              text: typeof body === "string" ? body : JSON.stringify(body),
            },
          },
        })),
      ),
    ),
  );

const viewOf = (state: State, tool: string) =>
  state.views.find((view) => view.tool === tool);

it("extracts the state the Grafana-shaped capture's reads observed", () => {
  const state = stateOf();
  expect(state.timeline).toBe("recorded-start-time");
  expect(state.types).toContainEqual({
    collection_template: "/api/folders",
    id_field: "uid",
    id_basis: "path-parameter",
    init_before_ordinal: 20,
    volatile_fields: [],
  });
  expect(state.types).toContainEqual({
    collection_template: "/api/search",
    id_field: "id",
    id_basis: "field-name",
    init_before_ordinal: null,
    volatile_fields: [],
  });
  expect(
    state.entities.filter((entity) => entity.type === "/api/folders"),
  ).toEqual([
    {
      type: "/api/folders",
      collection: "/api/folders",
      id: "fg1jo91e57e2ob",
      fields: { id: 5, uid: "fg1jo91e57e2ob", title: "probe folder" },
      view_fields: [],
      record_ordinals: [12, 14],
    },
    {
      type: "/api/folders",
      collection: "/api/folders",
      id: "general",
      fields: { id: 0, uid: "general", title: "Dashboards" },
      view_fields: [],
      record_ordinals: [13],
    },
  ]);
  expect(viewOf(state, "get_folders")).toMatchObject({
    shape: "list",
    pointer: "",
    membership: "recorded",
  });
  expect(viewOf(state, "get_folders_by_uid")).toMatchObject({
    shape: "item",
    envelope_ordinal: 12,
    checked_record_ordinals: [12, 13],
  });
  expect(viewOf(state, "get_dashboards_by_uid")).toMatchObject({
    shape: "item",
    pointer: "/dashboard",
  });
  expect(viewOf(state, "get_annotations")).toEqual({
    tool: "get_annotations",
    shape: "recorded",
    reason: "no-init-recording",
  });
  expect(state.documents).toEqual([]);
  expect(state.unknowns.map((unknown) => unknown.kind)).toEqual([
    "authorization-model",
    "response-semantics",
    "state-transition",
  ]);
  expect(
    state.limitations.filter((limitation) =>
      limitation.startsWith("Body shapes"),
    ),
  ).toEqual([]);
});

it("ends a type's state at the first write under its root, not at unrelated writes", () => {
  const state = stateOf(
    captureOf([
      ["GET", "/api/items/1", { id: 1, title: "Granite Ledger" }],
      ["PUT", "/api/notes/9", { id: 9 }],
      ["GET", "/api/items/1", { id: 1, title: "Granite Ledger" }],
      ["PUT", "/api/items/1", { id: 1, title: "Saltmarsh Depot" }],
      ["GET", "/api/items/1", { id: 1, title: "Saltmarsh Depot" }],
    ]),
  );
  expect(state.types).toEqual([
    {
      collection_template: "/api/items",
      id_field: "id",
      id_basis: "path-parameter",
      init_before_ordinal: 3,
      volatile_fields: [],
    },
  ]);
  expect(state.entities).toMatchObject([
    { id: "1", fields: { title: "Granite Ledger" }, record_ordinals: [0, 2] },
  ]);
  expect(state.views).toContainEqual(
    expect.objectContaining({ shape: "item", checked_record_ordinals: [2] }),
  );
});

it("keeps the latest value of a field that changed with no related write and names it volatile", () => {
  const state = stateOf(
    captureOf([
      ["GET", "/api/items/1", { id: 1, title: "Lighthouse Rota", seen: 10 }],
      ["GET", "/api/items/1", { id: 1, title: "Lighthouse Rota", seen: 11 }],
      ["GET", "/api/items/2", { id: 2, title: "Blue Heron", seen: 3 }],
    ]),
  );
  expect(state.types[0]).toMatchObject({ volatile_fields: ["seen"] });
  expect(state.entities[0]).toMatchObject({
    id: "1",
    fields: { seen: 11 },
  });
  expect(state.views).toContainEqual(
    expect.objectContaining({
      shape: "item",
      checked_record_ordinals: [1, 2],
    }),
  );
});

it("lists the whole collection with its counter only when every recording did", () => {
  const rows: Row[] = [
    [
      "GET",
      "/api/items",
      {
        total: 2,
        items: [
          { id: 1, title: "Ada Finch" },
          { id: 2, title: "Tomas Vey" },
        ],
      },
    ],
    ["GET", "/api/items/1", { title: "Ada Finch", id: 1, notes: "first" }],
    ["GET", "/api/items/2", { id: 2, notes: "second", title: "Tomas Vey" }],
  ];
  const whole = stateOf(captureOf(rows));
  expect(whole.views).toContainEqual(
    expect.objectContaining({
      shape: "list",
      pointer: "/items",
      fields: ["id", "title"],
      membership: "all",
      counters: ["total"],
    }),
  );
  expect(whole.entities.map((entity) => entity.fields)).toEqual([
    { id: 1, title: "Ada Finch", notes: "first" },
    { id: 2, notes: "second", title: "Tomas Vey" },
  ]);
  const filtered = stateOf(
    captureOf([
      ...rows,
      [
        "GET",
        "/api/items?title=Ada",
        { total: 1, items: [{ id: 1, title: "Ada Finch" }] },
      ],
    ]),
  );
  expect(filtered.views).toContainEqual(
    expect.objectContaining({ shape: "list", membership: "recorded" }),
  );
});

it("leaves recorded the views it cannot reproduce, with the reason", () => {
  const state = stateOf(
    captureOf([
      [
        "GET",
        "/api/boards/1",
        { meta: { viewer: "Ada Finch" }, board: { id: 1, name: "Rota" } },
      ],
      [
        "GET",
        "/api/boards/2",
        { meta: { viewer: "Mina Okafor" }, board: { id: 2, name: "Depot" } },
      ],
      ["GET", "/api/ledgers/1", '{"id":1,"total":12345678901234567890}'],
      ["POST", "/api/boards/search", [{ id: 1, name: "Rota" }]],
    ]),
  );
  expect(
    state.views.map((view) =>
      view.shape === "recorded" ? [view.tool, view.reason] : view.tool,
    ),
  ).toEqual([
    ["post_boards_search", "query-body"],
    ["get_boards_by_id", "envelope-varies"],
    ["get_ledgers_by_id", "body-unusable"],
  ]);
  expect(state.types).toEqual([]);
  expect(state.entities).toEqual([]);
});

it("holds a written path's non-entity read as a document", () => {
  const state = stateOf(
    captureOf([
      ["GET", "/api/settings", { theme: "dark", density: "compact" }],
      ["PUT", "/api/settings", { theme: "light", density: "compact" }],
      ["GET", "/api/settings", { theme: "light", density: "compact" }],
    ]),
  );
  expect(state.documents).toEqual([
    {
      tool: "get_settings",
      path: "/api/settings",
      value: { theme: "dark", density: "compact" },
      record_ordinal: 0,
    },
  ]);
  expect(viewOf(state, "get_settings")).toEqual({
    tool: "get_settings",
    shape: "document",
    checked_record_ordinals: [0],
  });
});

it("orders a scenario capture by request order and needs its response bodies", () => {
  const state = stateOf(parentOf(scenarioCaptureEvidence()));
  expect(state.timeline).toBe("record-order");
  expect(state.types).toEqual([
    {
      collection_template: "/api/users",
      id_field: "id",
      id_basis: "path-parameter",
      init_before_ordinal: null,
      volatile_fields: [],
    },
  ]);
  expect(state.entities.map((entity) => entity.fields)).toEqual([
    { id: 2, login: "probe" },
    { id: 3, login: "viewer" },
  ]);
  const headersOnly = scenarioCaptureEvidence(
    scenarioCaptureFixture(SCENARIO_EXCHANGES, {
      request_body: true,
      response_body: false,
      header_values: true,
    }),
  );
  expect(
    projectAnalysisView(parentOf(headersOnly), {
      kind: "environment-state",
      template_rules: [],
    }),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisUnsupportedTargetError",
      message: expect.stringContaining("response_body selected"),
    },
  });
});

it("refuses when extraction would exceed the projection budget", () => {
  expect(
    projectAnalysisView(
      parentOf(),
      { kind: "environment-state", template_rules: [...ALL_RULES] },
      { state: new EnvironmentStateAccumulator(160 * 1024, [...ALL_RULES]) },
    ),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisResourceConstraintError",
      resource: "memory",
      message: expect.stringContaining("Environment-state"),
    },
  });
});
