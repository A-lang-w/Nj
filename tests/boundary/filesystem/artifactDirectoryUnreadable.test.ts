import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { DirectoryArtifactReader } from "../../../src/artifacts/DirectoryArtifactReader.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { inventoryArtifact } from "../../fixtures/artifactInventory.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { analyzeJavaScriptApplication } from "../../support/javascriptApplicationScope.js";

// Permission bits do not restrict root or Windows; the denial needs an ordinary user.
const deniable = process.platform !== "win32" && process.getuid?.() !== 0;

it.runIf(deniable)(
  "keeps the readable entries of a directory with an unreadable subdirectory and file",
  async () => {
    const root = await createTestTempDirectory("rea-directory-unreadable-");
    await mkdir(join(root, "lib"));
    await mkdir(join(root, "secret"));
    await writeFile(join(root, "package.json"), '{"name":"fixture"}');
    await writeFile(join(root, "lib/a.js"), "module.exports = 1;\n");
    await writeFile(join(root, "lib/key.pem"), "not readable");
    await writeFile(join(root, "secret/key"), "not listed");
    await chmod(join(root, "lib/key.pem"), 0o000);
    await chmod(join(root, "secret"), 0o000);
    try {
      const inventory = await inventoryArtifact(root);
      const occurrence = (path: string) =>
        inventory.occurrences.find(({ logical_path }) => logical_path === path);

      expect(occurrence("lib/a.js")).toMatchObject({ hash_status: "verified" });
      expect(occurrence("package.json")).toMatchObject({
        hash_status: "verified",
      });
      expect(occurrence("lib/key.pem")).toMatchObject({
        artifact_id: null,
        hash_status: "unavailable",
        limitations: [expect.stringContaining("access denied")],
      });
      expect(occurrence("secret")).toMatchObject({ entry_kind: "directory" });
      expect(occurrence("secret/key")).toBeUndefined();
      expect(inventory.coverage.status).toBe("unknown");
      expect(inventory.limitations).toContain(
        'Artifact traversal omitted unreadable-directory at "secret".',
      );
    } finally {
      await chmod(join(root, "secret"), 0o700);
      await chmod(join(root, "lib/key.pem"), 0o600);
    }
  },
);

it.runIf(deniable)(
  "still fails when the root itself is unreadable",
  async () => {
    const parent = await createTestTempDirectory(
      "rea-directory-unreadable-root-",
    );
    const root = join(parent, "app");
    await mkdir(root);
    await writeFile(join(root, "a.js"), "1;\n");
    await chmod(root, 0o000);
    try {
      await expect(inventoryArtifact(root)).rejects.toThrow();
    } finally {
      await chmod(root, 0o700);
    }
  },
);

it.runIf(deniable)(
  "keeps failing on an unreadable subdirectory unless the caller opts in",
  async () => {
    const root = await createTestTempDirectory(
      "rea-directory-unreadable-default-",
    );
    await mkdir(join(root, "secret"));
    await writeFile(join(root, "a.js"), "1;\n");
    await chmod(join(root, "secret"), 0o000);
    const reader = new DirectoryArtifactReader(root);
    try {
      const listed: string[] = [];
      await expect(
        (async () => {
          for await (const entry of reader.entries()) listed.push(entry.path);
        })(),
      ).rejects.toMatchObject({ reason: "io" });
      const omitted: string[] = [];
      for await (const entry of reader.entries(undefined, {
        omitUnreadableDirectories: true,
        onOmission: ({ path, kind }) => omitted.push(`${kind}:${path}`),
      }))
        listed.push(entry.path);
      expect(omitted).toEqual(["unreadable-directory:secret"]);
    } finally {
      await reader.close();
      await chmod(join(root, "secret"), 0o700);
    }
  },
);

it.runIf(deniable)(
  "analyzes an application with an unreadable subdirectory as partial",
  async () => {
    const root = await createTestTempDirectory("rea-directory-unreadable-app-");
    await mkdir(join(root, "lib"));
    await mkdir(join(root, "secret"));
    await writeFile(
      join(root, "package.json"),
      '{"name":"fixture","main":"lib/a.js"}',
    );
    await writeFile(join(root, "lib/a.js"), "module.exports = 1;\n");
    await writeFile(join(root, "secret/b.js"), "module.exports = 2;\n");
    await chmod(join(root, "secret"), 0o000);
    try {
      const result = await analyzeJavaScriptApplication({
        input_path: root,
        format: "directory",
      });
      if (!result.ok)
        throw new Error(`Expected analysis success: ${result.error.message}`);
      const { graph } = javascriptApplicationAnalysisResultSchema.parse(
        result.value.normalized_result,
      );
      expect(graph.coverage.status).toBe("partial");
      expect(graph.limitations).toContain(
        'Artifact traversal omitted unreadable-directory at "secret".',
      );
      expect(JSON.stringify(graph.nodes)).toContain("lib/a.js");
      expect(JSON.stringify(graph.nodes)).not.toContain("secret/b.js");
    } finally {
      await chmod(join(root, "secret"), 0o700);
    }
  },
);
