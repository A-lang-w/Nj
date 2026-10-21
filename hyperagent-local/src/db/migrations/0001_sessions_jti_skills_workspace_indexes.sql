ALTER TABLE `sessions` ADD `jti` text;--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
ALTER TABLE `skills` ADD `workspace_id` integer REFERENCES workspaces(id);--> statement-breakpoint
CREATE INDEX `skills_workspace_idx` ON `skills` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `activity_events_workspace_created_idx` ON `activity_events` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `agents_workspace_idx` ON `agents` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `files_workspace_thread_idx` ON `files` (`workspace_id`,`thread_id`);--> statement-breakpoint
CREATE INDEX `files_uploaded_by_idx` ON `files` (`uploaded_by`);--> statement-breakpoint
CREATE INDEX `mcp_servers_workspace_idx` ON `mcp_servers` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `memories_workspace_created_idx` ON `memories` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `memories_agent_idx` ON `memories` (`agent_id`);--> statement-breakpoint
CREATE INDEX `threads_workspace_updated_idx` ON `threads` (`workspace_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `threads_agent_idx` ON `threads` (`agent_id`);--> statement-breakpoint
CREATE INDEX `workspaces_owner_idx` ON `workspaces` (`owner_id`);--> statement-breakpoint
-- Custom SQL (not generated): FTS5 full-text index over memories.content.
-- Drizzle does not model virtual tables or triggers, so these statements are
-- maintained by hand. Backfill keeps pre-existing rows searchable.
CREATE VIRTUAL TABLE `memories_fts` USING fts5(
	`content`,
	content=`memories`,
	content_rowid=`id`
);--> statement-breakpoint
CREATE TRIGGER `memories_ai` AFTER INSERT ON `memories` BEGIN
	INSERT INTO `memories_fts`(rowid, content) VALUES (new.id, new.content);
END;--> statement-breakpoint
CREATE TRIGGER `memories_ad` AFTER DELETE ON `memories` BEGIN
	INSERT INTO `memories_fts`(`memories_fts`, rowid, content) VALUES('delete', old.id, old.content);
END;--> statement-breakpoint
CREATE TRIGGER `memories_au` AFTER UPDATE ON `memories` BEGIN
	INSERT INTO `memories_fts`(`memories_fts`, rowid, content) VALUES('delete', old.id, old.content);
	INSERT INTO `memories_fts`(rowid, content) VALUES (new.id, new.content);
END;--> statement-breakpoint
INSERT INTO `memories_fts`(rowid, content) SELECT `id`, `content` FROM `memories`;