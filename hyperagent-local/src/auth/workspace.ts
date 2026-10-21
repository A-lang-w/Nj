import {
  asc,
  eq,
  getTableName,
  type AnyColumn,
  type Column,
  type Table,
} from "drizzle-orm";
import type { Context } from "hono";
import { db } from "../db/connection.js";
import { workspaces } from "../db/schema.js";
import { ensurePersonalWorkspace } from "../services/workspace-service.js";

/**
 * Resolve and verify that the authenticated user owns or belongs to the
 * given workspace. Returns the numeric workspaceId on success, or null if
 * the workspace does not exist or the user is not the owner.
 *
 * SEC-IDOR: All by-ID resource lookups must scope queries to a workspace
 * the caller is authorized for. This helper is the single authority for
 * that check; routes must not skip it or re-implement membership logic.
 */
export async function resolveAuthorizedWorkspaceId(
  c: Context,
  candidate: number | undefined | null,
): Promise<number | null> {
  const auth = c.get("auth");
  if (!auth || typeof auth.userId !== "number") return null;
  if (candidate == null || !Number.isFinite(candidate) || candidate <= 0) {
    return null;
  }
  const wsId = Math.trunc(candidate);
  const [ws] = await db
    .select({ id: workspaces.id, ownerId: workspaces.ownerId })
    .from(workspaces)
    .where(eq(workspaces.id, wsId))
    .limit(1);
  if (!ws || ws.ownerId !== auth.userId) return null;
  return wsId;
}

/**
 * Resolve the workspace for a request: when the caller supplies a candidate
 * (query/body), authorize it; when omitted, use the caller's first owned
 * workspace (creating a Personal one if needed). Never falls back to the
 * hardcoded id `1`, which breaks every account whose personal workspace is
 * not the first row in the database.
 */
export async function resolveRequestWorkspaceId(
  c: Context,
  candidate: number | string | undefined | null,
): Promise<number | null> {
  if (candidate !== undefined && candidate !== null && candidate !== "") {
    const n = typeof candidate === "number" ? candidate : Number(candidate);
    return resolveAuthorizedWorkspaceId(c, n);
  }
  const auth = c.get("auth");
  if (!auth || typeof auth.userId !== "number") return null;
  const ensured = await ensurePersonalWorkspace(auth.userId);
  if (!ensured.ok) return null;
  return resolveAuthorizedWorkspaceId(c, ensured.value.id);
}

/**
 * Returns the set of workspace ids owned by the authenticated user.
 * Used by the SSE bus to drop events that belong to other tenants.
 */
export async function listOwnedWorkspaceIds(c: Context): Promise<Set<number>> {
  const auth = c.get("auth");
  if (!auth || typeof auth.userId !== "number") return new Set();
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.ownerId, auth.userId))
    .orderBy(asc(workspaces.id));
  return new Set(rows.map((r) => r.id));
}

/**
 * SEC-IDOR: Shared authorization helper that performs a candidate lookup on
 * the given table, resolves the caller's authorized workspace from the row's
 * workspaceId column, and returns the scoped workspaceId or null when the
 * caller lacks access. Replaces duplicated inline IDOR blocks across route
 * handlers so ownership checks stay consistent and auditable in one place.
 */
export async function authorizeResourceOwnership<T extends Table>(
  table: T,
  idColumn: Column,
  workspaceIdColumn: AnyColumn<{ data: number }>,
  resourceId: number,
  context: Context,
): Promise<number | null> {
  // Use raw SQL via the underlying better-sqlite3 client to avoid drizzle-orm's
  // strict SelectedFieldsFlat typing on generic AnyColumn parameters.
  const colName =
    (workspaceIdColumn as { name?: string }).name ?? "workspace_id";
  // Extract table name using drizzle-orm's documented getTableName utility.
  const tableName = getTableName(table);
  const idColName = (idColumn as { name?: string }).name ?? "id";
  const row = db.$client
    .prepare(
      `SELECT "${colName}" AS workspace_id FROM "${tableName}" WHERE "${idColName}" = ? LIMIT 1`,
    )
    .get(resourceId) as { workspace_id: number } | undefined;
  return resolveAuthorizedWorkspaceId(context, row?.workspace_id);
}
