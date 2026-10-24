# Binary Ninja headless provider

REA can run [Binary Ninja](https://binary.ninja) as an owned headless analysis engine. The `binary-ninja-headless` provider starts a Python interpreter that imports the Binary Ninja API, loads the admitted file read-only, waits for default auto-analysis, and serves REA's native analysis operations from that BinaryView. No GUI, no MCP server and no Binary Ninja database are involved; the view is released when the REA session closes.

This provider is distinct from the proposed GUI MCP adapter that attaches to a file already open in the Binary Ninja GUI. Choose the headless provider when analysis should be reproducible from the file alone and nobody needs to keep a GUI open; choose a GUI adapter when the analyst's live annotations matter.

## Prerequisites

- **Binary Ninja 6.0 or later** installed locally. REA does not install, update or license it. The adapter was developed against 6.0.10905; the bridge uses the public Python API (`binaryninja.load`, `LinearViewObject.single_function_language_representation`, references, strings and function APIs), which earlier releases may not provide identically.
- **A license that permits headless use.** Vector35's purchase page lists headless processing for the Commercial and Ultimate editions and for headless licenses; the Non-Commercial edition is documented as GUI-plugin only. REA neither checks nor changes licensing: an engine that refuses to load headlessly fails closed with its own error, reported in the provider diagnostics. The initial Windows verification below used a license whose product type the engine reports as `User`; check your own edition's terms before relying on this provider.
- **A Python 3 interpreter** that can load the installed API. On Windows, REA uses the interpreter bundled with Binary Ninja (`plugins\python\python.exe`) when `REA_BINARY_NINJA_PYTHON` is unset. Other hosts must name an interpreter. Vector35's `install_api.py` step is not required: REA passes the installation's `python` directory to the bridge, which adds it to `sys.path`.

## Configuration

| Setting                               | Meaning                                                                                                                                                                                                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BINARY_NINJA_INSTALL_DIR`            | Absolute installation directory that contains `python/binaryninja/__init__.py`. When unset, REA probes the vendor default only: `C:\Program Files\Vector35\BinaryNinja` on Windows and `/Applications/Binary Ninja.app/Contents/Resources` on macOS. Linux hosts must set it. |
| `REA_BINARY_NINJA_PYTHON`             | Absolute path of the Python 3 interpreter that runs the bridge. Required unless the Windows bundled interpreter exists. REA never searches `PATH`.                                                                                                                            |
| `REA_BINARY_NINJA_STARTUP_TIMEOUT_MS` | Absolute deadline for interpreter start, API import, target load and auto-analysis together. Decimal integer from 1 to 2,147,483,647; the default is 180,000 ms.                                                                                                              |

Discovery reads only the filesystem; `rea doctor`, `binary_session` and provider selection start no interpreter. `not_configured` means no installation was selected or found, `runtime_missing` that the directory exists without the Python API package, and `executable_missing` that no interpreter is available.

```bash
export BINARY_NINJA_INSTALL_DIR=/opt/binaryninja
export REA_BINARY_NINJA_PYTHON=/usr/bin/python3
export REA_ANALYSIS_PROVIDER=binary-ninja-headless
rea function /absolute/path/to/program main --json
rea decompile /absolute/path/to/program 0x401000 --json
```

On Windows PowerShell the vendor default installation needs no path settings:

```powershell
$env:REA_ANALYSIS_PROVIDER = 'binary-ninja-headless'
rea function 'C:\samples\program.exe' main --json
```

Select the provider once through `REA_ANALYSIS_PROVIDER`, the CLI's `--provider binary-ninja-headless`, or MCP's `open_binary.provider_id`. Without an installation the provider is unavailable and `auto` selection ignores it.

## What the owned interpreter does

REA starts the interpreter in isolated mode (`python -I -u bridge.py --api-dir <install>/python`) with `BN_DISABLE_USER_PLUGINS=1`, `BN_DISABLE_REPOSITORY_PLUGINS=1` and `BN_DISABLE_USER_SETTINGS=1`, so results depend on the installed engine and the file rather than on the local user's plugins or settings. Binary Ninja still maintains its own user directory, including its license and `lastrun` state, when it starts. REA owns the process through its usual Windows Job Object or POSIX process-group supervision and stops it on close, cancellation and failure.

The bridge then:

1. loads the file with `binaryninja.load(path, update_analysis=False)`;
2. hashes the Raw parent view in bounded reads and requires it to match the admitted SHA-256, and requires the resulting view type to match the admitted format (`PE`, `ELF` or `Mach-O`); a `Mapped` fallback view or different bytes fail closed before analysis;
3. runs `update_analysis_and_wait()` and reports the view, architecture, platform, entry point and inventory counts;
4. answers one request at a time over newline-delimited JSON on stdin/stdout, with Binary Ninja's own log redirected to stderr;
5. closes the view on REA's close request and exits.

A cancelled request, an elapsed startup deadline or a protocol fault stops the interpreter; the next request starts a fresh load and analysis. Startup failures are never cached, so correcting a setting and retrying in the same session works.

## Target admission

REA admits PE, ELF and thin Mach-O executables whose detected architecture is x86, x86_64, arm, arm64, mips, powerpc or riscv. Universal Mach-O containers are refused because the whole-file digest cannot bind a slice; extract the slice with `lipo -thin`. Managed .NET PE images belong to REA's managed-code tools. Raw binaries, DOS images and GameCube DOL files need a provider with an explicit load profile such as Ghidra. Archives and analysis databases are not loaded.

## Coverage and evidence

| REA operations                                     | Binary Ninja source                                                       | Coverage boundary                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `list_procedures`, `search_procedures`             | `BinaryView.functions`                                                    | Every analyzed function with symbol type, auto flag, thunk flag and complete inclusive body ranges.           |
| `list_strings`, `search_strings`                   | `BinaryView.strings`                                                      | Detected string references with Binary Ninja's string type and byte length; undefined literals may be absent. |
| `procedure_address`                                | Exact match on short, full or raw symbol names, or the `0x` entry address | No expression evaluation; an ambiguous name fails with its candidate entries.                                 |
| `procedure_pseudo_code`                            | `LinearViewObject.single_function_language_representation` (Pseudo C)     | Binary Ninja's Pseudo C, not recovered source.                                                                |
| `procedure_assembly`, `read_function_instructions` | `Function.instructions`                                                   | Address-ordered disassembly without variable annotations.                                                     |
| `procedure_callers`                                | `Function.caller_sites`                                                   | Functions containing resolved direct call sites; coverage stays `unknown`.                                    |
| `procedure_callees`                                | `Function.call_sites` and `BinaryView.get_callees`                        | Resolved targets, including import slots named by their symbol; unresolved sites make coverage `partial`.     |
| `xrefs`                                            | `get_code_refs` and `get_data_refs` to the exact address                  | Code and data references; unresolved indirect flow stays unknown.                                             |
| `resolve_containing_procedure`                     | `get_functions_containing` and `get_segment_at`                           | Distinguishes outside segments from not in a function; overlapping functions resolve to the lowest entry.     |
| `analyze_function`                                 | All of the above plus basic blocks, variables and comments                | Shared REA dossier; incoming references are observed at the entry and basic-block starts.                     |
| `list_documents`                                   | The admitted target                                                       | One document per session.                                                                                     |

The dossier's reference edges carry Binary Ninja's code, call or data category in their unavailable-kind reason; typed reference flags such as read or write are not exposed. Local variables come from `Function.vars` with their stack displacement when stack-based. Symbols report `source` as `user_defined` for non-auto symbols, `imported` for import symbols, `default` for auto `sub_...` names and `analysis` otherwise. Segments are not listed yet: REA's segment contract admits only Hopper and Ghidra provenance, and extending it is a maintainer decision; `binary_overview` therefore reports procedure and string counts without segments.

Results are live observations with `cachePolicy: live`; they are never replayed from analysis snapshots because the analysis profile commits the installation, not the engine version. Each observation's raw result records the observed core version, build id, product type and interpreter version. `provider.version` identifies the REA adapter.

## Verification

Adapter tests replace the Python interpreter with a Node fixture that speaks the same protocol (`tests/fixtures/fakeBinaryNinjaBridge.mjs`). They cover the isolated launch contract, inventory and function projections against the shared dossier and instruction-window schemas, caller-mistake attribution, startup failure attribution (import failure, digest and view-type mismatch, early exit), the startup deadline, cancellation during load, protocol faults, reply-size bounds and idempotent close. `bridge/binaryninja/test_rea_binaryninja_bridge.py` exercises the bridge's framing, digest check, facet selection and projections against a fake `binaryninja` module. Neither establishes real engine behavior.

Real-engine verification so far is manual and limited to one host. On Windows 11 x64 with Binary Ninja 6.0.10905 and the shipped `where.exe`, the production CLI's `decompile`, `function`, `analyze`, `search` and `trace` commands returned results that parsed against the built Evidence schemas and tool output contracts; see the [testing guide](testing.md#binary-ninja-headless-lane) for the recorded run, its timings and what remains unverified, including MCP parity, other hosts, ELF and Mach-O targets, and other Binary Ninja releases or license editions.

## Known limitations and next steps

- `list_segments`, `list_names`, `procedure_references`, `read_bytes` and `procedure_info` are not served yet. Segments need a contract decision on provenance; the others are straightforward bridge additions.
- The analysis profile does not commit the Binary Ninja version, so results stay live. A cheap version probe at profile resolution would allow snapshot replay.
- Cancellation stops the owned interpreter and loses its analysis; a long auto-analysis is repeated by the next request.
- `rea doctor` does not report this provider yet.
- Universal Mach-O slices, raw binaries and non-default load options such as a forced platform are not admitted.
