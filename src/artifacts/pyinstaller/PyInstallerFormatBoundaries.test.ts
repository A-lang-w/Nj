import { buffer } from "node:stream/consumers";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import { withPyInstallerReader } from "../../../tests/fixtures/pyinstallerReader.js";
import {
  scanCanonicalArtifactInventory,
  materializeArtifactInventory,
} from "../../../tests/fixtures/artifactInventory.js";
import {
  cArchiveExecutable,
  pyzArchive,
  PYTHON_39_MAGIC,
} from "./CArchive.fixture.js";
import { readPyzArchive } from "./PyzArchive.js";
import type { ArtifactEntry } from "../ArtifactReader.js";

it.each(["x", "s", "empty-module"])(
  "does not treat a same-named %s as a crypto-key module",
  async (kind) => {
    await withPyInstallerReader(
      cArchiveExecutable({
        layout: "2.1",
        pythonVersion: 309,
        members: [
          {
            name: "pyimod00_crypto_key",
            typeCode: kind === "empty-module" ? "m" : kind,
            payload:
              kind === "empty-module"
                ? Buffer.alloc(0)
                : Buffer.from("ordinary content"),
            compress: false,
          },
          {
            name: "PYZ.pyz",
            typeCode: "z",
            compress: false,
            payload: pyzArchive({
              magic: PYTHON_39_MAGIC,
              modules: [
                {
                  name: "app",
                  typeCode: 0,
                  body: Buffer.from("readable module"),
                },
              ],
            }),
          },
        ],
      }),
      async (_reader, _handle, path) => {
        const inventory = await scanCanonicalArtifactInventory(path);
        expect(
          inventory.occurrences.find((row) => row.logical_path === ".")
            ?.format_metadata,
        ).toMatchObject({ encryption_marker_present: false });
        expect(
          inventory.occurrences.find(
            (row) => row.logical_path === "PYZ.pyz/app.pyc",
          ),
        ).toMatchObject({
          encrypted: false,
          hash_status: "verified",
          format_metadata: { encryption_source: null },
        });
        const output = join(dirname(path), "extracted");
        await materializeArtifactInventory(
          {
            inputPath: path,
            inputFormat: "elf",
            outputRoot: output,
            environment: process.env,
            integrityPolicy: "fail",
          },
          path,
          inventory,
        );
        expect(
          (await readFile(join(output, "PYZ.pyz/app.pyc"))).subarray(16),
        ).toEqual(Buffer.from("readable module"));
      },
    );
  },
);

it.each([
  "module-in-toc",
  "module-crossing-toc",
  "namespace-in-toc",
  "namespace-past-image",
])("rejects PYZ positions outside the payload region (%s)", async (kind) => {
  const image = pyzArchive({
    magic: PYTHON_39_MAGIC,
    modules: [
      {
        name: "app",
        typeCode: kind.startsWith("namespace") ? 3 : 0,
        body: Buffer.from("payload"),
      },
    ],
  });
  const toc = image.readUInt32BE(8);
  if (kind === "module-crossing-toc")
    image.writeInt32LE(toc - 12 + 1, image.length - 4);
  else
    image.writeInt32LE(
      kind === "namespace-past-image" ? image.length + 1 : toc + 1,
      image.length - 9,
    );
  await withPyInstallerReader(image, async (_reader, handle) => {
    await expect(
      readPyzArchive(handle, 0, image.length),
    ).resolves.toMatchObject({ ok: false, error: { reason: "integrity" } });
  });
});

it("retains legacy namespace payload extents without materializing them", async () => {
  const image = pyzArchive({
    magic: PYTHON_39_MAGIC,
    modules: [
      {
        name: "ns",
        typeCode: 0,
        body: Buffer.from("legacy namespace code object"),
      },
    ],
  });
  image.writeInt32LE(3, image.length - 14);
  const length = image.readInt32LE(image.length - 4);
  expect(length).toBeGreaterThan(0);
  await withPyInstallerReader(
    cArchiveExecutable({
      layout: "2.1",
      pythonVersion: 309,
      members: [
        { name: "PYZ.pyz", typeCode: "z", compress: false, payload: image },
      ],
    }),
    async (_reader, _handle, path) => {
      const inventory = await scanCanonicalArtifactInventory(path);
      expect(
        inventory.occurrences.find((row) => row.logical_path === "PYZ.pyz/ns"),
      ).toMatchObject({
        entry_kind: "directory",
        declared_size: 0,
        compressed_size: length,
        format_metadata: { relative_offset: 12, type_code: 3 },
        limitations: expect.arrayContaining([
          expect.stringContaining("not materialized"),
        ]),
      });
      const result = await materializeArtifactInventory(
        {
          inputPath: path,
          inputFormat: "elf",
          outputRoot: join(dirname(path), "out"),
          environment: process.env,
          integrityPolicy: "fail",
        },
        path,
        inventory,
      );
      expect(result.artifacts).toEqual([]);
    },
  );
});

it.each([
  ["sequence", Buffer.from("5ba1860100", "hex")],
  ["string", Buffer.from("7501000100", "hex")],
  [
    "depth",
    Buffer.concat([
      ...Array.from({ length: 18 }, () => Buffer.from([0x29, 1])),
      Buffer.from("6900000000", "hex"),
    ]),
  ],
  [
    "nodes",
    Buffer.concat([
      Buffer.from("5ba0860100", "hex"),
      Buffer.alloc(100_000 * 5).fill(Buffer.from("6900000000", "hex")),
    ]),
  ],
])(
  "preserves the marshal %s resource failure through inventory",
  async (_guard, toc) => {
    await withPyInstallerReader(
      cArchiveExecutable({
        layout: "2.1",
        pythonVersion: 309,
        members: [
          {
            name: "PYZ.pyz",
            typeCode: "z",
            compress: false,
            payload: pyzArchive({ magic: PYTHON_39_MAGIC, modules: [], toc }),
          },
        ],
      }),
      async (_reader, _handle, path) => {
        await expect(
          scanCanonicalArtifactInventory(path),
        ).rejects.toMatchObject({
          reason: "limit",
          message: expect.stringContaining("PYZ marshal"),
        });
      },
    );
  },
);

it.each([1, 2])(
  "rejects namespace data extending into the table (length %s)",
  async (length) => {
    const image = pyzArchive({
      magic: PYTHON_39_MAGIC,
      modules: [{ name: "ns", typeCode: 3, body: Buffer.alloc(0) }],
    });
    // The fixture's last two marshal integers are the namespace offset/length.
    image.writeInt32LE(12, image.length - 9);
    image.writeInt32LE(length, image.length - 4);
    await withPyInstallerReader(
      cArchiveExecutable({
        layout: "2.1",
        pythonVersion: 309,
        members: [
          { name: "PYZ.pyz", typeCode: "z", compress: false, payload: image },
        ],
      }),
      async (_reader, _handle, path) => {
        await expect(
          scanCanonicalArtifactInventory(path),
        ).rejects.toMatchObject({
          reason: "integrity",
          message: expect.stringContaining("payload region"),
        });
      },
    );
  },
);

it("retains the producer's nonzero namespace offset without inventing data", async () => {
  await withPyInstallerReader(
    cArchiveExecutable({
      layout: "2.1",
      pythonVersion: 309,
      members: [
        {
          name: "PYZ.pyz",
          typeCode: "z",
          compress: false,
          payload: pyzArchive({
            magic: PYTHON_39_MAGIC,
            modules: [{ name: "ns", typeCode: 3, body: Buffer.alloc(0) }],
          }),
        },
      ],
    }),
    async (_reader, _handle, path) => {
      const inventory = await scanCanonicalArtifactInventory(path);
      expect(
        inventory.occurrences.find((row) => row.logical_path === "PYZ.pyz/ns"),
      ).toMatchObject({
        entry_kind: "directory",
        declared_size: 0,
        compressed_size: 0,
        format_metadata: { relative_offset: 12, type_code: 3 },
      });
    },
  );
});

it("retains multipackage references as distinct unresolved declarations", async () => {
  const names = [
    "../owner/app:assets/x:y",
    "../owner/app:assets/x:y",
    "missing-colon",
    ":empty-owner",
  ];
  await withPyInstallerReader(
    cArchiveExecutable({
      layout: "2.1",
      pythonVersion: 309,
      members: names.map((name) => ({
        name,
        typeCode: "d",
        payload: Buffer.alloc(0),
        compress: false,
      })),
    }),
    async (reader) => {
      const entries: ArtifactEntry[] = [];
      for await (const entry of reader.entries()) entries.push(entry);
      expect(reader.formatMetadata()).toMatchObject({
        external_dependency_count: names.length,
        runtime_option_count: 0,
      });
      expect(new Set(entries.map((entry) => entry.adapterKey)).size).toBe(
        names.length,
      );
      for (const [index, entry] of entries.entries()) {
        expect(entry.kind).toBe("metadata");
        expect(entry.path).toBe(
          `__pyinstaller__/dependencies/${String(index)}`,
        );
        expect(entry.formatMetadata).toMatchObject({
          source_name: names[index],
          type_code: "d",
          dependency_status: index < 2 ? "unresolved" : "invalid-reference",
          dependency_archive: index < 2 ? "../owner/app" : null,
          dependency_member: index < 2 ? "assets/x:y" : null,
        });
        await expect(reader.open(entry)).rejects.toMatchObject({
          reason: "format",
        });
      }
    },
  );
});

for (const container of ["carchive", "outer-pyz", "inner-pyz"] as const) {
  it.each(["junk", "second-stream"])(
    `rejects unused compressed input in ${container} (%s)`,
    async (suffixKind) => {
      const suffix =
        suffixKind === "junk"
          ? Buffer.from("trailing bytes")
          : deflateSync(Buffer.from("another stream"));
      const body = Buffer.from("first stream");
      const image = pyzArchive({
        magic: PYTHON_39_MAGIC,
        modules: [
          {
            name: "app",
            typeCode: 0,
            body,
            ...(container === "inner-pyz" ? { compressedSuffix: suffix } : {}),
          },
        ],
      });
      const bytes = cArchiveExecutable({
        layout: "2.1",
        pythonVersion: 309,
        members: [
          {
            name: container === "carchive" ? "data" : "PYZ.pyz",
            typeCode: container === "carchive" ? "x" : "z",
            payload: container === "carchive" ? body : image,
            compress: container !== "inner-pyz",
            ...(container === "inner-pyz" ? {} : { compressedSuffix: suffix }),
          },
        ],
      });
      await withPyInstallerReader(bytes, async (reader) => {
        const consume = async () => {
          for await (const entry of reader.entries())
            if (entry.kind === "file") await buffer(await reader.open(entry));
        };
        await expect(consume()).rejects.toMatchObject({
          reason: "integrity",
          message: expect.stringContaining("complete declared source span"),
        });
      });
    },
  );
}

it("fills successful short reads through actual classification, TOCs and selected module hashing", async () => {
  const bytes = cArchiveExecutable({
    layout: "2.1",
    pythonVersion: 309,
    members: [
      {
        name: "PYZ.pyz",
        typeCode: "z",
        compress: false,
        payload: pyzArchive({
          magic: PYTHON_39_MAGIC,
          modules: [
            { name: "app", typeCode: 0, body: Buffer.from("module body") },
          ],
        }),
      },
    ],
  });
  await withPyInstallerReader(bytes, async (_reader, handle, path) => {
    const read = handle.read;
    let shortReads = 0;
    const spy = vi
      .spyOn(Object.getPrototypeOf(handle), "read")
      .mockImplementation(function (this: unknown, ...args: unknown[]) {
        if (typeof args[2] === "number" && args[2] > 7) {
          args[2] = 7;
          shortReads += 1;
        }
        return Reflect.apply(read, this, args);
      });
    try {
      const inventory = await scanCanonicalArtifactInventory(path);
      expect(inventory.manifest.root_format).toBe("pyinstaller");
      expect(
        inventory.occurrences.find(
          (row) => row.logical_path === "PYZ.pyz/app.pyc",
        ),
      ).toMatchObject({
        hash_status: "verified",
        format_metadata: { source_name: "app" },
      });
      expect(shortReads).toBeGreaterThan(20);
    } finally {
      spy.mockRestore();
    }
  });
});

it("distinguishes actual EOF after a short PYZ header read", async () => {
  const bytes = pyzArchive({ magic: PYTHON_39_MAGIC, modules: [] });
  await withPyInstallerReader(bytes, async (_reader, handle) => {
    const read = handle.read.bind(handle);
    let calls = 0;
    const spy = vi
      .spyOn(handle, "read")
      .mockImplementation((...args: unknown[]) => {
        calls += 1;
        if (calls > 1)
          return Promise.resolve({ bytesRead: 0, buffer: args[0] });
        args[2] = 3;
        return Reflect.apply(read, handle, args);
      });
    try {
      await expect(
        readPyzArchive(handle, 0, bytes.length),
      ).resolves.toMatchObject({
        ok: false,
        error: { reason: "format", message: expect.stringContaining("header") },
      });
      expect(calls).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});

it("retains native I/O failure after a short read and simultaneous cancellation", async () => {
  const bytes = pyzArchive({ magic: PYTHON_39_MAGIC, modules: [] });
  await withPyInstallerReader(bytes, async (_reader, handle) => {
    const read = handle.read.bind(handle),
      caller = new AbortController();
    const failure = Object.assign(new Error("late native EIO"), {
      code: "EIO",
    });
    let calls = 0;
    const spy = vi
      .spyOn(handle, "read")
      .mockImplementation((...args: unknown[]) => {
        calls += 1;
        if (calls > 1) {
          caller.abort(new Error("caller leaves"));
          return Promise.reject(failure);
        }
        args[2] = 3;
        return Reflect.apply(read, handle, args);
      });
    try {
      await expect(
        readPyzArchive(handle, 0, bytes.length, caller.signal),
      ).rejects.toMatchObject({ reason: "io", cause: failure });
    } finally {
      spy.mockRestore();
    }
  });
});

it("rejects path-component expansion before normalization or consumer trie allocation", async () => {
  await withPyInstallerReader(
    cArchiveExecutable({
      layout: "2.1",
      pythonVersion: 309,
      members: [
        {
          name: "a/".repeat(100_000) + "x",
          typeCode: "x",
          payload: Buffer.alloc(0),
          compress: false,
        },
      ],
    }),
    async (reader) => {
      const list = async () => {
        for await (const entry of reader.entries()) void entry;
      };
      await expect(list()).rejects.toMatchObject({
        reason: "limit",
        boundary: "memory",
        message: expect.stringContaining("namespace budget"),
      });
    },
  );
});

it.each([true, false])(
  "extracts a real file sharing a metadata query path (option first: %s)",
  async (optionFirst) => {
    const path = `__pyinstaller__/runtime-options/${optionFirst ? "0" : "1"}`;
    const option = {
      name: "pyi-option value",
      typeCode: "o",
      payload: Buffer.alloc(0),
      compress: false,
    };
    const file = {
      name: path,
      typeCode: "x",
      payload: Buffer.from("real file payload"),
      compress: false,
    };
    await withPyInstallerReader(
      cArchiveExecutable({
        layout: "2.1",
        pythonVersion: 309,
        members: optionFirst ? [option, file] : [file, option],
      }),
      async (_reader, _handle, source) => {
        const inventory = await scanCanonicalArtifactInventory(source);
        const output = join(dirname(source), "extracted");
        await materializeArtifactInventory(
          {
            inputPath: source,
            inputFormat: "elf",
            outputRoot: output,
            environment: process.env,
            integrityPolicy: "fail",
          },
          source,
          inventory,
        );
        expect(await readFile(join(output, path))).toEqual(file.payload);
      },
    );
  },
);

it("reserves possible case-annotation expansion along deep sibling paths", async () => {
  const names = ["a/".repeat(4000) + "x", "A/".repeat(4000) + "X"];
  await withPyInstallerReader(
    cArchiveExecutable({
      layout: "2.1",
      pythonVersion: 309,
      members: names.map((name) => ({
        name,
        typeCode: "x",
        payload: Buffer.alloc(0),
        compress: false,
      })),
    }),
    async (reader) => {
      const list = async () => {
        for await (const entry of reader.entries()) void entry;
      };
      await expect(list()).rejects.toMatchObject({
        reason: "limit",
        boundary: "memory",
      });
    },
  );
});
