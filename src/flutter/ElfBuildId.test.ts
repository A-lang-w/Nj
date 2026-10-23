import type { FileHandle } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { readElfBuildIds } from "./ElfBuildId.js";
import { engineFixtureImage } from "./FlutterBuild.fixture.js";
import { gnuBuildIdNote } from "../native/elf/ElfNotes.fixture.js";

/** An in-memory FileHandle backed by a Buffer; readElfBuildIds only reads. */
const bufferHandle = (data: Buffer): FileHandle =>
  ({
    read: async (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => {
      const bytesRead = data.copy(
        buffer,
        offset,
        position,
        Math.min(position + length, data.length),
      );
      return { bytesRead, buffer };
    },
  }) as unknown as FileHandle;

const read = (image: Buffer) =>
  readElfBuildIds(bufferHandle(image), image.length, undefined);

describe("readElfBuildIds GNU build-id descriptor bounds", () => {
  it("reads a GNU build-id shorter than four bytes", async () => {
    const image = engineFixtureImage({ notes: gnuBuildIdNote("112233") });
    const result = await read(image);
    expect(result.candidates).toEqual(["112233"]);
    expect(result.failures).toEqual([]);
  });

  it("keeps reading a normal 20-byte build-id", async () => {
    const hex = "0123456789abcdef0123456789abcdef01234567";
    const result = await read(
      engineFixtureImage({ notes: gnuBuildIdNote(hex) }),
    );
    expect(result.candidates).toEqual([hex]);
    expect(result.failures).toEqual([]);
  });

  it("still rejects an empty GNU build-id descriptor", async () => {
    const result = await read(
      engineFixtureImage({ notes: gnuBuildIdNote("") }),
    );
    expect(result.candidates).toEqual([]);
    expect(result.failures.length).toBeGreaterThan(0);
  });
});
