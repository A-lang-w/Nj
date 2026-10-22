import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { importReferenceSource } from "../../support/referenceSourceResourceScope.js";

const UNKNOWN_CASE =
  "Effective Git core.ignoreCase is unknown; project ignore matching used case-insensitive rules.";

const git = (root: string, args: readonly string[]) =>
  spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(root, ".git", "missing-global.config"),
      GIT_CONFIG_COUNT: "0",
    },
  });

const fixture = async (config: string) => {
  const root = await createTestTempDirectory("rea-reference-config-parsing-");
  const initialized = git(root, [
    "init",
    "--quiet",
    "--template=",
    "--initial-branch=main",
  ]);
  expect(initialized.status, initialized.stderr).toBe(0);
  for (const [path, content] of Object.entries({
    ".git/config": config,
    ".gitignore": "/generated/\n",
    "Generated/keep.ts": "export const rootSource = true;\n",
    "pkg/.gitignore": "generated/\n",
    "pkg/Generated/keep.ts": "export const nestedSource = true;\n",
    "visible.ts": "export const visible = true;\n",
  })) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
};

const readInventory = async (root: string) => {
  const result = await importReferenceSource({
    root,
    caller: "git-config-parsing-test",
    policy: { secretPatterns: [] },
  });
  if (!result.ok) throw result.error;
  return result.value;
};

describe.skipIf(process.platform === "win32")(
  "reference source Git config parsing",
  () => {
    it.each([
      {
        name: "empty assignment",
        config: "[core]\nignoreCase =\n",
        expected: false,
      },
      {
        name: "quoted empty assignment",
        config: '[core]\nignoreCase = ""\n',
        expected: false,
      },
      {
        name: "empty assignment with comment",
        config: "[core]\nignoreCase = # false\n",
        expected: false,
      },
      {
        name: "quoted empty assignment with comment",
        config: '[core]\nignoreCase = ""# false\n',
        expected: false,
      },
      { name: "bare variable", config: "[core]\nignoreCase\n", expected: true },
      {
        name: "file-leading BOM",
        config: "\uFEFF[core]\nignoreCase = false\n",
        expected: false,
      },
      {
        name: "BOM inside quoted value",
        config:
          '[core]\nignoreCase = false\n[user]\nname = "\uFEFFauthor\uFEFF"\n',
        expected: false,
      },
      {
        name: "BOM inside unquoted value",
        config:
          "[core]\nignoreCase = false\n[user]\nname = \uFEFFauthor\uFEFF\n",
        expected: false,
      },
      {
        name: "CRLF and ASCII whitespace",
        config: '[core]\r\n\tignoreCase \t=\t "" \t\r\n',
        expected: false,
      },
    ])("matches Git for $name", async ({ config, expected }) => {
      const root = await fixture(config);
      const configured = git(root, [
        "config",
        "--bool",
        "--get",
        "core.ignoreCase",
      ]);
      expect(configured.status, configured.stderr).toBe(0);
      expect(configured.stdout.trim()).toBe(String(expected));
      const traversed = git(root, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ]);
      expect(traversed.status, traversed.stderr).toBe(0);
      const files = traversed.stdout.split("\0").filter(Boolean).sort();
      expect(files.includes("Generated/keep.ts")).toBe(!expected);
      expect(files.includes("pkg/Generated/keep.ts")).toBe(!expected);

      const graph = await readInventory(root);
      expect(graph.limitations).not.toContain(UNKNOWN_CASE);
      expect(
        graph.entries
          .filter(({ kind }) => kind === "file")
          .map(({ path }) => path)
          .sort(),
      ).toEqual(files);
    });

    it.each([
      { name: "later variable", config: "[core]\n\uFEFFignoreCase = false\n" },
      {
        name: "later section",
        config: '[core]\nignoreCase = false\n\uFEFF[user]\nname = "author"\n',
      },
      {
        name: "assignment separator",
        config: "[core]\nignoreCase\uFEFF = false\n",
      },
      {
        name: "section terminator",
        config: "[core\uFEFF]\nignoreCase = false\n",
      },
      {
        name: "unquoted boolean suffix",
        config: "[core]\nignoreCase = false\uFEFF\n",
      },
      {
        name: "quoted boolean suffix",
        config: '[core]\nignoreCase = "false"\uFEFF # comment\n',
      },
    ])("retains uncertainty for a BOM at the $name", async ({ config }) => {
      const root = await fixture(config);
      const configured = git(root, [
        "config",
        "--bool",
        "--get",
        "core.ignoreCase",
      ]);
      expect(configured.status).toBe(128);
      const traversed = git(root, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ]);
      expect(traversed.status).toBe(128);

      const graph = await readInventory(root);
      expect(graph.limitations).toContain(UNKNOWN_CASE);
      expect(graph.entries.map(({ path }) => path)).toContain("visible.ts");
      for (const path of ["Generated", "pkg/Generated"])
        expect(graph.exclusions).toContainEqual(
          expect.objectContaining({
            path,
            reason: "project-ignored",
            pattern: path.startsWith("pkg/") ? "generated/" : "/generated/",
            policy_path: path.startsWith("pkg/")
              ? "pkg/.gitignore"
              : ".gitignore",
          }),
        );
    });
  },
);
