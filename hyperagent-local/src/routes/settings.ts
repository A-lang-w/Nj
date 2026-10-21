import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { users } from "../db/schema.js";
import { authMiddleware } from "../auth/middleware.js";
import { readJsonBody } from "../lib/json-body.js";
import { validateBoundedObject } from "../lib/bounded-object.js";

export const settingsRouter = new Hono();

settingsRouter.use("/*", authMiddleware);

settingsRouter.get("/user", async (c) => {
  const auth = c.get("auth");
  const [user] = await db.select().from(users).where(eq(users.id, auth.userId));
  if (!user) return c.json({ error: "User not found" }, 404);
  return c.json(user);
});

settingsRouter.put("/user", async (c) => {
  const auth = c.get("auth");
  const parsed = await readJsonBody(c);
  if (!parsed.ok) return c.json({ error: parsed.error.message }, 400);
  const body = parsed.value;
  // Stored settings are read back as opaque JSON; accept only plain
  // objects with bounded depth and key count so deeply nested payloads
  // cannot inflate storage or parsing cost.
  if (body.settings !== undefined) {
    const check = validateBoundedObject(body.settings, "settings", 5, 200);
    if (!check.ok) return c.json({ error: check.error }, 400);
  }
  // displayName is optional, but when present it must be a string.
  // Absent keys are omitted from the patch so they leave the stored
  // values untouched instead of nulling them.
  if (body.displayName !== undefined && typeof body.displayName !== "string") {
    return c.json({ error: "displayName must be a string" }, 400);
  }
  const patch: {
    displayName?: string;
    settingsJson?: string;
    updatedAt: Date;
  } = {
    updatedAt: new Date(),
  };
  if (body.displayName !== undefined) patch.displayName = body.displayName;
  if (body.settings) patch.settingsJson = JSON.stringify(body.settings);
  const [updated] = await db
    .update(users)
    .set(patch)
    .where(eq(users.id, auth.userId))
    .returning();
  return c.json(updated);
});

settingsRouter.get("/status", async (c) => {
  return c.json({
    status: "active",
    features: {
      mcpServers: true,
      communitySkills: true,
      marketplace: true,
      integrations: true,
    },
  });
});

settingsRouter.post("/apple-account-recovery-notice", async (c) => {
  return c.json({ acknowledged: true });
});
