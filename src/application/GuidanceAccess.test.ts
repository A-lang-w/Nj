import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { searchGuidanceOutputSchema } from "../contracts/guidanceContracts.js";
import { readSkillFile } from "./SetupSkill.js";
import {
  readGuidanceSection,
  readGuidanceSectionWithReader,
  searchGuidance,
  searchGuidanceWithReader,
} from "./GuidanceAccess.js";

const valueOf = async (request: ReturnType<typeof searchGuidance>) => {
  const result = await request;
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return searchGuidanceOutputSchema.parse(result.value);
};

const packagedGuide = (path: string) =>
  readFile(
    new URL(`../../skills/reverse-engineer-anything/${path}`, import.meta.url),
    "utf8",
  );

it("finds and retrieves the exact JavaScript module guidance from packaged guides", async () => {
  const result = await valueOf(
    searchGuidance({ query: "exact JavaScript module" }),
  );
  expect(result).toMatchObject({
    status: "matches",
    source: "installed_rea_guidance",
    package: expect.stringMatching(/^rea-agents@/u),
  });
  if (result.status !== "matches") throw new Error("Expected guide matches");
  const match = result.matches.find(
    ({ heading }) => heading === "Read a module without repeating analysis",
  );
  expect(match).toBeDefined();
  expect(result.matches[0]?.heading).toBe(
    "Read a module without repeating analysis",
  );
  expect(match).toMatchObject({
    guide: "references/javascript-applications.md",
    matched_terms: expect.arrayContaining(["exact", "javascript", "module"]),
    context: expect.stringContaining("Read a module"),
  });
  expect(match?.context).toContain("javascript-module");
  const retrieved = await readGuidanceSection({ locator: match?.locator });
  expect(retrieved.ok).toBe(true);
  if (!retrieved.ok) throw retrieved.error;
  expect(retrieved.value).toMatchObject({
    status: "section",
    source: "installed_rea_guidance",
    guide: match?.guide,
    heading: match?.heading,
    locator: match?.locator,
    content: expect.stringContaining("node_id"),
  });
});

it("returns an honest no-match result and validates empty queries and result bounds", async () => {
  expect(
    await valueOf(searchGuidance({ query: "unlikely qzxv term" })),
  ).toMatchObject({
    status: "no_matches",
    total_matches: 0,
    message: expect.stringContaining("does not indicate"),
  });
  expect((await searchGuidance({ query: "  " })).ok).toBe(false);
  expect((await searchGuidance({ query: "x".repeat(2049) })).ok).toBe(false);
  expect((await searchGuidance({ query: "module", limit: 21 })).ok).toBe(false);
});

it("does not interpret Markdown headings inside fenced code as section boundaries", async () => {
  const result = await valueOf(
    searchGuidanceWithReader(
      { query: "phantom-heading-token" },
      async (path) => {
        const content = await packagedGuide(path);
        return path === "references/javascript-applications.md"
          ? `${content}\n\n\`\`\`markdown\n# phantom-heading-token\n\`\`\`\n`
          : content;
      },
    ),
  );
  expect(result.status).toBe("matches");
  if (result.status !== "matches") throw new Error("Expected text match");
  expect(result.matches.map(({ heading }) => heading)).not.toContain(
    "phantom-heading-token",
  );
});

it("refuses an oversized guidance bundle instead of indexing partial content", async () => {
  const result = await searchGuidanceWithReader(
    { query: "module" },
    async (path) =>
      path === "SKILL.md" ? "x".repeat(4_194_305) : packagedGuide(path),
  );
  expect(result).toMatchObject({
    ok: true,
    value: { status: "bundle_unavailable" },
  });
});

it("uses the managed-skill regular-file reader to reject symlinks and oversized files", async () => {
  const root = await createTestTempDirectory("rea-guidance-file-boundary-");
  const target = join(root, "guide.md");
  const link = join(root, "linked-guide.md");
  const oversized = join(root, "oversized-guide.md");
  await writeFile(target, "safe guide content");
  await symlink(target, link);
  await writeFile(oversized, "larger than limit");
  await expect(readSkillFile(link)).rejects.toThrow();
  await expect(readSkillFile(oversized, undefined, 4)).rejects.toThrow();
});

it("paginates deterministically without losing, duplicating, or reordering matches", async () => {
  const first = await valueOf(searchGuidance({ query: "module", limit: 2 }));
  const repeat = await valueOf(searchGuidance({ query: "module", limit: 2 }));
  expect(first).toEqual(repeat);
  if (first.status !== "matches") throw new Error("Expected guide matches");
  expect(first.has_more).toBe(true);
  const all: string[] = first.matches.map(({ locator }) => locator);
  let cursor = first.next_cursor;
  while (cursor !== undefined) {
    const page = await valueOf(
      searchGuidance({ query: "module", limit: 2, cursor }),
    );
    if (page.status !== "matches") throw new Error("Expected guide matches");
    all.push(...page.matches.map(({ locator }) => locator));
    cursor = page.next_cursor;
  }
  expect(new Set(all).size).toBe(all.length);
  const complete = await valueOf(
    searchGuidance({ query: "module", limit: 20 }),
  );
  expect(complete.status).toBe("matches");
  if (complete.status !== "matches") throw new Error("Expected guide matches");
  expect(all).toEqual(complete.matches.map(({ locator }) => locator));
});

it("rejects malformed locators and reports changed or missing installed guides", async () => {
  expect(
    await readGuidanceSection({ locator: "../../outside.md" }),
  ).toMatchObject({
    ok: false,
  });
  const search = await valueOf(
    searchGuidance({ query: "exact JavaScript module" }),
  );
  if (search.status !== "matches") throw new Error("Expected guide matches");
  const changedReader = async (path: string) => {
    const content = await packagedGuide(path);
    return path === "references/javascript-applications.md"
      ? `${content}\nChanged after search.\n`
      : content;
  };
  const stale = await readGuidanceSectionWithReader(
    { locator: search.matches[0]?.locator },
    changedReader,
  );
  expect(stale).toMatchObject({ ok: true, value: { status: "stale_locator" } });
  const firstPage = await valueOf(
    searchGuidance({ query: "module", limit: 1 }),
  );
  if (firstPage.status !== "matches" || firstPage.next_cursor === undefined)
    throw new Error("Expected a continuation token");
  expect(
    await searchGuidanceWithReader(
      { query: "module", limit: 1, cursor: firstPage.next_cursor },
      changedReader,
    ),
  ).toMatchObject({ ok: true, value: { status: "stale_continuation" } });
  expect(
    await searchGuidance({
      query: "different query",
      cursor: firstPage.next_cursor,
    }),
  ).toMatchObject({ ok: false });
  expect(
    await searchGuidance({ query: "module", cursor: "garbage" }),
  ).toMatchObject({ ok: false });
  const missingReader = async (): Promise<string> => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  };
  expect(
    await searchGuidanceWithReader({ query: "module" }, missingReader),
  ).toMatchObject({
    ok: true,
    value: { status: "bundle_unavailable" },
  });
  expect(
    await readGuidanceSectionWithReader(
      { locator: search.matches[0]?.locator },
      missingReader,
    ),
  ).toMatchObject({
    ok: true,
    value: { status: "guidance_missing" },
  });
});

it("searches and reads without providers, targets, or external services", async () => {
  const found = await valueOf(
    searchGuidance({ query: "exact JavaScript module" }),
  );
  expect(found.status).toBe("matches");
});
