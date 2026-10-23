import { expect, it } from "vitest";
import { inspectSignalDecodersInputSchema } from "../../../src/domain/signals/signalDecoders.js";
import { parseDecoderDiscovery } from "../../../src/signals/parseDecoderDiscovery.js";

it("rejects malformed catalogs and the wrong decoder identity", () => {
  for (const text of [
    "",
    "Supported protocol decoders:\n",
    "Supported protocol decoders:\n  uart UART\n  uart Duplicate",
    "Supported protocol decoders:\n  malformed",
  ]) {
    expect(() =>
      parseDecoderDiscovery(text, inspectSignalDecodersInputSchema.parse({})),
    ).toThrow();
  }
  expect(() =>
    parseDecoderDiscovery(
      "ID: spi\nOptions:",
      inspectSignalDecodersInputSchema.parse({ decoder: "uart" }),
    ),
  ).toThrow();
});

it("keeps help line ordinals, blank lines and literal special characters through selection", () => {
  const text = "ID: uart\r\nOptions:\r\n\r\n- mode: A[0] (default 'x')\r\n";
  const result = parseDecoderDiscovery(
    text,
    inspectSignalDecodersInputSchema.parse({
      decoder: "uart",
      query: "[0]",
      offset: 0,
      limit: 1,
    }),
  );
  expect(result.help_lines).toEqual([
    { line_number: 4, text: "- mode: A[0] (default 'x')" },
  ]);
  expect(result.output_window.examined).toBe(4);
});

it("bounds line expansion before constructing help records", () => {
  expect(() =>
    parseDecoderDiscovery(
      "ID: uart\n" + "\n".repeat(65536),
      inspectSignalDecodersInputSchema.parse({ decoder: "uart" }),
    ),
  ).toThrow("representation budget");
});

it("matches Greek sigma in catalog names and help lines without contextual lowercasing omissions", () => {
  const catalogText =
    "Supported protocol decoders:\n  sample  ΟΣ\n  control  ASCII\n";
  for (const query of ["Σ", "σ", "ς", "ΟΣ", "ascii", ""]) {
    const input = inspectSignalDecodersInputSchema.parse({ query });
    const result = parseDecoderDiscovery(catalogText, input);
    if (query === "Σ" || query === "σ" || query === "ς" || query === "ΟΣ") {
      expect(result.decoders).toEqual([{ id: "sample", name: "ΟΣ" }]);
      expect(result.output_window.matching).toBe(1);
    } else if (query === "ascii") {
      expect(result.decoders).toEqual([{ id: "control", name: "ASCII" }]);
      expect(result.output_window.matching).toBe(1);
    } else if (query === "") {
      expect(result.output_window.matching).toBe(2);
    }
  }

  const helpText = "ID: sample\nName: ΟΣ\nDescription: ASCII\n";
  for (const query of ["Σ", "σ", "ς", "ΟΣ", "ascii"]) {
    const input = inspectSignalDecodersInputSchema.parse({
      decoder: "sample",
      query,
    });
    const result = parseDecoderDiscovery(helpText, input);
    if (query === "Σ" || query === "σ" || query === "ς" || query === "ΟΣ") {
      expect(result.help_lines).toEqual([{ line_number: 2, text: "Name: ΟΣ" }]);
      expect(result.output_window.matching).toBe(1);
    } else if (query === "ascii") {
      expect(result.help_lines).toEqual([
        { line_number: 3, text: "Description: ASCII" },
      ]);
      expect(result.output_window.matching).toBe(1);
    }
  }
});
