import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { browserScenarioSchema } from "../../dist/domain/browserScenario.js";
import { browserScenarioCaptureSchema } from "../../dist/domain/browserScenarioCapture.js";
import { parseEvidence } from "../../dist/domain/evidence.js";
import {
  requestFixtureCsrf,
  requestFixtureToken,
  startBrowserRequestSite,
} from "../fixtures/browser-request-site.mjs";

const run = promisify(execFile);

const authenticated = [
  { name: "X-CSRFToken", value: { source: "cookie", name: "csrftoken" } },
  {
    name: "Authorization",
    value: { source: "local_storage", key: "auth", json_pointer: "/token" },
    prefix: "Bearer ",
  },
];

const read = (step_id, path) => ({
  step_id,
  action: "request",
  method: "GET",
  path,
  expected_status: [200],
});

const write = (step_id, method, path, json, expected_status) => ({
  step_id,
  action: "request",
  method,
  path,
  headers: authenticated,
  ...(json === undefined ? {} : { json }),
  expected_status,
});

const pause = (step_id) => ({
  step_id,
  action: "wait_for_timeout",
  duration_ms: 1100,
});

/** A recording that writes two scratch items and reads each write back at once, as an environment needs. */
const writeSession = (executable, origin) =>
  browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: executable },
    start_url: { url: `${origin}/` },
    actions: [
      {
        step_id: "ready",
        action: "wait_for",
        locator: { kind: "css", selector: "#ready" },
        state: "visible",
        timeout_ms: 10_000,
      },
      read("list-1", "/api/items"),
      read("list-2", "/api/items"),
      read("item-1", "/api/items/1"),
      write(
        "create-1",
        "POST",
        "/api/items",
        { title: "Scratch item 1" },
        [201],
      ),
      read("created-1", "/api/items/3"),
      read("list-created-1", "/api/items"),
      write(
        "create-2",
        "POST",
        "/api/items",
        { title: "Scratch item 2" },
        [201],
      ),
      read("created-2", "/api/items/4"),
      read("list-created-2", "/api/items"),
      pause("settle-creates"),
      write(
        "update-1",
        "PUT",
        "/api/items/3",
        { title: "Scratch item 1 renamed", done: true },
        [200],
      ),
      read("updated-1", "/api/items/3"),
      read("list-updated-1", "/api/items"),
      write(
        "update-2",
        "PUT",
        "/api/items/4",
        { title: "Scratch item 2 renamed", done: false },
        [200],
      ),
      read("updated-2", "/api/items/4"),
      read("list-updated-2", "/api/items"),
      write("delete-1", "DELETE", "/api/items/3", undefined, [204]),
      { ...read("deleted-1", "/api/items/3"), expected_status: [404] },
      read("list-deleted-1", "/api/items"),
      write("delete-2", "DELETE", "/api/items/4", undefined, [204]),
      { ...read("deleted-2", "/api/items/4"), expected_status: [404] },
      read("list-deleted-2", "/api/items"),
      read("session", "/api/session"),
    ],
    capture: {
      at_end: ["url"],
      network: { request_body: true, response_body: true, header_values: true },
    },
  });

/**
 * Record a write session through request steps in a real browser, then build
 * an environment from it: every request lands in its own step, the page's
 * CSRF cookie and stored token authenticate the writes and never reach the
 * Evidence, and the build serves the recorded writes.
 */
export async function verifyBrowserRequestSteps(
  executable,
  entrypoint = fileURLToPath(new URL("../rea.mjs", import.meta.url)),
) {
  const site = await startBrowserRequestSite();
  const root = await mkdtemp(join(tmpdir(), "rea-request-e2e-"));
  try {
    const env = {
      ...process.env,
      REA_LOG_LEVEL: "silent",
      HOPPER_LAUNCHER_PATH: "/rea-unconfigured-provider/hopper",
    };
    const scenario = writeSession(executable, site.origin);
    const { stdout } = await run(
      process.execPath,
      [
        entrypoint,
        "capture-browser-scenario",
        JSON.stringify(scenario),
        "--json",
      ],
      { env, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const evidence = parseEvidence(JSON.parse(stdout));
    const capture = browserScenarioCaptureSchema.parse(
      evidence.normalized_result,
    );
    const steps = capture.steps.filter(
      (step) => step.step_id !== "scenario_start",
    );
    assert.equal(steps.length, scenario.actions.length);
    for (const step of steps)
      assert.equal(step.status, "completed", JSON.stringify(step));
    const requests = capture.events.items.filter(
      (event) => event.kind === "request",
    );
    scenario.actions.forEach((action, index) => {
      if (action.action !== "request") return;
      const stepIndex = capture.steps.findIndex(
        (step) => step.step_id === action.step_id,
      );
      assert.equal(capture.steps[stepIndex].action, "request");
      const sent = requests.filter(
        (event) =>
          event.step_index === stepIndex &&
          event.method === action.method &&
          new URL(event.url.url).pathname === action.path,
      );
      assert.equal(sent.length, 1, `step ${String(index)} ${action.step_id}`);
    });
    assert.equal(site.writes.length, 6);
    assert.ok(site.writes.every(({ csrf, bearer }) => csrf && bearer));
    // Bodies are base64 in the Evidence, so decode them before looking for the values.
    const contents = capture.events.items.filter(
      (event) => event.kind === "network-content",
    );
    const bodies = contents
      .filter((event) => event.body.state === "captured")
      .map((event) => Buffer.from(event.body.content, "base64").toString());
    const headerValues = contents.flatMap((event) =>
      event.headers.state === "captured"
        ? event.headers.items.map((item) => item.value ?? "")
        : [],
    );
    const retained = [JSON.stringify(evidence), ...bodies, ...headerValues];
    for (const value of [requestFixtureCsrf, requestFixtureToken])
      assert.ok(
        retained.every((text) => !text.includes(value)),
        `${value} was retained`,
      );
    assert.ok(
      headerValues.some((value) =>
        value.includes("[REDACTED:page:create-1.X-CSRFToken]"),
      ),
      "the CSRF header was not recorded redacted",
    );
    assert.ok(
      bodies.some(
        (body) =>
          body.includes('"token"') && body.includes("[REDACTED:page:create-1."),
      ),
      "the session response was not recorded redacted",
    );
    assert.ok(
      capture.limitations.some((line) => line.startsWith("Request steps sent")),
    );

    const capturePath = join(root, "items.capture.json");
    await writeFile(capturePath, stdout);
    const built = JSON.parse(
      (
        await run(
          process.execPath,
          [
            entrypoint,
            "environment-build",
            capturePath,
            join(root, "env"),
            "--json",
          ],
          { env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
        )
      ).stdout,
    );
    assert.equal(built.status, "built");
    assert.equal(built.name, "items");
    const served = built.coverage.writes.served.map(({ tool }) => tool).sort();
    assert.deepEqual(
      served,
      ["delete_items_by_id", "post_items", "put_items_by_id"],
      JSON.stringify(built.coverage),
    );

    const failing = browserScenarioSchema.parse({
      ...scenario,
      actions: [
        write("delete-missing", "DELETE", "/api/items/999", undefined, [204]),
        read("after", "/api/items"),
      ],
    });
    const refused = parseEvidence(
      JSON.parse(
        (
          await run(
            process.execPath,
            [
              entrypoint,
              "capture-browser-scenario",
              JSON.stringify(failing),
              "--json",
            ],
            { env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
          )
        ).stdout,
      ),
    );
    const outcome = browserScenarioCaptureSchema.parse(
      refused.normalized_result,
    );
    const missing = outcome.steps.find(
      ({ step_id }) => step_id === "delete-missing",
    );
    assert.equal(missing.status, "failed");
    assert.match(missing.error ?? "", /answered 404; expected 204/u);
    assert.equal(
      outcome.steps.find(({ step_id }) => step_id === "after").status,
      "cancelled",
    );
    return {
      request_steps: scenario.actions.filter(
        ({ action }) => action === "request",
      ).length,
      authenticated_writes: site.writes.length,
      served_writes: served,
      tool_count: built.tool_count,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
    await site.close();
  }
}
