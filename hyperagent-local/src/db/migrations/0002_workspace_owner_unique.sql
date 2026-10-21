-- Prevent duplicate workspace names per user (e.g. concurrent 'Personal' creation).
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_owner_name_idx ON workspaces(owner_id, name);