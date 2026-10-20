import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function verifyAscClassOracle(raw, independent, query) {
  const canonical = (descriptor) =>
    descriptor.slice(1, -1).replaceAll("/", ".");
  const expected = independent.dexes
    .flatMap((dex) =>
      dex.descriptors
        .filter((descriptor) => canonical(descriptor).includes(query))
        .map((descriptor) =>
          JSON.stringify([dex.entry, descriptor, canonical(descriptor)]),
        ),
    )
    .sort();
  assert.equal(
    raw.total_classes,
    independent.dexes.reduce((sum, dex) => sum + dex.descriptors.length, 0),
    "ASC total definitions agree with independent class_def tables",
  );
  assert.deepEqual(
    raw.dexes.map((dex) => dex.entry).sort(),
    independent.dexes.map((dex) => dex.entry).sort(),
    "ASC examined root DEX entries",
  );
  for (const dex of raw.dexes) {
    const source = independent.dexes.find(
      (candidate) => candidate.entry === dex.entry,
    );
    assert.equal(dex.entry_sha256, source.sha256, "ASC root DEX source digest");
    assert.equal(dex.sha256, source.sha256, "ASC untransformed DEX digest");
  }
  const actual = raw.classes
    .map((cls) =>
      JSON.stringify([raw.dexes[cls.dex]?.entry, cls.descriptor, cls.name]),
    )
    .sort();
  assert.deepEqual(
    actual,
    expected,
    "ASC matching definitions and source DEX agree with independent oracle",
  );
  return expected.map((encoded) => JSON.parse(encoded)[2]).sort();
}

export function dexClassDescriptors(bytes) {
  assert(
    bytes.length >= 112 &&
      /^dex\n0(?:3[5-9]|40)\0$/.test(bytes.toString("binary", 0, 8)),
    "Oracle supports ordinary DEX 035–040 only; DEX 041 containers are not verified",
  );
  assert.equal(
    bytes.readUInt32LE(32),
    bytes.length,
    "DEX advertised file size",
  );
  assert.equal(bytes.readUInt32LE(36), 112, "DEX header size");
  assert.equal(bytes.readUInt32LE(40), 0x12345678, "DEX byte order");
  const table = (countAt, offsetAt, width) => {
    const count = bytes.readUInt32LE(countAt),
      offset = bytes.readUInt32LE(offsetAt);
    assert(
      offset <= bytes.length &&
        count <= Math.floor((bytes.length - offset) / width),
      "DEX table outside bytes",
    );
    return { count, offset };
  };
  const strings = table(56, 60, 4),
    types = table(64, 68, 4),
    definitions = table(96, 100, 32);
  const readString = (index) => {
    assert(index < strings.count, "DEX string index");
    let at = bytes.readUInt32LE(strings.offset + 4 * index),
      end = at;
    for (let index = 0; ; index++) {
      assert(end < bytes.length && index < 5, "DEX string length ULEB128");
      if ((bytes[end++] & 0x80) === 0) break;
    }
    at = end;
    while (end < bytes.length && bytes[end] !== 0) end++;
    assert(end < bytes.length, "DEX terminated string");
    const units = [];
    for (let index = at; index < end;) {
      const first = bytes[index++];
      if (first < 128) units.push(first);
      else if ((first & 224) === 192) {
        assert(
          index < end && (bytes[index] & 192) === 128,
          "MUTF-8 continuation",
        );
        units.push(((first & 31) << 6) | (bytes[index++] & 63));
      } else {
        assert(
          (first & 240) === 224 &&
            index + 1 < end &&
            (bytes[index] & 192) === 128 &&
            (bytes[index + 1] & 192) === 128,
          "MUTF-8 sequence",
        );
        units.push(
          ((first & 15) << 12) |
            ((bytes[index++] & 63) << 6) |
            (bytes[index++] & 63),
        );
      }
    }
    return units.map((unit) => String.fromCharCode(unit)).join("");
  };
  return Array.from({ length: definitions.count }, (_, index) => {
    const type = bytes.readUInt32LE(definitions.offset + index * 32);
    assert(type < types.count, "DEX class type index");
    const descriptor = readString(bytes.readUInt32LE(types.offset + type * 4));
    assert(/^L[^;]+;$/.test(descriptor), "DEX class descriptor");
    return descriptor;
  });
}

export async function hashFile(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

export async function oracle(apk, maxDexBytes) {
  const bytes = await readFile(apk);
  let end = -1;
  for (
    let index = bytes.length - 22;
    index >= Math.max(0, bytes.length - 65557);
    index--
  ) {
    if (
      bytes.readUInt32LE(index) === 0x06054b50 &&
      index + 22 + bytes.readUInt16LE(index + 20) === bytes.length
    ) {
      end = index;
      break;
    }
  }
  assert(
    end >= 0 &&
      bytes.readUInt16LE(end + 4) === 0 &&
      bytes.readUInt16LE(end + 6) === 0,
    "Oracle expects a single-volume ZIP",
  );
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16),
    size = 0;
  assert(count !== 65535 && at !== 0xffffffff, "Oracle does not support ZIP64");
  const dexes = [],
    seen = new Set();
  for (let index = 0; index < count; index++) {
    assert.equal(
      bytes.readUInt32LE(at),
      0x02014b50,
      "ZIP central directory signature",
    );
    const flags = bytes.readUInt16LE(at + 8),
      method = bytes.readUInt16LE(at + 10);
    const compressed = bytes.readUInt32LE(at + 20),
      length = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28),
      extra = bytes.readUInt16LE(at + 30),
      comment = bytes.readUInt16LE(at + 32);
    const name = bytes.toString("utf8", at + 46, at + 46 + nameLength),
      local = bytes.readUInt32LE(at + 42);
    at += 46 + nameLength + extra + comment;
    assert(!seen.has(name), "Oracle rejects duplicate ZIP names");
    seen.add(name);
    if (name.includes("/") || !name.endsWith(".dex")) continue;
    size += length;
    assert(size <= maxDexBytes, "Oracle DEX byte budget");
    assert(
      (flags & 1) === 0 && (method === 0 || method === 8),
      "Oracle supports unencrypted stored/deflated DEX",
    );
    assert.equal(bytes.readUInt32LE(local), 0x04034b50, "ZIP local signature");
    const start =
      local +
      30 +
      bytes.readUInt16LE(local + 26) +
      bytes.readUInt16LE(local + 28);
    assert(start + compressed <= bytes.length, "ZIP compressed bytes");
    const packed = bytes.subarray(start, start + compressed);
    const dex =
      method === 0
        ? packed
        : inflateRawSync(packed, { maxOutputLength: length });
    assert.equal(dex.length, length, "ZIP decoded length");
    dexes.push({
      entry: name,
      bytes: length,
      sha256: sha(dex),
      descriptors: dexClassDescriptors(dex),
    });
  }
  assert(dexes.length > 0, "Oracle needs root DEX definitions");
  return {
    method:
      "Independent Node ZIP decoder and direct DEX string/type/class_def tables; no ASC/JADX parser",
    limitations: [
      "No ZIP64, DEX 041 containers or nested DEX",
      "Oracle validates structure and byte digests, not ZIP CRC or full DEX semantics",
    ],
    dexes,
  };
}

export function oracleSelfTest() {
  const dex = Buffer.alloc(192);
  dex.write("dex\n035\0", 0, "binary");
  dex.writeUInt32LE(dex.length, 32);
  dex.writeUInt32LE(112, 36);
  dex.writeUInt32LE(0x12345678, 40);
  dex.writeUInt32LE(1, 56);
  dex.writeUInt32LE(112, 60);
  dex.writeUInt32LE(1, 64);
  dex.writeUInt32LE(116, 68);
  dex.writeUInt32LE(1, 96);
  dex.writeUInt32LE(120, 100);
  dex.writeUInt32LE(160, 112);
  dex[160] = 8;
  dex.write("Ldemo/A;\0", 161, "binary");
  assert.deepEqual(dexClassDescriptors(dex), ["Ldemo/A;"]);
  assert.throws(() => dexClassDescriptors(dex.subarray(0, 100)));
  const definitions = {
    dexes: [
      {
        entry: "classes.dex",
        sha256: "a",
        descriptors: ["Ldemo/A;", "Ldemo/A$Inner;"],
      },
    ],
  };
  assert.throws(
    () =>
      verifyAscClassOracle(
        {
          total_classes: 2,
          dexes: [{ entry: "classes.dex", entry_sha256: "a", sha256: "a" }],
          classes: [{ dex: 0, descriptor: "Ldemo/A;", name: "demo.A" }],
        },
        definitions,
        "demo.A",
      ),
    /matching definitions/,
  );
}
