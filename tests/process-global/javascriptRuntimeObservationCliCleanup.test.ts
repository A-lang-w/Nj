import { Cli } from "incur";
import { afterEach, expect, test, vi } from "vitest";

import type { JavaScriptRuntimeObservationPort } from "../../src/application/javascript/JavaScriptRuntimeObservationPort.js";
import { registerJavaScriptRuntimeObservationCommands } from "../../src/cliJavaScriptRuntimeCommands.js";
import { ProviderCleanupError } from "../../src/domain/providerCleanupError.js";
import { ok } from "../../src/domain/result.js";
import { silentLogger } from "../../src/logger.js";

const runtimeFactory = vi.hoisted(() => ({
  provider: undefined as JavaScriptRuntimeObservationPort | undefined,
}));

// This factory substitution owns a fresh process-global module graph. The CLI
// boundary project deliberately reuses its graph across unrelated commands.
vi.mock("../../src/composition/javascriptRuntimeObservation.js", () => ({
  createJavaScriptRuntimeObservationProvider: () => {
    if (runtimeFactory.provider === undefined)
      throw new Error("No runtime observation provider was configured");
    return runtimeFactory.provider;
  },
}));

afterEach(() => {
  runtimeFactory.provider = undefined;
});

test("waits for provider cleanup and retains completed Evidence on failure", async () => {
  let closeAttempts = 0;
  runtimeFactory.provider = {
    identity: () => ({
      id: "rea-v8-inspector",
      name: "V8 Inspector",
      version: "1",
    }),
    listTargets: async () =>
      ok({
        runtime: {
          product: "node.js/v24",
          protocol_version: "1.3",
          v8_version: "13.0",
        },
        targets: [],
        excluded: { unsupported_location: 0, unconnectable: 0 },
        limitations: [],
      }),
    observe: async () => {
      throw new Error("No runtime observation requested");
    },
    close: async () => {
      closeAttempts += 1;
      throw new ProviderCleanupError(
        "rea-v8-inspector",
        ["browser_transport"],
        { reason: "Inspector transport remains retained" },
        { operation: "list_javascript_runtime_targets" },
      );
    },
  };
  const cli = Cli.create("rea-runtime-cleanup-test", { sync: false });
  registerJavaScriptRuntimeObservationCommands(cli, silentLogger);
  let stdout = "";
  await cli.serve(
    ["list-javascript-runtime-targets", "http://127.0.0.1:9229", "--json"],
    { exit: () => {}, stdout: (chunk) => (stdout += chunk) },
  );

  expect(closeAttempts, stdout).toBe(1);
  expect(JSON.parse(stdout)).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      operation: "list_javascript_runtime_targets",
      partial_observation: {
        operation: "list_javascript_runtime_targets",
        normalized_result: {
          runtime: { product: "node.js/v24" },
          targets: [],
        },
      },
    },
  });
});
