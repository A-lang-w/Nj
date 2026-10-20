import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GHIDRA_BRIDGE_SOURCES } from "../src/ghidra/GhidraBridgeSources.ts";

const exec = promisify(execFile);
const packedHopperBridge = "package/bridge/hopper_bridge.py";
const packedCutterBridge = "package/bridge/cutter/rea_bridge.py";

/** Check shipped bridge files; real-provider lanes verify runtime behavior. */
export async function verifyPackedBridge({ tarball, packedFiles }) {
  for (const path of [
    packedHopperBridge,
    packedCutterBridge,
    ...Object.values(GHIDRA_BRIDGE_SOURCES).map(
      (name) => `package/bridge/ghidra/${name}`,
    ),
    "package/bridge/android/rea_asc.py",
  ]) {
    if (!packedFiles.includes(path)) throw new Error(`package omitted ${path}`);
  }
  // Read the packed source without extracting into the caller's leased root.
  await exec("python3", [
    "-c",
    [
      "import ast, sys, tarfile",
      "with tarfile.open(sys.argv[1]) as archive:",
      "    for name in sys.argv[2:]:",
      "        member = archive.getmember(name)",
      "        if not member.isfile():",
      "            raise ValueError(f'{member.name} is not a regular file')",
      "        with archive.extractfile(member) as source:",
      "            ast.parse(source.read().decode('utf-8'), filename=name)",
    ].join("\n"),
    tarball,
    packedHopperBridge,
    "package/bridge/android/rea_asc.py",
  ]);
}
