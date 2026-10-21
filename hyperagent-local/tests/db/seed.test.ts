import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/connection.js";
import { agents, memories, users, workspaces } from "../../src/db/schema.js";
import { seed } from "../../src/db/seed.js";

describe("seed idempotency", () => {
  it("preserves user data across re-runs", async () => {
    await seed();

    // Seed creates its own user/workspace alongside the setup-env fixtures.
    const [seedWorkspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.name, "Personal"));
    expect(seedWorkspace).toBeDefined();
    const workspaceId = seedWorkspace.id;

    const [agentCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId));
    const [memoryCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(memories)
      .where(eq(memories.workspaceId, workspaceId));
    expect(agentCount.count).toBeGreaterThan(0);
    expect(memoryCount.count).toBeGreaterThan(0);

    // User-created rows added after seeding.
    await db.insert(agents).values({
      workspaceId,
      name: "User Agent",
      systemPrompt: "prompt",
      model: "test",
    });
    await db.insert(memories).values({
      workspaceId,
      content: "user-memory-must-survive",
      tagsJson: [],
    });

    await seed();

    const [agentCount2] = await db
      .select({ count: sql<number>`count(*)` })
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId));
    const [memoryCount2] = await db
      .select({ count: sql<number>`count(*)` })
      .from(memories)
      .where(eq(memories.workspaceId, workspaceId));
    // Exactly one user row added each; no duplicates, no wipes.
    expect(agentCount2.count).toBe(agentCount.count + 1);
    expect(memoryCount2.count).toBe(memoryCount.count + 1);

    const survivors = await db
      .select()
      .from(memories)
      .where(eq(memories.content, "user-memory-must-survive"));
    expect(survivors).toHaveLength(1);
  });

  it("reseeds into the existing local-user workspace when its id is not 1", async () => {
    // Fixture user 1 (test@test.com) is taken, so the seeded local user lands
    // on a higher id; a reseed must resolve it by email, never assume id 1.
    const [localUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, "local@hyperagent.local"));
    expect(localUser).toBeDefined();
    expect(localUser.id).not.toBe(1);

    await seed();

    // A hardcoded id-1 fallback would seed rows into the fixture workspace.
    const [fixtureAgents] = await db
      .select({ count: sql<number>`count(*)` })
      .from(agents)
      .where(eq(agents.workspaceId, 1));
    const [fixtureMemories] = await db
      .select({ count: sql<number>`count(*)` })
      .from(memories)
      .where(eq(memories.workspaceId, 1));
    expect(fixtureAgents.count).toBe(0);
    expect(fixtureMemories.count).toBe(0);

    const personals = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.name, "Personal"));
    expect(personals).toHaveLength(1);
    expect(personals[0].ownerId).toBe(localUser.id);
  });
});
