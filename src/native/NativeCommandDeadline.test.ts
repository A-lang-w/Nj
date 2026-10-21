import { describe, expect, it } from "vitest";

import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { JsonValue } from "../domain/jsonValue.js";
import {
  NativeFixtureRunner,
  nativeMachoTarget,
} from "../../tests/fixtures/nativeCommands.js";
import type {
  NativeCommandOptions,
  NativeCommandRunner,
} from "./CommandRunner.js";
import { NATIVE_COMMAND_TIMEOUT_MS } from "./CommandRunner.js";
import { NativeMacOSProvider } from "./NativeMacOSProvider.js";

class RecordingRunner implements NativeCommandRunner {
  readonly timeouts: number[] = [];
  readonly #inner = new NativeFixtureRunner();

  run(
    tool: string,
    arguments_: readonly string[],
    options: NativeCommandOptions,
  ) {
    if (options.timeoutMs !== undefined) this.timeouts.push(options.timeoutMs);
    return this.#inner.run(tool, arguments_, options);
  }
}

const execute = async (
  runner: NativeCommandRunner,
  parameters: Readonly<Record<string, JsonValue>>,
) => {
  const client = new NativeMacOSProvider({}, runner, "darwin").createClient(
    nativeMachoTarget("/fixture/app"),
  );
  return client.execute("list_architectures", parameters);
};

describe("native_command_timeout_ms", () => {
  it("uses 60000 ms when the caller omits the setting", async () => {
    const runner = new RecordingRunner();
    const result = await execute(runner, {});
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(runner.timeouts.every((timeout) => timeout === 60_000)).toBe(true);
    expect(NATIVE_COMMAND_TIMEOUT_MS).toBe(60_000);
    expect(runner.timeouts.length).toBeGreaterThan(0);
  });

  it("passes a selected deadline through to each native command", async () => {
    const runner = new RecordingRunner();
    const result = await execute(runner, { native_command_timeout_ms: 1_500 });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(runner.timeouts.every((timeout) => timeout === 1_500)).toBe(true);
  });

  it("rejects an out-of-range deadline before launching a command", async () => {
    const runner = new RecordingRunner();
    const result = await execute(runner, { native_command_timeout_ms: 0 });
    if (result.ok) throw new Error("expected an invalid deadline");
    expect(runner.timeouts).toEqual([]);
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          {
            path: ["native_command_timeout_ms"],
            reason: "out_of_range",
            minimum: 1,
            maximum: 2_147_483_647,
          },
        ],
      },
    });
  });
});
