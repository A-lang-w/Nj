import { Hono } from "hono";
import { authMiddleware } from "../auth/middleware.js";
import { listOwnedWorkspaces } from "../services/workspace-service.js";

export const workspacesRouter = new Hono();

workspacesRouter.use("/*", authMiddleware);

// Discovery for the client's stored workspace id: the caller sees only
// workspaces they own, so this doubles as the ownership check the client
// needs to repair a stale id instead of 404ing every data page.
workspacesRouter.get("/", async (c) => {
  const auth = c.get("auth");
  const result = await listOwnedWorkspaces(auth.userId);
  if (!result.ok) return c.json({ error: result.error.message }, 500);
  return c.json(result.value);
});
