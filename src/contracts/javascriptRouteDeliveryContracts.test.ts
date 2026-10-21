import { Ajv2020 } from "ajv/dist/2020.js";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { toolContract } from "./toolContracts.js";
import { toolInputSchemaWithMetadata } from "./toolSchemaMetadata.js";

const view = { kind: "javascript-routes", collection: "routes" };
const cases = [
  ["analyze_javascript_application", { input_path: "/tmp/application" }],
  [
    "analyze_web_bundle",
    {
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "page",
      allowed_origins: ["https://example.test"],
    },
  ],
] as const;

describe.each(cases)("%s delivery contract", (name, base) => {
  it.each(["draft-2020-12", "draft-07"] as const)(
    "advertises the canonical combinations in %s",
    (target) => {
      const contract = toolContract(name);
      const projected = toolInputSchemaWithMetadata(contract)[
        "~standard"
      ].jsonSchema.input({ target });
      const ajv =
        target === "draft-2020-12"
          ? new Ajv2020({ strict: false, validateFormats: false })
          : new Ajv({ strict: false, validateFormats: false });
      expect(ajv.validateSchema(projected)).toBe(true);
      const validate = ajv.compile(projected);
      expect(projected).toMatchObject({ type: "object" });
      expect(projected).not.toHaveProperty("anyOf");
      expect(projected).not.toHaveProperty("oneOf");
      expect(projected).not.toHaveProperty("allOf");
      expect(projected).not.toHaveProperty("x-rea-root-discriminator");
      const inputs = [
        [{}, true],
        [{ detail: "complete" }, true],
        [{ detail: "summary", view }, true],
        [{ detail: "summary" }, name === "analyze_javascript_application"],
        [{ view }, false],
        [{ detail: "complete", view }, false],
        [{ detail: "summary", view: { ...view, kind: "other" } }, false],
        [{ detail: "summary", view, unexpected: true }, false],
      ] as const;
      for (const [delivery, valid] of inputs) {
        const input = { ...base, ...delivery };
        expect(
          contract.inputSchema.safeParse(input).success,
          JSON.stringify(input),
        ).toBe(valid);
        expect(
          validate(input),
          JSON.stringify({ input, errors: validate.errors }),
        ).toBe(valid);
      }
    },
  );
});
