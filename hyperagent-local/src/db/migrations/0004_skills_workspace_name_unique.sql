DELETE FROM skills
WHERE workspace_id IS NOT NULL
  AND id NOT IN (
    SELECT MIN(id)
    FROM skills
    WHERE workspace_id IS NOT NULL
    GROUP BY workspace_id, name
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS skills_workspace_name_idx
  ON skills(workspace_id, name)
  WHERE workspace_id IS NOT NULL;
