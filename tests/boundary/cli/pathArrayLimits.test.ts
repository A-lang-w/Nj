import { expect, it } from "vitest";
import { serveCli } from "./cliServeHarness.js";

it.each([
  [
    "recover-javascript-sources",
    "additionalPath",
    "--additional-path",
    ["/input.js", "/output"],
    (index: number) => `selected-${index}.js`,
  ],
  [
    "inspect-wasm-artifact",
    "glue_paths",
    "--glue_paths",
    ["input.wasm"],
    (index: number) => `selected-${index}.js`,
  ],
  [
    "inspect-wasm-artifact",
    "candidate_paths",
    "--candidate_paths",
    ["input.wasm"],
    (index: number) => `selected-${index}.wasm`,
  ],
  [
    "start-adb-activity",
    "extra",
    "--extra",
    ["emulator-5554", "android.intent.action.VIEW"],
    (index: number) => `string:key${index}:value`,
  ],
] as const)(
  "%s rejects over-limit %s before starting its workflow",
  async (command, _field, option, args, value) => {
    const values = Array.from({ length: 17 }, (_, index) => value(index));
    const rejected = await serveCli([
      command,
      ...args,
      ...values.flatMap((entry) => [option, entry]),
      "--json",
    ]);
    expect(JSON.parse(rejected.stdout)).toMatchObject({
      code: "VALIDATION_ERROR",
    });
  },
);
