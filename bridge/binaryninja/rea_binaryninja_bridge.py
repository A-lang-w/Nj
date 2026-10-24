"""REA adapter executed by a headless Binary Ninja Python interpreter.

REA starts this script as an owned child process and speaks newline-delimited
JSON over stdin/stdout: one request object per line in, one reply object per
line out. Binary Ninja's own log output is redirected to stderr so stdout
carries protocol frames only. The process serves exactly one BinaryView, opened
read-only from the admitted file; it never creates or saves a database.

Set ``BN_DISABLE_USER_PLUGINS``, ``BN_DISABLE_REPOSITORY_PLUGINS`` and
``BN_DISABLE_USER_SETTINGS`` before starting the interpreter when analysis must
not depend on the local user's Binary Ninja customizations; REA does so.
"""

import hashlib
import json
import os
import re
import sys
import time
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

# Request line budget in bytes, excluding the trailing LF. REA sends compact
# selectors and addresses; a larger line is a protocol fault, not a request.
MAX_REQUEST_BYTES = 1024 * 1024
# Raw-view digest reads use bounded chunks so a large input never materializes.
DIGEST_CHUNK_BYTES = 1024 * 1024
PROVENANCE = "binaryninja-function"
DEFAULT_NAME_PATTERN = re.compile(r"sub_[0-9a-f]+")
HEX_ADDRESS_PATTERN = re.compile(r"0[xX][0-9a-fA-F]+")

# REA target formats admitted by this bridge and the BinaryView types that
# must load them. Anything else, including Binary Ninja's "Mapped" fallback
# for unrecognized bytes, is a mismatch.
VIEW_TYPES_BY_FORMAT = {
    "pe": ("PE",),
    "elf": ("ELF",),
    "mach-o": ("Mach-O",),
}

STRING_ENCODINGS = {
    "AsciiString": "ascii",
    "Utf8String": "utf-8",
    "Utf16String": "utf-16",
    "Utf32String": "utf-32",
}

FUNCTION_FACETS = (
    "pseudocode",
    "assembly",
    "callers",
    "callees",
    "references",
    "blocks",
    "locals",
    "comments",
    "strings_names",
)


class BridgeError(Exception):
    """An expected request failure reported to REA with a stable code."""

    def __init__(self, code: str, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


def hex_address(value: int) -> str:
    return "0x%x" % value


def parse_address(value: Any) -> int:
    if not isinstance(value, str) or HEX_ADDRESS_PATTERN.fullmatch(value) is None:
        raise BridgeError(
            "invalid_address",
            "Binary Ninja addresses must be 0x-prefixed hexadecimal strings",
            {"address": value if isinstance(value, str) else None},
        )
    return int(value, 16)


def merge_ranges(ranges: Iterable[Tuple[int, int]]) -> List[Tuple[int, int]]:
    """Return ordered, disjoint, maximal [start, end) ranges."""
    merged: List[Tuple[int, int]] = []
    for start, end in sorted(ranges):
        if end <= start:
            continue
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


class ProtocolWriter:
    """Own the original stdout for protocol frames; stray prints go to stderr."""

    def __init__(self) -> None:
        self._stream = os.fdopen(
            os.dup(sys.stdout.fileno()), "w", encoding="utf-8", newline="\n"
        )
        sys.stdout = sys.stderr

    def send(self, frame: Dict[str, Any]) -> None:
        self._stream.write(json.dumps(frame, ensure_ascii=True, separators=(",", ":")))
        self._stream.write("\n")
        self._stream.flush()


class Session:
    """One admitted BinaryView and the read-only observations REA requests."""

    def __init__(self, bn: Any) -> None:
        self.bn = bn
        self.view: Any = None
        self.path: Optional[str] = None
        self.opened_at: Optional[float] = None

    # -- lifecycle -----------------------------------------------------------

    def open(self, params: Dict[str, Any]) -> Dict[str, Any]:
        if self.view is not None:
            raise BridgeError("already_open", "This bridge already serves a BinaryView")
        path = params.get("path")
        expected_digest = params.get("sha256")
        target_format = params.get("format")
        if not isinstance(path, str) or not isinstance(expected_digest, str):
            raise BridgeError("invalid_request", "open requires path and sha256 strings")
        view_types = VIEW_TYPES_BY_FORMAT.get(target_format)
        if view_types is None:
            raise BridgeError(
                "unsupported_format",
                "This bridge admits pe, elf and mach-o targets",
                {"format": target_format},
            )
        started = time.monotonic()
        try:
            view = self.bn.load(path, update_analysis=False)
        except Exception as cause:  # Binary Ninja raises plain Exception
            raise BridgeError(
                "load_failed",
                "Binary Ninja could not create a BinaryView for the target: %s" % cause,
                {"path": path},
            )
        if view is None:
            raise BridgeError("load_failed", "Binary Ninja returned no BinaryView", {"path": path})
        try:
            self._verify_identity(view, expected_digest, view_types, target_format)
            view.update_analysis_and_wait()
        except Exception:
            view.file.close()
            raise
        self.view = view
        self.path = path
        self.opened_at = time.time()
        overview = self.overview()
        overview["load_and_analysis_ms"] = int((time.monotonic() - started) * 1000)
        return overview

    def _verify_identity(
        self, view: Any, expected_digest: str, view_types: Sequence[str], target_format: str
    ) -> None:
        raw = view.parent_view
        if raw is None or raw.view_type != "Raw":
            raise BridgeError(
                "identity_unavailable",
                "Binary Ninja exposed no Raw parent view for the loaded file",
            )
        digest = hashlib.sha256()
        offset = 0
        while offset < raw.length:
            chunk = raw.read(offset, min(DIGEST_CHUNK_BYTES, raw.length - offset))
            if not chunk:
                break
            digest.update(chunk)
            offset += len(chunk)
        observed = digest.hexdigest()
        if offset != raw.length or observed != expected_digest.lower():
            raise BridgeError(
                "digest_mismatch",
                "The bytes Binary Ninja loaded do not match the admitted target digest",
                {
                    "expected_sha256": expected_digest.lower(),
                    "observed_sha256": observed,
                    "raw_bytes": offset,
                },
            )
        if view.view_type not in view_types:
            raise BridgeError(
                "view_type_mismatch",
                "Binary Ninja loaded the file as %s; REA admitted it as %s"
                % (view.view_type, target_format),
                {"view_type": view.view_type, "format": target_format},
            )

    def close(self) -> Dict[str, Any]:
        if self.view is None:
            return {"closed": False}
        view = self.view
        self.view = None
        view.file.close()
        return {"closed": True}

    def require_view(self) -> Any:
        if self.view is None:
            raise BridgeError("not_open", "No BinaryView is open; send open first")
        return self.view

    # -- inventory -----------------------------------------------------------

    def overview(self) -> Dict[str, Any]:
        view = self.require_view()
        info = view.analysis_info
        return {
            "path": self.path,
            "view_type": view.view_type,
            "architecture": view.arch.name if view.arch is not None else None,
            "platform": view.platform.name if view.platform is not None else None,
            "entry_point": hex_address(view.entry_point),
            "start": hex_address(view.start),
            "end": hex_address(view.end),
            "length": view.length,
            "address_size": view.address_size,
            "endianness": _enum_name(view.endianness),
            "analysis_state": _analysis_state_name(self.bn, info.state),
            "function_count": len(view.functions),
            "string_count": len(view.strings),
            "segment_count": len(view.segments),
            "has_symbols": bool(view.has_symbols),
            "relocatable": bool(view.relocatable),
            "core_version": self.bn.core_version(),
        }

    def health(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "open": self.view is not None,
            "core_version": self.bn.core_version(),
        }
        if self.view is not None:
            result["analysis_state"] = _analysis_state_name(
                self.bn, self.view.analysis_info.state
            )
            result["path"] = self.path
        return result

    def functions(self) -> List[Dict[str, Any]]:
        view = self.require_view()
        items = []
        for function in sorted(view.functions, key=lambda f: f.start):
            items.append(self._identity(function))
        return items

    def strings(self, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        view = self.require_view()
        address = params.get("address")
        selected = None if address is None else parse_address(address)
        items = []
        for string in view.strings:
            if selected is not None and string.start != selected:
                continue
            items.append(self._string(string))
        items.sort(key=lambda item: int(item["address"], 16))
        return items

    def segments(self) -> List[Dict[str, Any]]:
        view = self.require_view()
        sections = sorted(view.sections.values(), key=lambda s: (s.start, s.end))
        items = []
        for segment in sorted(view.segments, key=lambda s: s.start):
            contained = [
                {
                    "name": section.name,
                    "start": hex_address(section.start),
                    "end": hex_address(section.end),
                    "semantics": _enum_name(section.semantics),
                }
                for section in sections
                if section.start >= segment.start and section.start < segment.end
            ]
            items.append(
                {
                    "start": hex_address(segment.start),
                    "end": hex_address(segment.end),
                    "readable": bool(segment.readable),
                    "writable": bool(segment.writable),
                    "executable": bool(segment.executable),
                    "data_length": segment.data_length,
                    "sections": contained,
                }
            )
        return items

    def xrefs(self, params: Dict[str, Any]) -> Dict[str, Any]:
        view = self.require_view()
        address = parse_address(params.get("address"))
        code = []
        for reference in view.get_code_refs(address):
            code.append(
                {
                    "address": hex_address(reference.address),
                    "function": None
                    if reference.function is None
                    else hex_address(reference.function.start),
                }
            )
        data = [hex_address(source) for source in view.get_data_refs(address)]
        code.sort(key=lambda item: int(item["address"], 16))
        data.sort(key=lambda item: int(item, 16))
        return {"address": hex_address(address), "code": code, "data": data}

    def containing(self, params: Dict[str, Any]) -> Dict[str, Any]:
        view = self.require_view()
        address = parse_address(params.get("address"))
        functions = sorted(view.get_functions_containing(address), key=lambda f: f.start)
        return {
            "address": hex_address(address),
            "in_segment": view.get_segment_at(address) is not None,
            "functions": [self._identity(function) for function in functions],
        }

    # -- functions -----------------------------------------------------------

    def function(self, params: Dict[str, Any]) -> Dict[str, Any]:
        view = self.require_view()
        function = self._resolve(params.get("procedure"))
        facets = params.get("facets", [])
        if not isinstance(facets, list) or any(f not in FUNCTION_FACETS for f in facets):
            raise BridgeError(
                "invalid_request",
                "function facets must name %s" % ", ".join(FUNCTION_FACETS),
            )
        wanted = set(facets)
        result: Dict[str, Any] = {"procedure": self._identity(function)}
        if "pseudocode" in wanted:
            # The rendered function header is the only complete signature text.
            lines, header = self._pseudocode(function)
            result["signature"] = header
            result["pseudocode"] = lines
        if "assembly" in wanted:
            result["assembly"] = self._assembly(function)
        if "callers" in wanted:
            result["callers"] = self._callers(function)
        if "callees" in wanted:
            result["callees"] = self._callees(function)
        if "blocks" in wanted:
            result["basic_blocks"] = self._blocks(function)
        if "locals" in wanted:
            result["locals"] = self._locals(function)
        if "comments" in wanted:
            result["comments"] = self._comments(function)
        if "references" in wanted or "strings_names" in wanted:
            incoming, outgoing = self._references(function)
            if "references" in wanted:
                result["incoming_references"] = incoming
                result["outgoing_references"] = outgoing
            if "strings_names" in wanted:
                strings, names = self._referenced_values(function, outgoing)
                result["referenced_strings"] = strings
                result["referenced_names"] = names
        return result

    def _resolve(self, selector: Any) -> Any:
        view = self.require_view()
        if not isinstance(selector, str) or selector == "":
            raise BridgeError("invalid_request", "procedure must be a name or 0x address")
        if HEX_ADDRESS_PATTERN.fullmatch(selector) is not None:
            address = int(selector, 16)
            function = view.get_function_at(address)
            if function is None:
                raise BridgeError(
                    "function_not_found",
                    "No Binary Ninja function starts at this address",
                    {"procedure": selector, "address": hex_address(address)},
                )
            return function
        matches = {}
        for function in view.functions:
            symbol = function.symbol
            names = {function.name}
            if symbol is not None:
                names.update({symbol.short_name, symbol.full_name, symbol.raw_name})
            if selector in names:
                matches[function.start] = function
        if len(matches) == 1:
            return next(iter(matches.values()))
        if not matches:
            raise BridgeError(
                "function_not_found",
                "No Binary Ninja function has this exact name",
                {"procedure": selector},
            )
        raise BridgeError(
            "function_ambiguous",
            "Several Binary Ninja functions share this name; select an entry address",
            {
                "procedure": selector,
                "candidates": [hex_address(start) for start in sorted(matches)],
            },
        )

    def _identity(self, function: Any) -> Dict[str, Any]:
        symbol = function.symbol
        ranges = merge_ranges((r.start, r.end) for r in function.address_ranges)
        total = sum(end - start for start, end in ranges)
        callee_addresses = list(function.callee_addresses) if function.is_thunk else []
        return {
            "address": hex_address(function.start),
            "name": function.name,
            "symbol": None if symbol is None else self._symbol(symbol),
            "thunk": bool(function.is_thunk),
            "thunk_target": hex_address(callee_addresses[0])
            if function.is_thunk and len(callee_addresses) == 1
            else None,
            "external": self._external(function),
            "body": {
                "ranges": [
                    {"start": hex_address(start), "end": hex_address(end - 1)}
                    for start, end in ranges
                ],
                "total_bytes": total,
                "span_bytes": (ranges[-1][1] - ranges[0][0]) if ranges else 0,
                "contains_entry": any(start <= function.start < end for start, end in ranges),
            },
        }

    def _symbol(self, symbol: Any) -> Dict[str, Any]:
        symbol_type = _enum_name(symbol.type)
        auto = bool(symbol.auto)
        if not auto:
            source = "user_defined"
        elif symbol_type in ("ImportedFunctionSymbol", "ImportAddressSymbol", "ImportedDataSymbol"):
            source = "imported"
        elif DEFAULT_NAME_PATTERN.fullmatch(symbol.short_name) is not None:
            source = "default"
        else:
            source = "analysis"
        return {
            "type": symbol_type,
            "auto": auto,
            "source": source,
            "external": symbol_type
            in ("ImportedFunctionSymbol", "ImportAddressSymbol", "ImportedDataSymbol", "ExternalSymbol"),
            "short_name": symbol.short_name,
            "full_name": symbol.full_name,
            "raw_name": symbol.raw_name,
        }

    def _external(self, function: Any) -> bool:
        symbol = function.symbol
        if symbol is not None and _enum_name(symbol.type) in (
            "ImportedFunctionSymbol",
            "ExternalSymbol",
        ):
            return True
        view = self.require_view()
        for section in view.get_sections_at(function.start):
            if _enum_name(section.semantics) == "ExternalSectionSemantics":
                return True
        return False

    def _pseudocode(self, function: Any) -> Tuple[List[str], Optional[str]]:
        bn = self.bn
        view = self.require_view()
        settings = bn.DisassemblySettings()
        settings.set_option(bn.enums.DisassemblyOption.ShowAddress, False)
        settings.set_option(bn.enums.DisassemblyOption.WaitForIL, True)
        linear = bn.LinearViewObject.single_function_language_representation(function, settings)
        header = None
        lines = []
        for line in _linear_lines(bn, view, linear):
            text = str(line)
            if _enum_name(line.type) == "FunctionHeaderLineType" and header is None:
                header = text.strip()
            lines.append(text.rstrip())
        while lines and lines[0] == "":
            lines.pop(0)
        while lines and lines[-1] == "":
            lines.pop()
        return lines, header

    def _assembly(self, function: Any) -> List[Dict[str, Any]]:
        instructions = []
        for tokens, address in function.instructions:
            instructions.append(
                {
                    "address": hex_address(address),
                    "text": "".join(str(token) for token in tokens).rstrip(),
                }
            )
        instructions.sort(key=lambda item: int(item["address"], 16))
        return instructions

    def _callers(self, function: Any) -> List[Dict[str, Any]]:
        callers = {}
        for site in function.caller_sites:
            caller = site.function
            if caller is None:
                continue
            entry = callers.setdefault(
                caller.start, {"procedure": self._identity(caller), "sites": []}
            )
            entry["sites"].append(hex_address(site.address))
        return [callers[start] for start in sorted(callers)]

    def _callees(self, function: Any) -> Dict[str, Any]:
        view = self.require_view()
        resolved = {}
        unresolved = []
        for site in function.call_sites:
            targets = view.get_callees(site.address)
            if not targets:
                unresolved.append(hex_address(site.address))
                continue
            for target in targets:
                entry = resolved.get(target)
                if entry is None:
                    entry = {"target": self._callee_target(target), "sites": []}
                    resolved[target] = entry
                entry["sites"].append(hex_address(site.address))
        return {
            "resolved": [resolved[target] for target in sorted(resolved)],
            "unresolved_sites": sorted(unresolved, key=lambda a: int(a, 16)),
        }

    def _callee_target(self, address: int) -> Dict[str, Any]:
        view = self.require_view()
        function = view.get_function_at(address)
        if function is not None:
            return {"kind": "function", "procedure": self._identity(function)}
        symbol = view.get_symbol_at(address)
        return {
            "kind": "symbol" if symbol is not None else "address",
            "address": hex_address(address),
            "name": None if symbol is None else symbol.short_name,
            "symbol": None if symbol is None else self._symbol(symbol),
        }

    def _blocks(self, function: Any) -> List[Dict[str, Any]]:
        blocks = []
        for block in sorted(function.basic_blocks, key=lambda b: b.start):
            blocks.append(
                {
                    "start": hex_address(block.start),
                    "end": hex_address(block.end - 1) if block.end > block.start else hex_address(block.start),
                    "successors": sorted(
                        {hex_address(edge.target.start) for edge in block.outgoing_edges if edge.target is not None},
                        key=lambda a: int(a, 16),
                    ),
                }
            )
        return blocks

    def _locals(self, function: Any) -> List[Dict[str, Any]]:
        variables = []
        for variable in function.vars:
            source = _enum_name(variable.source_type)
            variables.append(
                {
                    "name": variable.name,
                    "type": str(variable.type),
                    "source_type": source,
                    "storage": int(variable.storage),
                }
            )
        return variables

    def _comments(self, function: Any) -> List[Dict[str, Any]]:
        comments = []
        if function.comment:
            comments.append({"address": hex_address(function.start), "text": function.comment})
        for address, text in sorted(function.comments.items()):
            comments.append({"address": hex_address(address), "text": text})
        return comments

    def _references(self, function: Any) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """Observed edges at the entry, block starts and each instruction."""
        view = self.require_view()
        ranges = merge_ranges((r.start, r.end) for r in function.address_ranges)

        def inside(address: int) -> bool:
            return any(start <= address < end for start, end in ranges)

        this_identity = self._identity(function)
        identities: Dict[int, Optional[Dict[str, Any]]] = {}

        def containing(address: int) -> Optional[Dict[str, Any]]:
            """Lowest-entry function whose body contains the address, if any."""
            if address not in identities:
                owners = sorted(view.get_functions_containing(address), key=lambda f: f.start)
                identities[address] = self._identity(owners[0]) if owners else None
            return identities[address]

        incoming = {}
        targets = {function.start}
        targets.update(block.start for block in function.basic_blocks)
        for target in sorted(targets):
            for reference in view.get_code_refs(target):
                if inside(reference.address):
                    continue
                incoming[(reference.address, target)] = {
                    "source": hex_address(reference.address),
                    "target": hex_address(target),
                    "category": "code",
                    "source_function": self._identity(reference.function)
                    if reference.function is not None
                    else containing(reference.address),
                    "target_function": this_identity,
                }
            for source in view.get_data_refs(target):
                if inside(source):
                    continue
                incoming[(source, target)] = {
                    "source": hex_address(source),
                    "target": hex_address(target),
                    "category": "data",
                    "source_function": containing(source),
                    "target_function": this_identity,
                }
        call_sites = {site.address for site in function.call_sites}
        outgoing = {}
        for _tokens, address in function.instructions:
            for target in view.get_code_refs_from(address, function):
                if inside(target):
                    continue
                outgoing[(address, target)] = {
                    "source": hex_address(address),
                    "target": hex_address(target),
                    "category": "call" if address in call_sites else "code",
                    "source_function": this_identity,
                    "target_function": containing(target),
                }
            for target in view.get_data_refs_from(address):
                if inside(target):
                    continue
                outgoing[(address, target)] = {
                    "source": hex_address(address),
                    "target": hex_address(target),
                    "category": "data",
                    "source_function": this_identity,
                    "target_function": containing(target),
                }
        return (
            [incoming[key] for key in sorted(incoming)],
            [outgoing[key] for key in sorted(outgoing)],
        )

    def _referenced_values(
        self, function: Any, outgoing: List[Dict[str, Any]]
    ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        view = self.require_view()
        strings = []
        names = []
        for edge in outgoing:
            target = int(edge["target"], 16)
            string = view.get_string_at(target)
            if string is not None and string.start == target:
                item = self._string(string)
                item["source_address"] = edge["source"]
                strings.append(item)
                continue
            if view.get_function_at(target) is not None:
                continue
            symbol = view.get_symbol_at(target)
            if symbol is not None:
                names.append(
                    {
                        "address": hex_address(target),
                        "value": symbol.short_name,
                        "source_address": edge["source"],
                    }
                )
        return strings, names

    def _string(self, string: Any) -> Dict[str, Any]:
        view = self.require_view()
        string_type = _enum_name(string.type)
        item: Dict[str, Any] = {
            "address": hex_address(string.start),
            "type": string_type,
            "encoding": STRING_ENCODINGS.get(string_type),
            "byte_length": int(string.length),
        }
        try:
            item["value"] = string.value
        except Exception as cause:
            raw = view.read(string.start, string.length)
            item["value"] = raw.decode("latin-1", "replace")
            item["decoding_failure"] = str(cause)
        return item


def _enum_name(value: Any) -> str:
    name = getattr(value, "name", None)
    return name if isinstance(name, str) else str(value)


def _analysis_state_name(bn: Any, value: Any) -> str:
    """AnalysisInfo.state is a bare integer; name it through the API enum."""
    try:
        return _enum_name(bn.enums.AnalysisState(value))
    except (ValueError, AttributeError):
        return _enum_name(value)


def _linear_lines(bn: Any, view: Any, linear: Any) -> List[Any]:
    cursor = bn.LinearViewCursor(linear)
    cursor.seek_to_begin()
    lines: List[Any] = []
    while not cursor.after_end:
        chunk = view.get_next_linear_disassembly_lines(cursor)
        if not chunk:
            break
        lines.extend(chunk)
    return lines


def ready_frame(bn: Any, api_dir: str) -> Dict[str, Any]:
    return {
        "event": "ready",
        "core_version": bn.core_version(),
        "build_id": bn.core_build_id(),
        "product": bn.core_product(),
        "product_type": bn.core_product_type(),
        "license_count": bn.core_license_count(),
        "ui_enabled": bool(bn.core_ui_enabled()),
        "python_version": sys.version.split()[0],
        "api_dir": api_dir,
        "user_plugins_disabled": os.environ.get("BN_DISABLE_USER_PLUGINS") == "1",
        "user_settings_disabled": os.environ.get("BN_DISABLE_USER_SETTINGS") == "1",
        "pid": os.getpid(),
    }


def dispatch(session: Session, op: str, params: Dict[str, Any]) -> Any:
    if op == "open":
        return session.open(params)
    if op == "health":
        return session.health()
    if op == "overview":
        return session.overview()
    if op == "functions":
        return session.functions()
    if op == "function":
        return session.function(params)
    if op == "strings":
        return session.strings(params)
    if op == "segments":
        return session.segments()
    if op == "xrefs":
        return session.xrefs(params)
    if op == "containing":
        return session.containing(params)
    if op == "close":
        return session.close()
    raise BridgeError("unknown_operation", "Unknown bridge operation", {"op": op})


def serve(bn: Any, api_dir: str, stdin: Any, writer: ProtocolWriter) -> int:
    session = Session(bn)
    writer.send(ready_frame(bn, api_dir))
    for raw_line in stdin:
        line = raw_line.rstrip("\n").rstrip("\r")
        if line == "":
            continue
        if len(line.encode("utf-8")) > MAX_REQUEST_BYTES:
            writer.send(
                {
                    "id": None,
                    "ok": False,
                    "error": {"code": "invalid_request", "message": "request exceeds %d bytes" % MAX_REQUEST_BYTES},
                }
            )
            continue
        try:
            request = json.loads(line)
        except ValueError:
            writer.send(
                {
                    "id": None,
                    "ok": False,
                    "error": {"code": "invalid_request", "message": "request is not a JSON object"},
                }
            )
            continue
        request_id = request.get("id") if isinstance(request, dict) else None
        op = request.get("op") if isinstance(request, dict) else None
        params = request.get("params", {}) if isinstance(request, dict) else {}
        if not isinstance(op, str) or not isinstance(params, dict):
            writer.send(
                {
                    "id": request_id,
                    "ok": False,
                    "error": {"code": "invalid_request", "message": "request needs an op string and params object"},
                }
            )
            continue
        try:
            result = dispatch(session, op, params)
            writer.send({"id": request_id, "ok": True, "result": result})
        except BridgeError as failure:
            writer.send(
                {
                    "id": request_id,
                    "ok": False,
                    "error": {"code": failure.code, "message": str(failure), "details": failure.details},
                }
            )
        except Exception as cause:  # keep serving; REA attributes the failure
            writer.send(
                {
                    "id": request_id,
                    "ok": False,
                    "error": {
                        "code": "internal",
                        "message": "%s: %s" % (type(cause).__name__, cause),
                        "details": {"op": op},
                    },
                }
            )
        if op == "close":
            return 0
    session.close()
    return 0


def main(argv: Sequence[str]) -> int:
    if len(argv) != 3 or argv[1] != "--api-dir":
        sys.stderr.write("usage: rea_binaryninja_bridge.py --api-dir <binaryninja python directory>\n")
        return 2
    api_dir = argv[2]
    writer = ProtocolWriter()
    sys.path.insert(0, api_dir)
    try:
        import binaryninja as bn  # noqa: WPS433  (deferred: path injected above)
    except Exception as cause:
        writer.send(
            {
                "event": "fatal",
                "code": "import_failed",
                "message": "%s: %s" % (type(cause).__name__, cause),
                "api_dir": api_dir,
            }
        )
        return 3
    try:
        bn.disable_default_log()
        bn.log_to_stderr(bn.LogLevel.WarningLog)
    except Exception as cause:
        sys.stderr.write("REA bridge could not redirect Binary Ninja logging: %s\n" % cause)
    try:
        return serve(bn, api_dir, sys.stdin, writer)
    except BrokenPipeError:
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
