import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { withArtifactFileHandle } from "../artifacts/ArtifactFileOperation.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { AnalysisUnsupportedTargetError } from "../domain/analysisErrorCore.js";
import {
  isWasmComponent,
  readWasmPreamble,
} from "../domain/wasm/wasmPreamble.js";
import { wabtFailure } from "./WabtFailures.js";

/** WABT decodes core modules only; components route to their own decoder. */
export const wasmComponentSelected = (
  path: string,
): AnalysisUnsupportedTargetError =>
  new AnalysisUnsupportedTargetError(
    "inspect_wasm_artifact",
    path,
    "WebAssembly component (layer 1), not a core module; WABT decodes core modules only",
    {
      remediationAction:
        "Decode WebAssembly components with inspect_wasm_component.",
    },
  );

const probeHeader = async (file: FileHandle): Promise<boolean> => {
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    return isWasmComponent(readWasmPreamble(header.subarray(0, bytesRead)));
  } catch (cause: unknown) {
    // Unreadable content is left to the authoritative stable read.
    void cause;
    return false;
  }
};

/**
 * Reject a component before any WABT configuration or command. An unreadable
 * path is left to the stable read, which reports it after tool checks. The
 * probe descriptor is owned like every stable read, so a failed close stays
 * retained by `scope` and its error resolves once a later close succeeds.
 */
export const rejectWasmComponent = async (
  path: string,
  scope: ArtifactResourceScope,
): Promise<void> => {
  let file: FileHandle;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (cause: unknown) {
    // The authoritative stable read classifies inaccessible selections.
    void cause;
    return;
  }
  let component: boolean;
  try {
    component = await withArtifactFileHandle(
      path,
      file,
      scope,
      undefined,
      probeHeader,
    );
  } catch (cause: unknown) {
    throw wabtFailure(cause, "artifact", path);
  }
  if (component) throw wasmComponentSelected(path);
};
