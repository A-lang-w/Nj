import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ElfNotesService } from "../../application/binaryDiagnostics/ElfNotesService.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { elfNoteTablePastEnd } from "./ElfNotes.fixture.js";
import { ElfNotesProvider } from "./ElfNotesProvider.js";

it("reports a note table past the end of the file as invalid input", async () => {
  const root = await createTestTempDirectory("rea-elf-note-past-end-");
  const path = join(root, "program");
  await writeFile(path, elfNoteTablePastEnd());
  const service = new ElfNotesService(new ElfNotesProvider());
  try {
    const result = await service.inspect({ path });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid input");
    expect(result.error).toBeInstanceOf(AnalysisInputError);
    expect(result.error).toMatchObject({
      _tag: "AnalysisInputError",
      issues: [
        {
          path: ["path"],
          reason: "invalid_format",
          message: expect.stringContaining("leaves the artifact"),
        },
      ],
    });
  } finally {
    await service.close();
  }
});
