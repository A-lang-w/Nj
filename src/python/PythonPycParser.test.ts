import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  inspectPythonPycInputSchema,
  pythonPycSchema,
  type PythonPyc,
} from "../domain/python/pythonPyc.js";
import {
  marshalCode,
  pythonPycFixture,
  pythonPycHeader,
} from "./PythonPyc.fixture.js";
import { parsePythonPyc } from "./PythonPycParser.js";
import {
  PythonPycFormatFailure,
  PythonPycResourceFailure,
} from "./PythonPyc.errors.js";

const defaults = inspectPythonPycInputSchema.parse({
  path: "/artifacts/sample.pyc",
});

const root = (report: PythonPyc) => {
  const code = report.code_objects[0];
  if (code === undefined) throw new Error("Report lists no code object");
  return code;
};

const parse = (bytes: Buffer) =>
  parsePythonPyc(
    bytes,
    {
      path: defaults.path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    },
    defaults,
  );

it("reads 3.7, 3.10 and 3.12 layouts including nested code", () => {
  const py37 = parse(pythonPycFixture("py37"));
  expect(py37.header).toMatchObject({
    magic: 3394,
    python_version: "3.7",
    code_layout: "py37",
    hash_based: false,
  });
  expect(root(py37).posonlyargcount).toBeNull();
  expect(root(py37).nlocals).toBe(0);
  expect(root(py37).qualname).toBeNull();

  const py38 = parse(pythonPycFixture("py38", { nested: true }));
  expect(py38.header.python_version).toBe("3.10");
  expect(root(py38).posonlyargcount).toBe(0);
  expect(py38.code_objects[1]?.name).toBe("inner");
  expect(py38.coverage.code_objects).toBe(2);

  const py311 = parse(pythonPycFixture("py311", { nested: true }));
  expect(py311.header).toMatchObject({
    magic: 3531,
    python_version: "3.12",
    code_layout: "py311",
  });
  expect(root(py311).nlocals).toBeNull();
  expect(root(py311).qualname).toBe("<module>");
  expect(py311.code_objects[1]?.name).toBe("inner");
  expect(root(py311).consts).toEqual(
    expect.arrayContaining([
      { kind: "code", name: "inner", firstlineno: 2 },
      { kind: "none" },
    ]),
  );
});

it("decodes a hash-based header and a FLAG_REF top-level code object", () => {
  const bytes = pythonPycFixture("py311", {
    flaggedCode: true,
    header: {
      flags: 0x1,
      sourceHash: Buffer.from("0102030405060708", "hex"),
    },
  });
  const report = parse(bytes);
  expect(report.header).toMatchObject({
    hash_based: true,
    check_source: false,
    source_hash_hex: "0102030405060708",
    source_mtime: null,
    source_size: null,
  });
  expect(root(report).name).toBe("<module>");
});

it("fails unknown magics and truncated marshal without partial success", () => {
  const unknown = Buffer.concat([pythonPycHeader(1), marshalCode("py311")]);
  expect(() => parse(unknown)).toThrow(PythonPycFormatFailure);
  expect(() => parse(pythonPycFixture("py311").subarray(0, 20))).toThrow(
    PythonPycFormatFailure,
  );
});

const u32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};
const i32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32LE(value);
  return bytes;
};
const f64 = (value: number): Buffer => {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleLE(value);
  return bytes;
};
const marshalRef = (index: number): Buffer =>
  Buffer.concat([Buffer.from([0x72]), u32(index)]);
const marshalLong = (digits: readonly number[], negative = false): Buffer =>
  Buffer.concat([
    Buffer.from([0x6c]),
    i32(negative ? -digits.length : digits.length),
    ...digits.map((digit) => {
      const bytes = Buffer.alloc(2);
      bytes.writeUInt16LE(digit);
      return bytes;
    }),
  ]);
const marshalUnicode = (bytes: Buffer): Buffer =>
  Buffer.concat([Buffer.from([0x75]), u32(bytes.length), bytes]);
const withConsts = (consts: Buffer[]): Buffer =>
  Buffer.concat([pythonPycHeader(3531), marshalCode("py311", { consts })]);

/** Each level keeps one flagged child and two TYPE_REF copies of it. */
const sharedChain = (levels: number): Buffer => {
  const level = (index: number): Buffer =>
    index === levels
      ? marshalCode("py311", { name: `leaf`, flagged: true })
      : marshalCode("py311", {
          name: `level${index}`,
          flagged: index > 0,
          consts: [level(index + 1), marshalRef(index), marshalRef(index)],
        });
  return Buffer.concat([pythonPycHeader(3531), level(0)]);
};

it("lists a code object shared through TYPE_REF once and refers to it by index", () => {
  const small = parse(sharedChain(3));
  expect(small.code_objects.map((code) => code.name)).toEqual([
    "level0",
    "level1",
    "level2",
    "leaf",
  ]);
  expect(small.code_objects.map((code) => code.nested_code)).toEqual([
    [1, 1, 1],
    [2, 2, 2],
    [3, 3, 3],
    [],
  ]);
  expect(small.coverage.code_objects).toBe(4);
  expect(pythonPycSchema.safeParse(small).success).toBe(true);
  const started = Date.now();
  const deep = parse(sharedChain(25));
  expect(Date.now() - started).toBeLessThan(1000);
  expect(deep.coverage.code_objects).toBe(26);
  expect(JSON.stringify(deep).length).toBeLessThan(64 * 1024);
});

it("bounds names repeated through TYPE_REF by what the report carries", () => {
  const name = Buffer.alloc(1000, 0x61);
  const namesObject = Buffer.concat([
    Buffer.from([0x29, 101]),
    Buffer.from([0x61 | 0x80]),
    u32(name.length),
    name,
    ...Array.from({ length: 100 }, () => marshalRef(0)),
  ]);
  const bytes = Buffer.concat([
    pythonPycHeader(3531),
    marshalCode("py311", { namesObject }),
  ]);
  expect(() =>
    parsePythonPyc(
      bytes,
      {
        path: defaults.path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      },
      { ...defaults, max_file_bytes: bytes.length },
    ),
  ).toThrow(PythonPycResourceFailure);
});

it("charges long digits to the string budget and keeps large previews bounded", () => {
  expect(() =>
    parse(withConsts([Buffer.concat([Buffer.from([0x6c]), i32(600_000)])])),
  ).toThrow(PythonPycResourceFailure);
  const report = parse(
    withConsts([
      marshalLong([1, 2]),
      marshalLong(Array.from({ length: 20 }, (_, index) => index + 1)),
    ]),
  );
  expect(root(report).consts[0]).toEqual({
    kind: "int",
    bits: 17,
    value: String(1n + (2n << 15n)),
  });
  expect(root(report).consts[1]).toMatchObject({ kind: "int", value: null });
  expect(pythonPycSchema.safeParse(report).success).toBe(true);
  expect(() => parse(withConsts([marshalLong([1, 0])]))).toThrow(
    PythonPycFormatFailure,
  );
  expect(() => parse(withConsts([marshalLong([0x8000])]))).toThrow(
    PythonPycFormatFailure,
  );
});

it("decodes marshal strings with CPython surrogatepass rules", () => {
  const report = parse(
    withConsts([marshalUnicode(Buffer.from([0x73, 0xed, 0xa0, 0x80]))]),
  );
  expect(root(report).consts[0]).toMatchObject({
    kind: "str",
    value: "s\ud800",
  });
  expect(() =>
    parse(withConsts([marshalUnicode(Buffer.from([0xf0, 0x90, 0x80]))])),
  ).toThrow(PythonPycFormatFailure);
  expect(() =>
    parse(withConsts([marshalUnicode(Buffer.from([0xc0, 0x80]))])),
  ).toThrow(PythonPycFormatFailure);
});

it("keeps non-finite float and complex constants JSON-safe", () => {
  const report = parse(
    withConsts([
      Buffer.concat([Buffer.from([0x67]), f64(Infinity)]),
      Buffer.concat([Buffer.from([0x79]), f64(0), f64(-Infinity)]),
      Buffer.concat([Buffer.from([0x67]), f64(Number.NaN)]),
    ]),
  );
  expect(root(report).consts).toEqual([
    { kind: "float", value: "inf" },
    { kind: "complex", real: 0, imag: "-inf" },
    { kind: "float", value: "nan" },
  ]);
  expect(pythonPycSchema.safeParse(report).success).toBe(true);
  expect(JSON.parse(JSON.stringify(report))).toEqual(report);
});

it("accepts an empty co_filename", () => {
  const report = parse(
    Buffer.concat([
      pythonPycHeader(3531),
      marshalCode("py311", { filename: "" }),
    ]),
  );
  expect(root(report).filename).toBe("");
  expect(pythonPycSchema.safeParse(report).success).toBe(true);
});

it("rejects a code object whose location tables are not bytes", () => {
  expect(() =>
    parse(
      Buffer.concat([
        pythonPycHeader(3531),
        marshalCode("py311", { exceptiontableObject: Buffer.from([0x53]) }),
      ]),
    ),
  ).toThrow(PythonPycFormatFailure);
});

it("hashes one shared byte string no matter how many times it is referenced", () => {
  const payload = Buffer.alloc(1024 * 1024, 0x61);
  const refs = 1200;
  const bytes = Buffer.concat([
    pythonPycHeader(3531),
    marshalCode("py311", {
      constsObject: Buffer.concat([
        Buffer.from([0x28]),
        u32(refs + 1),
        Buffer.from([0xf3]),
        u32(payload.length),
        payload,
        ...Array.from({ length: refs }, () => marshalRef(0)),
      ]),
    }),
  ]);
  const started = Date.now();
  const report = parse(bytes);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(root(report).consts).toHaveLength(refs + 1);
  expect(root(report).consts[refs]).toEqual(root(report).consts[0]);
  expect(root(report).consts[0]).toMatchObject({
    kind: "bytes",
    bytes: payload.length,
  });
});

it("rejects constant tables whose copies exceed max_objects", () => {
  const shared = Buffer.concat([
    Buffer.from([0xa9, 20]),
    Buffer.alloc(20, 0x4e),
  ]);
  const child = (constsObject: Buffer, name: string) =>
    marshalCode("py311", { constsObject, name });
  const bytes = Buffer.concat([
    pythonPycHeader(3531),
    marshalCode("py311", {
      consts: [
        child(shared, "a"),
        ...Array.from({ length: 5 }, (_, index) =>
          child(marshalRef(0), `b${index}`),
        ),
      ],
    }),
  ]);
  const artifact = {
    path: defaults.path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
  const allowed = parsePythonPyc(bytes, artifact, defaults);
  const entries = allowed.code_objects.reduce(
    (sum, code) => sum + code.consts.length,
    0,
  );
  expect(entries).toBeGreaterThan(allowed.coverage.objects);
  expect(() =>
    parsePythonPyc(bytes, artifact, {
      ...defaults,
      max_objects: entries - 1,
    }),
  ).toThrow(/Reported constants exceed max_objects/);
});

it("rejects NULL tuple items and mismatched local kinds", () => {
  expect(() => parse(withConsts([Buffer.from([0x30])]))).toThrow(
    PythonPycFormatFailure,
  );
  expect(
    root(parse(withConsts([Buffer.from([0x7b, 0x4e, 0x54, 0x30])]))).consts[0],
  ).toEqual({
    kind: "dict",
    length: 1,
  });
  expect(() =>
    parse(
      Buffer.concat([
        pythonPycHeader(3531),
        marshalCode("py311", {
          localsplusnames: ["v"],
          localspluskinds: Buffer.alloc(0),
        }),
      ]),
    ),
  ).toThrow(PythonPycFormatFailure);
  const matched = parse(
    Buffer.concat([
      pythonPycHeader(3531),
      marshalCode("py311", {
        localsplusnames: ["v"],
        localspluskinds: Buffer.from([0x20]),
      }),
    ]),
  );
  expect(root(matched).localsplusnames).toEqual(["v"]);
  expect(root(matched).localspluskinds_hex).toBe("20");
  const broken = {
    ...matched,
    code_objects: [
      { ...root(matched), localspluskinds_hex: "" },
      ...matched.code_objects.slice(1),
    ],
  };
  expect(pythonPycSchema.safeParse(broken).success).toBe(false);
  expect(pythonPycSchema.safeParse(matched).success).toBe(true);
});

const textFloat = (text: string): Buffer =>
  Buffer.concat([
    Buffer.from([0x66, Buffer.byteLength(text)]),
    Buffer.from(text),
  ]);

const textComplex = (real: string, imag: string): Buffer =>
  Buffer.concat([
    Buffer.from([0x78, Buffer.byteLength(real)]),
    Buffer.from(real),
    Buffer.from([Buffer.byteLength(imag)]),
    Buffer.from(imag),
  ]);

const parseLimited = (bytes: Buffer, max_file_bytes: number) =>
  parsePythonPyc(
    bytes,
    {
      path: defaults.path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    },
    { ...defaults, max_file_bytes },
  );

it("charges every reported code-constant name against the file budget", () => {
  const name = Buffer.alloc(2000, 0x6e);
  const nameObject = Buffer.concat([
    Buffer.from([0x61]),
    u32(name.length),
    name,
  ]);
  const child = marshalCode("py311", {
    nameObject,
    qualnameObject: nameObject,
    flagged: true,
  });
  const file = (copies: number): Buffer =>
    Buffer.concat([
      pythonPycHeader(3531),
      marshalCode("py311", {
        constsObject: Buffer.concat([
          Buffer.from([0x28]),
          u32(copies),
          child,
          ...Array.from({ length: copies - 1 }, () => marshalRef(0)),
        ]),
      }),
    ]);
  const once = parseLimited(file(1), 20_000);
  expect(root(once).consts[0]).toMatchObject({
    kind: "code",
    name: "n".repeat(2000),
  });
  expect(pythonPycSchema.safeParse(once).success).toBe(true);
  expect(() => parseLimited(file(30), 20_000)).toThrow(
    PythonPycResourceFailure,
  );
});

it("reuses a shared integer's bit length instead of converting every reference", () => {
  const digits = Array.from({ length: 20_000 }, () => 0x7fff);
  const long = marshalLong(digits);
  const flagged = Buffer.concat([
    Buffer.from([(long[0] ?? 0) | 0x80]),
    long.subarray(1),
  ]);
  const refs = 400;
  const bytes = Buffer.concat([
    pythonPycHeader(3531),
    marshalCode("py311", {
      constsObject: Buffer.concat([
        Buffer.from([0x28]),
        u32(refs + 1),
        flagged,
        ...Array.from({ length: refs }, () => marshalRef(0)),
      ]),
    }),
  ]);
  const started = Date.now();
  const report = parse(bytes);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(root(report).consts[0]).toEqual({
    kind: "int",
    bits: digits.length * 15,
    value: null,
  });
  expect(root(report).consts[refs]).toEqual(root(report).consts[0]);
});

it("lists code objects nested inside constant containers", () => {
  const hidden = marshalCode("py311", {
    name: "hidden",
    qualname: "hidden",
    firstlineno: 4,
  });
  const wrapped = Buffer.concat([Buffer.from([0x29, 1]), hidden]);
  const report = parse(withConsts([wrapped]));
  expect(report.code_objects.map((code) => code.name)).toEqual([
    "<module>",
    "hidden",
  ]);
  expect(root(report).nested_code).toEqual([1]);
  expect(root(report).consts[0]).toEqual({ kind: "tuple", length: 1 });
  expect(report.coverage).toMatchObject({
    status: "complete",
    code_objects: 2,
  });
  expect(pythonPycSchema.safeParse(report).success).toBe(true);

  const listed = Buffer.concat([Buffer.from([0x5b]), u32(1), hidden]);
  const deeper = parse(
    withConsts([Buffer.concat([Buffer.from([0x29, 1]), listed])]),
  );
  expect(deeper.code_objects.map((code) => code.name)).toEqual([
    "<module>",
    "hidden",
  ]);
  const keyed = Buffer.concat([
    Buffer.from([0x7b, 0x69]),
    i32(1),
    hidden,
    Buffer.from([0x30]),
  ]);
  expect(
    parse(withConsts([keyed])).code_objects.map((code) => code.name),
  ).toEqual(["<module>", "hidden"]);
});

it("accepts containers that contain themselves", () => {
  const list = Buffer.concat([
    Buffer.from([0x5b | 0x80]),
    u32(1),
    marshalRef(0),
  ]);
  expect(root(parse(withConsts([list]))).consts[0]).toEqual({
    kind: "list",
    length: 1,
  });
  const dict = Buffer.concat([
    Buffer.from([0x7b | 0x80, 0x69 | 0x80]),
    i32(1),
    marshalRef(0),
    Buffer.from([0x30]),
  ]);
  const report = parse(withConsts([dict]));
  expect(root(report).consts[0]).toEqual({ kind: "dict", length: 1 });
  expect(pythonPycSchema.safeParse(report).success).toBe(true);
});

it("reads marshal version 0 text floats inside a code object", () => {
  const version0 = Buffer.from(
    "cb0d0d0a0000000000000000000000006300000000000000000000000001000000000000007308000000970064005a00790128020000006603312e354e280100000075010000007828000000007300000000750900000073616d706c652e707975080000003c6d6f64756c653e75080000003c6d6f64756c653e01000000730a000000f003010101d8040781017300000000",
    "hex",
  );
  const report = parse(version0);
  expect(report.header).toMatchObject({
    magic: 3531,
    python_version: "3.12",
    code_layout: "py311",
  });
  expect(root(report).name).toBe("<module>");
  expect(root(report).consts[0]).toEqual({ kind: "float", value: 1.5 });
  expect(pythonPycSchema.safeParse(report).success).toBe(true);
  const specials = parse(
    withConsts([
      textFloat("inf"),
      textFloat("-inf"),
      textFloat("nan"),
      textComplex("0", "inf"),
      textFloat("1e-2"),
    ]),
  );
  expect(root(specials).consts).toEqual([
    { kind: "float", value: "inf" },
    { kind: "float", value: "-inf" },
    { kind: "float", value: "nan" },
    { kind: "complex", real: 0, imag: "inf" },
    { kind: "float", value: 0.01 },
  ]);
  for (const text of ["1.5x", "", "0x1.8p1", " 1.5"]) {
    expect(() => parse(withConsts([textFloat(text)]))).toThrow(
      PythonPycFormatFailure,
    );
  }
});

it("accepts empty code names", () => {
  const child = marshalCode("py311", { name: "", qualname: "" });
  const report = parse(
    Buffer.concat([
      pythonPycHeader(3531),
      marshalCode("py311", {
        name: "",
        qualname: "",
        consts: [child],
      }),
    ]),
  );
  expect(root(report).name).toBe("");
  expect(root(report).qualname).toBe("");
  expect(root(report).consts[0]).toEqual({
    kind: "code",
    name: "",
    firstlineno: 1,
  });
  expect(report.code_objects[1]?.name).toBe("");
  expect(pythonPycSchema.safeParse(report).success).toBe(true);
});

it("reports the marshal byte length of a string constant", () => {
  const report = parse(
    withConsts([
      marshalUnicode(Buffer.from([0xed, 0xa0, 0x80, 0xed, 0xb0, 0x80])),
    ]),
  );
  expect(root(report).consts[0]).toMatchObject({ kind: "str", bytes: 6 });
});

it("applies Python container rules before reporting lengths", () => {
  const setOf = (...members: Buffer[]): Buffer =>
    Buffer.concat([Buffer.from([0x3c]), u32(members.length), ...members]);
  const int = (value: number): Buffer =>
    Buffer.concat([Buffer.from([0x69]), i32(value)]);
  expect(root(parse(withConsts([setOf(int(1), int(1))]))).consts[0]).toEqual({
    kind: "set",
    length: 1,
  });
  expect(
    root(parse(withConsts([setOf(Buffer.from([0x54]), int(1))]))).consts[0],
  ).toEqual({ kind: "set", length: 1 });
  expect(
    root(
      parse(
        withConsts([
          setOf(int(1), Buffer.concat([Buffer.from([0x67]), f64(1)])),
        ]),
      ),
    ).consts[0],
  ).toEqual({ kind: "set", length: 1 });
  expect(
    root(
      parse(
        withConsts([
          setOf(
            Buffer.concat([Buffer.from([0x67]), f64(Number.NaN)]),
            Buffer.concat([Buffer.from([0x67]), f64(Number.NaN)]),
          ),
        ]),
      ),
    ).consts[0],
  ).toEqual({ kind: "set", length: 2 });
  const sameNan = Buffer.concat([Buffer.from([0x67 | 0x80]), f64(Number.NaN)]);
  expect(
    root(parse(withConsts([setOf(sameNan, marshalRef(0))]))).consts[0],
  ).toEqual({ kind: "set", length: 1 });
  expect(
    root(
      parse(
        withConsts([
          Buffer.concat([Buffer.from([0x3e]), u32(2), int(1), int(1)]),
        ]),
      ),
    ).consts[0],
  ).toEqual({ kind: "frozenset", length: 1 });
  expect(
    root(parse(withConsts([Buffer.from([0x7b, 0x4e, 0x30])]))).consts[0],
  ).toEqual({ kind: "dict", length: 0 });
  const overwritten = Buffer.concat([
    Buffer.from([0x7b]),
    int(1),
    int(10),
    int(1),
    int(11),
    Buffer.from([0x30]),
  ]);
  expect(root(parse(withConsts([overwritten]))).consts[0]).toEqual({
    kind: "dict",
    length: 1,
  });
  const complexOne = Buffer.concat([Buffer.from([0x79]), f64(1), f64(0)]);
  expect(
    root(parse(withConsts([setOf(int(1), complexOne)]))).consts[0],
  ).toEqual({ kind: "set", length: 1 });
  expect(() =>
    parse(
      withConsts([
        Buffer.concat([
          Buffer.from([0x7b, 0x5b]),
          u32(0),
          Buffer.from([0x4e, 0x30]),
        ]),
      ]),
    ),
  ).toThrow(PythonPycFormatFailure);
  expect(() =>
    parse(withConsts([setOf(Buffer.concat([Buffer.from([0x5b]), u32(0)]))])),
  ).toThrow(PythonPycFormatFailure);
});

it("leaves 3.11 alpha magics with other code layouts unsupported", () => {
  for (const magic of [3452, 3459, 3460, 3493]) {
    const bytes = Buffer.concat([pythonPycHeader(magic), marshalCode("py311")]);
    expect(() => parse(bytes)).toThrow(
      expect.objectContaining({ kind: "unsupported" }),
    );
  }
  expect(
    parse(pythonPycFixture("py311", { magic: 3495 })).header,
  ).toMatchObject({ python_version: "3.11", code_layout: "py311" });
});
