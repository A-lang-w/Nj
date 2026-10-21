import { describe, it, expect } from "vitest";
import {
  createSkill,
  getSkills,
  searchSkills,
  deleteSkill,
} from "../../src/services/skill-service.js";

// Runs against the isolated per-file database provisioned by
// tests/setup-env.ts (migrated schema, user 1 + workspace 1 seeded).

function unwrap<T, E>(
  result: { ok: boolean; value?: T; error?: E },
  what: string,
): T {
  expect(result.ok).toBe(true);
  if (!result.ok)
    throw new Error(`${what} failed: ${(result.error as Error)?.message}`);
  return result.value as T;
}

describe("skill-service", () => {
  it("creates a skill and returns it", async () => {
    const skill = unwrap(
      await createSkill(
        1,
        "Code Review",
        "Reviews code for issues",
        "Review the code carefully",
        ["code", "review"],
      ),
      "createSkill",
    );
    expect(skill).toBeDefined();
    expect(skill.name).toBe("Code Review");
  });

  it("lists skills", async () => {
    const skills = unwrap(await getSkills(), "getSkills");
    expect(skills.length).toBeGreaterThanOrEqual(1);
  });

  it("searches skills by name", async () => {
    const results = unwrap(await searchSkills("Code"), "searchSkills");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toContain("Code");
  });

  it("treats % as a literal in search", async () => {
    // Regression: the LIKE pattern must carry an explicit ESCAPE clause,
    // or backslash-escaped wildcards match a literal backslash instead.
    const name = `100% coverage ${Date.now()}`;
    unwrap(await createSkill(1, name, "pct", "instructions"), "createSkill");
    const results = unwrap(await searchSkills("100%"), "searchSkills");
    expect(results.some((r) => r.name === name)).toBe(true);
  });

  it("deletes a skill", async () => {
    // Unique name: guards against orphan rows from interrupted earlier runs.
    const uniq = `Temp Skill ${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const skill = unwrap(
      await createSkill(1, uniq, "To delete", "instructions"),
      "createSkill",
    );
    unwrap(await deleteSkill(skill.id, 1), "deleteSkill");
    const results = unwrap(await searchSkills(uniq), "searchSkills");
    expect(results.length).toBe(0);
  });
});
