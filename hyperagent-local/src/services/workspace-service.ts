import { eq, asc } from "drizzle-orm";
import { db } from "../db/connection.js";
import { workspaces } from "../db/schema.js";
import { Ok, Err, StorageError } from "../lib/result.js";
import type { Result } from "../lib/result.js";

/**
 * Finds the user's first-owned workspace, creating a "Personal" one when
 * none exists. Single owner of the find-or-create rule: login calls this so
 * every account (not just the seed user) can reach its data, and seed
 * reuses it for the local user. Concurrent logins are safe: the insert
 * uses onConflictDoNothing so a racing create returns zero rows and we
 * fall back to the select instead of producing duplicates.
 */
export async function ensurePersonalWorkspace(
  userId: number,
): Promise<Result<typeof workspaces.$inferSelect, StorageError>> {
  try {
    // Wrap select-or-insert in an IMMEDIATE transaction so concurrent logins
    // serialize at the DB level. onConflictDoNothing plus the unique index
    // on (owner_id, name) ensures the loser converges without duplicates.
    const result = db.transaction((tx) => {
      const [existing] = tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.ownerId, userId))
        .orderBy(asc(workspaces.id))
        .limit(1)
        .all();
      if (existing) return existing;
      const [created] = tx
        .insert(workspaces)
        .values({ name: "Personal", ownerId: userId })
        .onConflictDoNothing()
        .returning()
        .all();
      if (created) return created;
      // Lost the race inside the transaction: re-select to get the winner.
      const [winner] = tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.ownerId, userId))
        .orderBy(asc(workspaces.id))
        .limit(1)
        .all();
      if (!winner) {
        throw new StorageError(
          "Personal workspace missing after conflict resolution",
        );
      }
      return winner;
    });
    return Ok(result);
  } catch (err) {
    if (err instanceof StorageError) return Err(err);
    return Err(
      new StorageError(
        err instanceof Error ? err.message : "Failed to ensure workspace",
      ),
    );
  }
}

/**
 * Lists workspaces owned by the caller, oldest first. The client uses this
 * to repair a stale stored workspace id (fresh login elsewhere, cleared
 * storage) instead of 404ing every data page with no recovery.
 */
export async function listOwnedWorkspaces(
  userId: number,
): Promise<
  Result<
    Array<Pick<typeof workspaces.$inferSelect, "id" | "name">>,
    StorageError
  >
> {
  try {
    const rows = await db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.ownerId, userId))
      .orderBy(asc(workspaces.id));
    return Ok(rows);
  } catch (err) {
    return Err(
      new StorageError(
        err instanceof Error ? err.message : "Failed to list workspaces",
      ),
    );
  }
}
