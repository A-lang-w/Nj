import { expect, it } from "vitest";
import type { AnySchema } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { asarHeaderBytes } from "../fixtures/asarHeader.js";

it("advertises exact contracts and recovers a full large-index archive over one MCP connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-runtime-settings-"));
  const archive = join(root, "application.asar");
  // Large header, small payload: tests index admission independently of input/member size.
  const first = Buffer.from("export const answer = 42;\n");
  const second = Buffer.from(
    "import { answer } from './main.js'; export const result = answer;\n",
  );
  const header = asarHeaderBytes(
    " ".repeat(16 * 1024 * 1024) +
      JSON.stringify({
        files: {
          "main.js": { size: first.length, offset: "0" },
          "second.js": { size: second.length, offset: String(first.length) },
        },
      }),
  );
  await writeFile(archive, Buffer.concat([header, first, second]));
  const { client, call: invoke } = await connectLocalToolsMcp();
  try {
    const catalog = await client.listTools();
    const ajv = new Ajv2020({ strict: false });
    for (const name of [
      "inspect_analysis_settings",
      "update_analysis_settings",
    ]) {
      const tool = catalog.tools.find((tool) => tool.name === name)!;
      expect(tool).toBeDefined();
      expect(ajv.validateSchema(tool.inputSchema as AnySchema)).toBe(true);
      expect(ajv.validateSchema(tool.outputSchema as AnySchema)).toBe(true);
    }
    const initial = await invoke("inspect_analysis_settings", {
      settings: ["asar.max_header_bytes"],
    });
    expect(initial.structuredContent).toMatchObject({
      revision: 0,
      settings: [{ value: 16777216 }],
    });
    const opened = await invoke("open_binary", { path: archive });
    expect(opened.isError).not.toBe(true);
    const failed = await invoke("inspect_artifact", {});
    expect(failed.isError).toBe(true);
    const errorText = failed.content.find((item) => item.type === "text");
    if (errorText?.type !== "text") throw new Error("Missing projected error");
    expect(JSON.parse(errorText.text).error).toMatchObject({
      details: {
        limit: {
          setting: "asar.max_header_bytes",
          effective_value: 16777216,
          agent_editable: true,
        },
      },
    });
    const analysisRequest = { input_path: archive };
    expect(
      (await invoke("analyze_javascript_application", analysisRequest)).isError,
    ).toBe(true);
    const updated = await invoke("update_analysis_settings", {
      changes: [
        { setting: "asar.max_header_bytes", action: "set", value: 33554432 },
      ],
    });
    expect(updated.isError).not.toBe(true);
    expect(updated.structuredContent).toMatchObject({
      revision: 1,
      active_work_changed: false,
      rea_restart_required: false,
    });
    const recovered = await invoke("inspect_artifact", {});
    expect(recovered.isError).not.toBe(true);
    expect(recovered.structuredContent).toMatchObject({
      normalized_result: { coverage: { status: "complete-within-substeps" } },
    });
    const analyzed = await invoke(
      "analyze_javascript_application",
      analysisRequest,
    );
    expect(analyzed.isError, JSON.stringify(analyzed)).not.toBe(true);
    expect(analyzed.structuredContent).toMatchObject({
      normalized_result: {
        statistics: { parsed_javascript_files: 2, parse_failures: 0 },
      },
    });
    await invoke("close_binary", {});
    expect((await invoke("open_binary", { path: archive })).isError).not.toBe(
      true,
    );
    expect(
      (
        await invoke("inspect_analysis_settings", {
          settings: ["asar.max_header_bytes"],
        })
      ).structuredContent,
    ).toMatchObject({
      revision: 1,
      settings: [{ value: 33554432, source: "runtime" }],
    });
    await invoke("update_analysis_settings", {
      changes: [{ setting: "asar.max_header_bytes", action: "reset" }],
    });
    expect((await invoke("inspect_artifact", {})).isError).toBe(true);
    await invoke("close_binary", {});
    expect(
      (await invoke("inspect_analysis_settings", {})).structuredContent,
    ).toMatchObject({ revision: 2 });
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
