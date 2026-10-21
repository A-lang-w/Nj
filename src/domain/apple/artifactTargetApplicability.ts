import { isMachOFormat, type BinaryTarget } from "../binaryTargetTypes.js";

/** Target-class prerequisites shared by artifact execution and session discovery. */
export const artifactTargetRefusal = (
  operation: string,
  target: BinaryTarget,
): string | undefined => {
  const bundle =
    target.kind === "executable" &&
    target.sourcePath?.toLowerCase().endsWith(".app") === true;
  switch (operation) {
    case "decode_interface_builder":
    case "inspect_asset_catalog":
      return bundle
        ? undefined
        : `${operation} requires an active .app bundle target`;
    case "inspect_keyed_archive":
      return bundle || (target.kind === "artifact" && target.format === "plist")
        ? undefined
        : "inspect_keyed_archive requires an active plist or .app bundle";
    case "trace_dylib_resolution":
      return target.kind === "executable" && isMachOFormat(target.format)
        ? undefined
        : "trace_dylib_resolution requires an active Mach-O or .app bundle target";
    default:
      return undefined;
  }
};
