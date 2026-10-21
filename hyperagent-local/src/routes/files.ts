import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { files, threads } from "../db/schema.js";
import { authMiddleware } from "../auth/middleware.js";
import {
  authorizeResourceOwnership,
  resolveAuthorizedWorkspaceId,
  resolveRequestWorkspaceId,
} from "../auth/workspace.js";
import {
  saveFile,
  getFiles,
  deleteFile,
  MAX_UPLOAD_BYTES,
} from "../services/file-service.js";
import { MAX_PAGINATION_OFFSET } from "../config/constants.js";
import { clampPagination } from "../lib/pagination.js";

export const filesRouter = new Hono();

filesRouter.use("/*", authMiddleware);
// Cap the raw request body before formData() buffers it — covers chunked
// uploads that omit Content-Length as well as oversized declared lengths.
filesRouter.use(
  "/",
  bodyLimit({
    maxSize: MAX_UPLOAD_BYTES + 1024 * 1024,
    onError: (c) =>
      c.json(
        {
          error: `File exceeds maximum allowed size of ${MAX_UPLOAD_BYTES} bytes`,
        },
        413,
      ),
  }),
);

type UploadThreadCheck =
  | { valid: true; threadId: number | null }
  | { valid: false };

/**
 * Validates the optional upload `threadId` form field: absent means an
 * unattached file; present must name a thread in the upload workspace.
 * A garbage id matches nothing (404 here, not a 500 from the insert),
 * and a thread from another workspace must not gain a foreign file in
 * its attachment list (SEC-IDOR).
 */
async function checkUploadThread(
  c: Context,
  threadIdParam: unknown,
  authWorkspaceId: number,
): Promise<UploadThreadCheck> {
  if (typeof threadIdParam !== "string" || !threadIdParam) {
    return { valid: true, threadId: null };
  }
  const threadId = Number(threadIdParam);
  const threadWorkspaceId = await authorizeResourceOwnership(
    threads,
    threads.id,
    threads.workspaceId,
    threadId,
    c,
  );
  if (threadWorkspaceId === null || threadWorkspaceId !== authWorkspaceId) {
    return { valid: false };
  }
  return { valid: true, threadId };
}

filesRouter.get("/", async (c) => {
  // SEC-IDOR: Scope to a workspace the caller owns.
  const authWorkspaceId = await resolveRequestWorkspaceId(
    c,
    c.req.query("workspaceId"),
  );
  if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);
  const threadId = c.req.query("threadId")
    ? Number(c.req.query("threadId"))
    : undefined;
  const limit = clampPagination(c.req.query("limit"), 50, 200);
  const offset = clampPagination(
    c.req.query("offset"),
    0,
    MAX_PAGINATION_OFFSET,
  );

  return c.json(await getFiles(authWorkspaceId, threadId, limit, offset));
});

filesRouter.post("/", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return c.json({ error: "Expected multipart/form-data content type" }, 400);
  }

  // Pre-flight guard when Content-Length is present: formData() buffers in
  // memory, so reject absurd declared sizes before parsing. Many FormData
  // clients omit Content-Length (chunked); saveFile's stream counter still
  // enforces MAX_UPLOAD_BYTES on the file bytes themselves.
  const rawContentLength = c.req.header("content-length");
  if (rawContentLength != null && rawContentLength !== "") {
    const contentLength = Number(rawContentLength);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      return c.json({ error: "Invalid Content-Length header" }, 400);
    }
    if (contentLength > MAX_UPLOAD_BYTES + 1024 * 1024) {
      return c.json(
        {
          error: `File exceeds maximum allowed size of ${MAX_UPLOAD_BYTES} bytes`,
        },
        413,
      );
    }
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "Failed to parse multipart body" }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json(
      { error: "Failed to parse multipart body or no file field found" },
      400,
    );
  }

  // SEC-IDOR: Refuse uploads into workspaces the caller does not own.
  const authWorkspaceId = await resolveRequestWorkspaceId(
    c,
    form.get("workspaceId")?.toString() ?? null,
  );
  if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);
  const threadCheck = await checkUploadThread(
    c,
    form.get("threadId"),
    authWorkspaceId,
  );
  if (!threadCheck.valid) return c.json({ error: "Not found" }, 404);
  const threadId = threadCheck.threadId;
  const auth = c.get("auth");

  const saved = await saveFile(
    authWorkspaceId,
    file.name,
    file.type || "application/octet-stream",
    file.stream(),
    auth.userId,
    threadId,
    file.size || undefined,
  );
  if (!saved.ok) {
    const status =
      saved.error.tag === "ValidationError"
        ? 400
        : saved.error.tag === "CapacityError"
          ? 413
          : saved.error.tag === "StorageError"
            ? 500
            : 500;
    return c.json({ error: saved.error.message ?? saved.error.tag }, status);
  }
  return c.json(saved.value, 201);
});

filesRouter.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  // SEC-IDOR: Verify caller owns the workspace this file belongs to before deleting.
  const [candidate] = await db
    .select({ workspaceId: files.workspaceId })
    .from(files)
    .where(eq(files.id, id))
    .limit(1);
  const authWorkspaceId = await resolveAuthorizedWorkspaceId(
    c,
    candidate?.workspaceId,
  );
  if (authWorkspaceId == null) return c.json({ error: "Not found" }, 404);
  await deleteFile(id, authWorkspaceId);
  return c.json({ success: true });
});
