"""Source-owned tests for the headless Binary Ninja bridge protocol and projections.

These tests stand in a tiny fake ``binaryninja`` module. They establish the
bridge's framing, request validation and observation shaping, not real engine
behavior; the provider guide records real-engine verification separately.
"""

import hashlib
import importlib.util
import io
import json
import os
import sys
import types
import unittest


def load_bridge():
    spec = importlib.util.spec_from_file_location(
        "rea_binaryninja_bridge",
        os.path.join(os.path.dirname(__file__), "rea_binaryninja_bridge.py"),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bridge = load_bridge()

RAW_BYTES = b"MZ" + bytes(range(64))
RAW_DIGEST = hashlib.sha256(RAW_BYTES).hexdigest()


class Enum:
    def __init__(self, name, value=None):
        self.name = name
        self.value = value


class Range:
    def __init__(self, start, end):
        self.start = start
        self.end = end


class Symbol:
    def __init__(self, name, auto=False, type_name="FunctionSymbol"):
        self.short_name = self.full_name = self.raw_name = name
        self.auto = auto
        self.type = Enum(type_name)


class Site:
    def __init__(self, address, function=None):
        self.address = address
        self.function = function


class Block:
    def __init__(self, start, end, successors=()):
        self.start = start
        self.end = end
        self.outgoing_edges = [types.SimpleNamespace(target=types.SimpleNamespace(start=s)) for s in successors]


class Variable:
    def __init__(self, name, type_text, source, storage):
        self.name = name
        self.type = type_text
        self.source_type = Enum(source)
        self.storage = storage


class Function:
    def __init__(self, start, name, ranges, auto=False, thunk=False):
        self.start = start
        self.name = name
        self.symbol = Symbol(name, auto)
        self.address_ranges = [Range(*r) for r in ranges]
        self.is_thunk = thunk
        self.callee_addresses = []
        self.caller_sites = []
        self.call_sites = []
        self.basic_blocks = [Block(start, start + 8, [start + 8]), Block(start + 8, ranges[-1][1])]
        self.vars = [Variable("var_8", "int32_t", "StackVariableSourceType", -8)]
        self.comment = ""
        self.comments = {}
        self.instructions = [
            ([types.SimpleNamespace(__str__=lambda self: "nop")], start + 4),
            ([types.SimpleNamespace(__str__=lambda self: "ret")], start),
        ]


class StringRef:
    def __init__(self, start, value, type_name="AsciiString"):
        self.start = start
        self.value = value
        self.length = len(value)
        self.type = Enum(type_name)


class RawView:
    view_type = "Raw"

    def __init__(self, data):
        self._data = data
        self.length = len(data)

    def read(self, offset, length):
        return self._data[offset : offset + length]


class FakeView:
    def __init__(self, view_type="PE", raw=RAW_BYTES):
        self.view_type = view_type
        self.parent_view = RawView(raw)
        self.arch = types.SimpleNamespace(name="x86_64")
        self.platform = types.SimpleNamespace(name="windows-x86_64")
        self.entry_point = 0x1000
        self.start = 0x0
        self.end = 0x4000
        self.length = 0x4000
        self.address_size = 8
        self.endianness = Enum("LittleEndian")
        self.analysis_info = types.SimpleNamespace(state=2)
        self.has_symbols = True
        self.relocatable = False
        self.segments = []
        self.sections = {}
        self.file = types.SimpleNamespace(close=self._close)
        self.closed = False
        self.analysis_waited = False
        main = Function(0x1000, "main", [(0x1000, 0x1010), (0x1010, 0x1020), (0x1030, 0x1040)])
        helper = Function(0x2000, "sub_2000", [(0x2000, 0x2010)], auto=True)
        helper.caller_sites = [Site(0x1004, main)]
        main.call_sites = [Site(0x1004, main), Site(0x1008, main)]
        self.functions = [helper, main]
        self.strings = [StringRef(0x3000, "hello"), StringRef(0x3010, "wide", "Utf16String")]
        self._callees = {0x1004: [0x2000], 0x1008: []}
        self._code_refs = {0x2000: [Site(0x1004, main)]}
        self._data_refs = {0x3000: [0x1004]}

    def _close(self):
        self.closed = True

    def update_analysis_and_wait(self):
        self.analysis_waited = True

    def get_function_at(self, address):
        return next((f for f in self.functions if f.start == address), None)

    def get_functions_containing(self, address):
        return [f for f in self.functions if any(r.start <= address < r.end for r in f.address_ranges)]

    def get_segment_at(self, address):
        return object() if address < 0x4000 else None

    def get_sections_at(self, address):
        return []

    def get_symbol_at(self, address):
        return None

    def get_callees(self, address):
        return list(self._callees.get(address, []))

    def get_code_refs(self, address):
        return list(self._code_refs.get(address, []))

    def get_data_refs(self, address):
        return list(self._data_refs.get(address, []))

    def get_code_refs_from(self, address, function=None):
        return [0x2000] if address == 0x1004 else []

    def get_data_refs_from(self, address):
        return [0x3000] if address == 0x1004 else []

    def get_string_at(self, address):
        return next((s for s in self.strings if s.start == address), None)

    def read(self, address, length):
        return b"\0" * length

    def get_next_linear_disassembly_lines(self, cursor):
        if cursor.done:
            return []
        cursor.done = True
        cursor.after_end = True
        return cursor.lines


class FakeCursor:
    def __init__(self, linear):
        self.lines = linear.lines
        self.done = False
        self.after_end = False

    def seek_to_begin(self):
        pass


class FakeLine:
    def __init__(self, text, line_type, address):
        self.text = text
        self.type = Enum(line_type)
        self.contents = types.SimpleNamespace(address=address)

    def __str__(self):
        return self.text


def make_fake_binaryninja(view_factory):
    bn = types.ModuleType("binaryninja")
    bn.loads = []

    def load(path, update_analysis=True, **_):
        bn.loads.append((path, update_analysis))
        return view_factory(path)

    bn.load = load
    bn.core_version = lambda: "6.0.10905"
    bn.core_build_id = lambda: 42
    bn.core_product = lambda: "Binary Ninja"
    bn.core_product_type = lambda: "Fixture"
    bn.core_license_count = lambda: 1
    bn.core_ui_enabled = lambda: False
    bn.enums = types.SimpleNamespace(
        AnalysisState=lambda value: Enum({2: "IdleState"}.get(value, "Unknown"), value),
        DisassemblyOption=types.SimpleNamespace(ShowAddress=1, WaitForIL=2),
    )
    bn.DisassemblySettings = lambda: types.SimpleNamespace(set_option=lambda *_: None)
    bn.LinearViewObject = types.SimpleNamespace(
        single_function_language_representation=lambda function, settings: types.SimpleNamespace(
            lines=[
                FakeLine("", "FunctionHeaderStartLineType", function.start),
                FakeLine("  int32_t %s()" % function.name, "FunctionHeaderLineType", function.start),
                FakeLine("{", "BasicLineType", function.start),
                FakeLine("    return 0;", "BasicLineType", function.start + 4),
                FakeLine("}", "FunctionEndLineType", function.start),
                FakeLine("", "BlankLineType", function.start),
            ]
        )
    )
    bn.LinearViewCursor = FakeCursor
    return bn


class Writer:
    def __init__(self):
        self.frames = []

    def send(self, frame):
        self.frames.append(json.loads(json.dumps(frame)))


def run(requests, view_factory=lambda path: FakeView()):
    bn = make_fake_binaryninja(view_factory)
    writer = Writer()
    stdin = io.StringIO("".join(json.dumps(r) + "\n" for r in requests))
    code = bridge.serve(bn, "/opt/bn/python", stdin, writer)
    return code, writer.frames, bn


OPEN = {"id": 1, "op": "open", "params": {"path": "/tmp/t.exe", "sha256": RAW_DIGEST, "format": "pe"}}


class HelpersTest(unittest.TestCase):
    def test_merge_ranges_orders_and_joins_adjacent_ranges(self):
        self.assertEqual(
            bridge.merge_ranges([(0x20, 0x30), (0x10, 0x20), (0x40, 0x50), (0x48, 0x4c), (5, 5)]),
            [(0x10, 0x30), (0x40, 0x50)],
        )

    def test_parse_address_requires_hex_prefix(self):
        self.assertEqual(bridge.parse_address("0x1F"), 31)
        with self.assertRaises(bridge.BridgeError) as failure:
            bridge.parse_address("1f")
        self.assertEqual(failure.exception.code, "invalid_address")
        with self.assertRaises(bridge.BridgeError):
            bridge.parse_address(31)


class ServeTest(unittest.TestCase):
    def test_ready_frame_reports_engine_and_isolation_facts(self):
        _code, frames, _bn = run([])
        self.assertEqual(frames[0]["event"], "ready")
        self.assertEqual(frames[0]["core_version"], "6.0.10905")
        self.assertEqual(frames[0]["api_dir"], "/opt/bn/python")
        self.assertFalse(frames[0]["ui_enabled"])

    def test_open_verifies_digest_before_analysis_and_reports_the_view(self):
        _code, frames, bn = run([OPEN, {"id": 2, "op": "health"}, {"id": 3, "op": "close"}])
        self.assertEqual(bn.loads, [("/tmp/t.exe", False)])
        opened = frames[1]
        self.assertTrue(opened["ok"], opened)
        self.assertEqual(opened["result"]["view_type"], "PE")
        self.assertEqual(opened["result"]["analysis_state"], "IdleState")
        self.assertEqual(opened["result"]["function_count"], 2)
        self.assertEqual(frames[2]["result"]["open"], True)
        self.assertEqual(frames[3]["result"], {"closed": True})

    def test_open_rejects_a_digest_mismatch_and_closes_the_view(self):
        views = []

        def factory(path):
            view = FakeView(raw=b"different")
            views.append(view)
            return view

        _code, frames, _bn = run([OPEN], factory)
        self.assertFalse(frames[1]["ok"])
        self.assertEqual(frames[1]["error"]["code"], "digest_mismatch")
        self.assertEqual(frames[1]["error"]["details"]["expected_sha256"], RAW_DIGEST)
        self.assertTrue(views[0].closed)
        self.assertFalse(views[0].analysis_waited)

    def test_open_rejects_a_view_type_mismatch(self):
        _code, frames, _bn = run([OPEN], lambda path: FakeView(view_type="Mapped"))
        self.assertEqual(frames[1]["error"]["code"], "view_type_mismatch")

    def test_requests_before_open_and_unknown_operations_fail_closed(self):
        _code, frames, _bn = run([{"id": 1, "op": "functions"}, {"id": 2, "op": "bogus"}, "not an object", {"id": 4}])
        self.assertEqual(frames[1]["error"]["code"], "not_open")
        self.assertEqual(frames[2]["error"]["code"], "unknown_operation")
        self.assertEqual(frames[3]["error"]["code"], "invalid_request")
        self.assertEqual(frames[4]["error"]["code"], "invalid_request")

    def test_functions_merge_adjacent_ranges_and_classify_default_names(self):
        _code, frames, _bn = run([OPEN, {"id": 2, "op": "functions"}])
        functions = frames[2]["result"]
        self.assertEqual([f["address"] for f in functions], ["0x1000", "0x2000"])
        main = functions[0]
        self.assertEqual(main["body"]["ranges"], [{"start": "0x1000", "end": "0x101f"}, {"start": "0x1030", "end": "0x103f"}])
        self.assertEqual(main["body"]["total_bytes"], 48)
        self.assertEqual(main["body"]["span_bytes"], 64)
        self.assertEqual(main["symbol"]["source"], "user_defined")
        self.assertEqual(functions[1]["symbol"]["source"], "default")

    def test_function_facets_are_served_only_when_requested(self):
        facets = ["pseudocode", "assembly", "callers", "callees", "blocks", "locals", "references", "strings_names"]
        _code, frames, _bn = run(
            [
                OPEN,
                {"id": 2, "op": "function", "params": {"procedure": "main", "facets": facets}},
                {"id": 3, "op": "function", "params": {"procedure": "0x2000", "facets": []}},
                {"id": 4, "op": "function", "params": {"procedure": "missing", "facets": []}},
                {"id": 5, "op": "function", "params": {"procedure": "main", "facets": ["nope"]}},
            ]
        )
        main = frames[2]["result"]
        self.assertEqual(main["signature"], "int32_t main()")
        self.assertEqual(main["pseudocode"], ["  int32_t main()", "{", "    return 0;", "}"])
        self.assertEqual([i["address"] for i in main["assembly"]], ["0x1000", "0x1004"])
        self.assertEqual(main["callees"]["resolved"][0]["target"]["procedure"]["address"], "0x2000")
        self.assertEqual(main["callees"]["unresolved_sites"], ["0x1008"])
        self.assertEqual(main["locals"], [{"name": "var_8", "type": "int32_t", "source_type": "StackVariableSourceType", "storage": -8}])
        self.assertEqual(
            [(e["category"], e["target"]) for e in main["outgoing_references"]],
            [("call", "0x2000"), ("data", "0x3000")],
        )
        self.assertEqual(main["outgoing_references"][0]["target_function"]["address"], "0x2000")
        self.assertIsNone(main["outgoing_references"][1]["target_function"])
        self.assertEqual(main["referenced_strings"][0]["source_address"], "0x1004")
        self.assertEqual(main["referenced_strings"][0]["value"], "hello")
        self.assertEqual(set(frames[3]["result"]), {"procedure"})
        self.assertEqual(frames[4]["error"]["code"], "function_not_found")
        self.assertEqual(frames[5]["error"]["code"], "invalid_request")

    def test_strings_xrefs_and_containment_use_canonical_addresses(self):
        _code, frames, _bn = run(
            [
                OPEN,
                {"id": 2, "op": "strings", "params": {"address": "0x3010"}},
                {"id": 3, "op": "xrefs", "params": {"address": "0x2000"}},
                {"id": 4, "op": "containing", "params": {"address": "0x1034"}},
                {"id": 5, "op": "containing", "params": {"address": "0x5000"}},
                {"id": 6, "op": "xrefs", "params": {"address": "2000"}},
            ]
        )
        self.assertEqual(frames[2]["result"], [{"address": "0x3010", "type": "Utf16String", "encoding": "utf-16", "byte_length": 4, "value": "wide"}])
        self.assertEqual(frames[3]["result"], {"address": "0x2000", "code": [{"address": "0x1004", "function": "0x1000"}], "data": []})
        self.assertEqual(frames[4]["result"]["functions"][0]["address"], "0x1000")
        self.assertEqual(frames[5]["result"], {"address": "0x5000", "in_segment": False, "functions": []})
        self.assertEqual(frames[6]["error"]["code"], "invalid_address")


if __name__ == "__main__":
    unittest.main()
