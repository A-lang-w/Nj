UPDATE agents
SET workspace_id = (
  SELECT MIN(w2.id)
  FROM workspaces w2
  WHERE w2.owner_id = (SELECT owner_id FROM workspaces w1 WHERE w1.id = agents.workspace_id)
    AND w2.name = (SELECT name FROM workspaces w1 WHERE w1.id = agents.workspace_id)
)
WHERE workspace_id IN (
  SELECT id FROM workspaces w
  WHERE id NOT IN (SELECT MIN(id) FROM workspaces GROUP BY owner_id, name)
);
--> statement-breakpoint
UPDATE threads
SET workspace_id = (
  SELECT MIN(w2.id)
  FROM workspaces w2
  WHERE w2.owner_id = (SELECT owner_id FROM workspaces w1 WHERE w1.id = threads.workspace_id)
    AND w2.name = (SELECT name FROM workspaces w1 WHERE w1.id = threads.workspace_id)
)
WHERE workspace_id IN (
  SELECT id FROM workspaces w
  WHERE id NOT IN (SELECT MIN(id) FROM workspaces GROUP BY owner_id, name)
);
--> statement-breakpoint
UPDATE memories
SET workspace_id = (
  SELECT MIN(w2.id)
  FROM workspaces w2
  WHERE w2.owner_id = (SELECT owner_id FROM workspaces w1 WHERE w1.id = memories.workspace_id)
    AND w2.name = (SELECT name FROM workspaces w1 WHERE w1.id = memories.workspace_id)
)
WHERE workspace_id IN (
  SELECT id FROM workspaces w
  WHERE id NOT IN (SELECT MIN(id) FROM workspaces GROUP BY owner_id, name)
);
--> statement-breakpoint
UPDATE files
SET workspace_id = (
  SELECT MIN(w2.id)
  FROM workspaces w2
  WHERE w2.owner_id = (SELECT owner_id FROM workspaces w1 WHERE w1.id = files.workspace_id)
    AND w2.name = (SELECT name FROM workspaces w1 WHERE w1.id = files.workspace_id)
)
WHERE workspace_id IN (
  SELECT id FROM workspaces w
  WHERE id NOT IN (SELECT MIN(id) FROM workspaces GROUP BY owner_id, name)
);
--> statement-breakpoint
UPDATE activity_events
SET workspace_id = (
  SELECT MIN(w2.id)
  FROM workspaces w2
  WHERE w2.owner_id = (SELECT owner_id FROM workspaces w1 WHERE w1.id = activity_events.workspace_id)
    AND w2.name = (SELECT name FROM workspaces w1 WHERE w1.id = activity_events.workspace_id)
)
WHERE workspace_id IN (
  SELECT id FROM workspaces w
  WHERE id NOT IN (SELECT MIN(id) FROM workspaces GROUP BY owner_id, name)
);
--> statement-breakpoint
UPDATE mcp_servers
SET workspace_id = (
  SELECT MIN(w2.id)
  FROM workspaces w2
  WHERE w2.owner_id = (SELECT owner_id FROM workspaces w1 WHERE w1.id = mcp_servers.workspace_id)
    AND w2.name = (SELECT name FROM workspaces w1 WHERE w1.id = mcp_servers.workspace_id)
)
WHERE workspace_id IN (
  SELECT id FROM workspaces w
  WHERE id NOT IN (SELECT MIN(id) FROM workspaces GROUP BY owner_id, name)
);
--> statement-breakpoint
UPDATE skills
SET workspace_id = (
  SELECT MIN(w2.id)
  FROM workspaces w2
  WHERE w2.owner_id = (SELECT owner_id FROM workspaces w1 WHERE w1.id = skills.workspace_id)
    AND w2.name = (SELECT name FROM workspaces w1 WHERE w1.id = skills.workspace_id)
)
WHERE workspace_id IS NOT NULL
  AND workspace_id IN (
    SELECT id FROM workspaces w
    WHERE id NOT IN (SELECT MIN(id) FROM workspaces GROUP BY owner_id, name)
  );
--> statement-breakpoint
DELETE FROM workspaces
WHERE id NOT IN (SELECT MIN(id) FROM workspaces GROUP BY owner_id, name);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_owner_name_idx ON workspaces(owner_id, name);
