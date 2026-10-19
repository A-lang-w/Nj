import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";

import { streamChunkToBuffer } from "../../artifacts/StreamBytes.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { SafeOutputTreeCreationFailure } from "../../artifacts/SafeOutputTreeCreationFailure.js";
import { RegularFileChangedError } from "../../filesystem/RegularFile.js";
import { withRegularFile } from "../RegularFileRead.js";
import type { EnvironmentBundlePlan } from "./environmentBundle.js";
import type {
  EnvironmentExportInput,
  WrittenBundleFile,
} from "./environmentExport.js";

const writeBytes = async (
  tree: SafeOutputTree,
  relative: string,
  bytes: Buffer,
): Promise<WrittenBundleFile> => {
  const written = await tree.write(relative, Readable.from([bytes]), {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  return { path: written.relativePath, bytes: written.bytesWritten };
};

/** Hash and copy the same opened regular file without retaining a tarball-sized buffer. */
const writeTarball = (
  tree: SafeOutputTree,
  relative: string,
  source: string,
): Promise<WrittenBundleFile> =>
  withRegularFile(source, async (handle, state) => {
    const hash = createHash("sha256");
    let observed = 0;
    for await (const chunk of handle.createReadStream({
      start: 0,
      autoClose: false,
    })) {
      const bytes = streamChunkToBuffer(chunk);
      observed += bytes.length;
      if (observed > state.size) throw new RegularFileChangedError(source);
      hash.update(bytes);
    }
    if (observed !== state.size) throw new RegularFileChangedError(source);
    const written = await tree.write(
      relative,
      handle.createReadStream({ start: 0, autoClose: false }),
      { bytes: state.size, sha256: hash.digest("hex") },
    );
    return { path: written.relativePath, bytes: written.bytesWritten };
  });

/** The output owner anchors every create and verifies the complete tree before publication. */
export const writeEnvironmentBundle = async (
  input: EnvironmentExportInput,
  plan: EnvironmentBundlePlan,
): Promise<readonly WrittenBundleFile[]> => {
  const resources = new ArtifactResourceScope();
  let tree: SafeOutputTree | undefined;
  let outcome:
    | {
        readonly kind: "completed";
        readonly files: readonly WrittenBundleFile[];
      }
    | { readonly kind: "failed"; readonly cause: unknown };
  try {
    await mkdir(dirname(input.directory), { recursive: true, mode: 0o700 });
    try {
      tree = await SafeOutputTree.create(input.directory, process.platform, {
        acceptExistingEmpty: true,
      });
    } catch (cause: unknown) {
      if (cause instanceof SafeOutputTreeCreationFailure) tree = cause.tree;
      throw cause;
    }
    const written: WrittenBundleFile[] = [];
    for (const file of plan.files)
      written.push(
        await writeBytes(tree, file.path, Buffer.from(file.content)),
      );
    written.push(
      await writeBytes(tree, plan.copies.manifest, input.manifest.bytes),
    );
    written.push(
      await writeBytes(tree, plan.copies.evidence, input.evidence.bytes),
    );
    if (plan.copies.tarball !== null && plan.packageSource.kind === "tarball")
      written.push(
        await writeTarball(tree, plan.copies.tarball, plan.packageSource.path),
      );
    await tree.commit();
    outcome = { kind: "completed", files: written };
  } catch (cause: unknown) {
    outcome = { kind: "failed", cause };
  }
  const owner = tree;
  if (owner !== undefined) {
    const closed = await resources.release({
      kind: "lease",
      resource: input.directory,
      lease: { release: () => owner.closeHandles() },
    });
    if (closed.kind === "failed")
      throw resources.cleanupFailure(outcome, [closed]);
  }
  if (outcome.kind === "failed") throw outcome.cause;
  return outcome.files;
};
