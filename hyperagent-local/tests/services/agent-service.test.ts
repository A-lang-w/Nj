import { describe, it, expect } from "vitest";
import {
  createAgent,
  getAgent,
  listAgents,
  updateAgent,
  deleteAgent,
} from "../../src/services/agent-service.js";

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

describe("agent-service", () => {
  it("creates an agent", async () => {
    const agent = unwrap(
      await createAgent({
        workspaceId: 1,
        name: "Test Agent",
        description: "A test agent",
        systemPrompt: "You are helpful.",
        model: "claude-opus-5-5",
      }),
      "createAgent",
    );
    expect(agent).toBeDefined();
    expect(agent.name).toBe("Test Agent");
    expect(agent.id).toBeGreaterThan(0);
  });

  it("lists agents for workspace", async () => {
    const all = unwrap(await listAgents(1), "listAgents");
    expect(all.length).toBeGreaterThanOrEqual(1);
  });

  it("updates an agent", async () => {
    const created = unwrap(
      await createAgent({
        workspaceId: 1,
        name: "Update Me",
        systemPrompt: "prompt",
      }),
      "createAgent",
    );
    const updated = unwrap(
      await updateAgent(created.id, { name: "Updated Name" }),
      "updateAgent",
    );
    expect(updated?.name).toBe("Updated Name");
  });

  it("deletes an agent", async () => {
    const created = unwrap(
      await createAgent({
        workspaceId: 1,
        name: "Delete Me",
        systemPrompt: "prompt",
      }),
      "createAgent",
    );
    unwrap(await deleteAgent(created.id), "deleteAgent");
    const found = unwrap(await getAgent(created.id), "getAgent");
    expect(found).toBeUndefined();
  });
});
