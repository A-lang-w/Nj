// Deterministic stand-in for bridge/binaryninja/rea_binaryninja_bridge.py.
// It speaks the same newline-delimited JSON protocol with canned observations
// shaped like a real `where.exe` analysis, and misbehaves on request so the
// TypeScript adapter's failure paths can be exercised without Binary Ninja.
import { createInterface } from "node:readline";

const [mode = "normal"] = process.argv.slice(2);

const send = (frame) => {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
};

const ready = {
  event: "ready",
  core_version: "6.0.10905",
  build_id: 4269369514,
  product: "Binary Ninja",
  product_type: "Fixture",
  license_count: 1,
  ui_enabled: false,
  python_version: "3.13.14",
  api_dir: process.argv.includes("--api-dir")
    ? process.argv[process.argv.indexOf("--api-dir") + 1]
    : "fixture",
  user_plugins_disabled: process.env.BN_DISABLE_USER_PLUGINS === "1",
  user_settings_disabled: process.env.BN_DISABLE_USER_SETTINGS === "1",
  pid: process.pid,
};

const symbol = (name, auto = false, type = "FunctionSymbol") => ({
  type,
  auto,
  source: auto ? "default" : "user_defined",
  external: false,
  short_name: name,
  full_name: name,
  raw_name: name,
});

const main = {
  address: "0x140001000",
  name: "main",
  symbol: symbol("main"),
  thunk: false,
  thunk_target: null,
  external: false,
  body: {
    ranges: [
      { start: "0x140001000", end: "0x14000103f" },
      { start: "0x140001050", end: "0x14000105f" },
    ],
    total_bytes: 80,
    span_bytes: 96,
    contains_entry: true,
  },
};
const helper = {
  address: "0x140001100",
  name: "sub_140001100",
  symbol: symbol("sub_140001100", true),
  thunk: false,
  thunk_target: null,
  external: false,
  body: {
    ranges: [{ start: "0x140001100", end: "0x14000110f" }],
    total_bytes: 16,
    span_bytes: 16,
    contains_entry: true,
  },
};
const functions = [main, helper];
const strings = [
  {
    address: "0x14000a000",
    type: "AsciiString",
    encoding: "ascii",
    byte_length: 5,
    value: "hello",
  },
  {
    address: "0x14000a010",
    type: "Utf16String",
    encoding: "utf-16",
    byte_length: 10,
    value: "wörld",
  },
];

const functionResult = (selector, facets) => {
  const found = functions.find(
    (fn) => fn.address === selector || fn.name === selector,
  );
  if (found === undefined)
    return {
      ok: false,
      error: {
        code: "function_not_found",
        message: selector.startsWith("0x")
          ? "No Binary Ninja function starts at this address"
          : "No Binary Ninja function has this exact name",
        details: { procedure: selector },
      },
    };
  const result = { procedure: found };
  const wanted = new Set(facets);
  if (wanted.has("pseudocode")) {
    result.signature = `int32_t ${found.name}()`;
    result.pseudocode = [
      `  int32_t ${found.name}()`,
      "",
      "{",
      found === main ? "    return sub_140001100();" : "    return 7;",
      "}",
    ];
  }
  if (wanted.has("assembly"))
    result.assembly = [
      { address: found.address, text: "sub     rsp, 0x28" },
      {
        address: `0x${(parseInt(found.address, 16) + 4).toString(16)}`,
        text: found === main ? "call    sub_140001100" : "mov     eax, 0x7",
      },
    ];
  if (wanted.has("callers"))
    result.callers =
      found === helper ? [{ procedure: main, sites: ["0x140001004"] }] : [];
  if (wanted.has("callees"))
    result.callees =
      found === main
        ? {
            resolved: [
              {
                target: { kind: "function", procedure: helper },
                sites: ["0x140001004"],
              },
              {
                target: {
                  kind: "symbol",
                  address: "0x14000a298",
                  name: "Sleep",
                  symbol: {
                    ...symbol("Sleep", true, "ImportAddressSymbol"),
                    source: "imported",
                    external: true,
                  },
                },
                sites: ["0x140001020"],
              },
            ],
            unresolved_sites: ["0x140001030"],
          }
        : { resolved: [], unresolved_sites: [] };
  if (wanted.has("blocks"))
    result.basic_blocks = [
      {
        start: found.address,
        end: `0x${(parseInt(found.address, 16) + 15).toString(16)}`,
        successors: [],
      },
    ];
  if (wanted.has("locals"))
    result.locals = [
      {
        name: "var_18",
        type: "int32_t",
        source_type: "StackVariableSourceType",
        storage: -24,
      },
      {
        name: "rax",
        type: "int64_t",
        source_type: "RegisterVariableSourceType",
        storage: 0,
      },
    ];
  if (wanted.has("comments"))
    result.comments =
      found === main ? [{ address: "0x140001000", text: "entry" }] : [];
  if (wanted.has("references")) {
    result.incoming_references =
      found === helper
        ? [
            {
              source: "0x140001004",
              target: "0x140001100",
              category: "call",
              source_function: main,
              target_function: helper,
            },
          ]
        : [];
    result.outgoing_references =
      found === main
        ? [
            {
              source: "0x140001004",
              target: "0x140001100",
              category: "call",
              source_function: main,
              target_function: helper,
            },
            {
              source: "0x140001010",
              target: "0x14000a000",
              category: "data",
              source_function: main,
              target_function: null,
            },
          ]
        : [];
  }
  if (wanted.has("strings_names")) {
    result.referenced_strings =
      found === main ? [{ ...strings[0], source_address: "0x140001010" }] : [];
    result.referenced_names =
      found === main
        ? [
            {
              address: "0x14000a298",
              value: "Sleep",
              source_address: "0x140001020",
            },
          ]
        : [];
  }
  return { ok: true, result };
};

let open = false;
const handle = (request) => {
  const { id, op, params = {} } = request;
  const reply = (result) => send({ id, ok: true, result });
  const failure = (code, message, details = {}) =>
    send({ id, ok: false, error: { code, message, details } });
  switch (op) {
    case "health":
      return reply({
        open,
        core_version: ready.core_version,
        ...(open ? { analysis_state: "IdleState", path: params.path } : {}),
      });
    case "open": {
      if (mode === "digest-mismatch")
        return failure(
          "digest_mismatch",
          "The bytes Binary Ninja loaded do not match the admitted target digest",
          {
            expected_sha256: params.sha256,
            observed_sha256: "0".repeat(64),
            raw_bytes: 1,
          },
        );
      if (mode === "view-mismatch")
        return failure(
          "view_type_mismatch",
          "Binary Ninja loaded the file as Mapped; REA admitted it as pe",
          { view_type: "Mapped", format: params.format },
        );
      if (mode === "hang-open") return undefined;
      if (mode === "exit-during-open") process.exit(9);
      const respond = () => {
        open = true;
        reply({
          path: params.path,
          view_type: "PE",
          architecture: "x86_64",
          platform: "windows-x86_64",
          entry_point: "0x140001000",
          start: "0x140000000",
          end: "0x140010000",
          length: 65536,
          address_size: 8,
          endianness: "LittleEndian",
          analysis_state: "IdleState",
          function_count: functions.length,
          string_count: strings.length,
          segment_count: 3,
          has_symbols: true,
          relocatable: true,
          core_version: ready.core_version,
          load_and_analysis_ms: 12,
        });
      };
      if (mode === "slow-open") {
        setTimeout(respond, 400);
        return undefined;
      }
      return respond();
    }
    case "functions":
      if (!open)
        return failure("not_open", "No BinaryView is open; send open first");
      return reply(functions);
    case "function": {
      if (!open)
        return failure("not_open", "No BinaryView is open; send open first");
      if (mode === "invalid-line") {
        process.stdout.write("this is not json\n");
        return undefined;
      }
      if (mode === "oversized")
        return reply({ procedure: main, pseudocode: ["x".repeat(2048)] });
      const outcome = functionResult(params.procedure, params.facets ?? []);
      return outcome.ok ? reply(outcome.result) : send({ id, ...outcome });
    }
    case "strings":
      if (!open)
        return failure("not_open", "No BinaryView is open; send open first");
      return reply(
        params.address === undefined
          ? strings
          : strings.filter((item) => item.address === params.address),
      );
    case "xrefs":
      if (!open)
        return failure("not_open", "No BinaryView is open; send open first");
      if (!/^0x[0-9a-f]+$/u.test(params.address ?? ""))
        return failure(
          "invalid_address",
          "Binary Ninja addresses must be 0x-prefixed hexadecimal strings",
          { address: params.address ?? null },
        );
      return reply(
        params.address === helper.address
          ? {
              address: params.address,
              code: [{ address: "0x140001004", function: main.address }],
              data: ["0x14000c000"],
            }
          : { address: params.address, code: [], data: [] },
      );
    case "containing": {
      if (!open)
        return failure("not_open", "No BinaryView is open; send open first");
      const address = parseInt(params.address, 16);
      const owners = functions.filter((fn) =>
        fn.body.ranges.some(
          (range) =>
            parseInt(range.start, 16) <= address &&
            address <= parseInt(range.end, 16),
        ),
      );
      return reply({
        address: params.address,
        in_segment: address >= 0x140000000 && address < 0x140010000,
        functions: owners,
      });
    }
    case "close":
      open = false;
      reply({ closed: true });
      process.exit(0);
      return undefined;
    default:
      return failure("unknown_operation", "Unknown bridge operation", { op });
  }
};

if (mode === "fatal") {
  send({
    event: "fatal",
    code: "import_failed",
    message: "ModuleNotFoundError: No module named 'binaryninja'",
    api_dir: ready.api_dir,
  });
  process.exit(3);
}
if (mode === "hang") {
  setInterval(() => undefined, 1_000);
} else {
  send(ready);
  if (mode === "crash-after-ready") process.exit(1);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    handle(JSON.parse(line));
  });
  lines.on("close", () => process.exit(0));
}
