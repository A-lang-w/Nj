import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_TEMPERATURE,
} from "../config/constants.js";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  displayName: text("display_name"),
  avatarPath: text("avatar_path"),
  settingsJson: text("settings_json").default("{}"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Current JWT ID for single-use refresh rotation. Null only during migration. */
    jti: text("jti"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    userIdx: index("sessions_user_idx").on(table.userId),
  }),
);

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => users.id),
    settingsJson: text("settings_json").default("{}"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    ownerIdx: index("workspaces_owner_idx").on(table.ownerId),
    ownerNameIdx: uniqueIndex("workspaces_owner_name_idx").on(
      table.ownerId,
      table.name,
    ),
  }),
);

export const agents = sqliteTable(
  "agents",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    systemPrompt: text("system_prompt").notNull(),
    model: text("model").notNull().default(DEFAULT_MODEL),
    temperature: real("temperature").default(DEFAULT_TEMPERATURE),
    maxTokens: integer("max_tokens").default(DEFAULT_MAX_TOKENS),
    toolsJson: text("tools_json", { mode: "json" }).default([]),
    iconPath: text("icon_path"),
    isCommunity: integer("is_community", { mode: "boolean" }).default(false),
    publisherId: integer("publisher_id").references(() => users.id),
    metadataJson: text("metadata_json", { mode: "json" }).default({}),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    workspaceIdx: index("agents_workspace_idx").on(table.workspaceId),
  }),
);

export const threads = sqliteTable(
  "threads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: integer("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    title: text("title"),
    status: text("status", { enum: ["active", "archived", "completed"] })
      .notNull()
      .default("active"),
    metadataJson: text("metadata_json", { mode: "json" }).default({}),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    workspaceUpdatedIdx: index("threads_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt,
    ),
    agentIdx: index("threads_agent_idx").on(table.agentId),
  }),
);

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    threadId: integer("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    role: text("role", {
      enum: ["user", "assistant", "system", "tool"],
    }).notNull(),
    content: text("content").notNull(),
    toolCallsJson: text("tool_calls_json", { mode: "json" }),
    toolCallId: text("tool_call_id"),
    tokenCount: integer("token_count"),
    model: text("model"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    threadCreatedIdx: index("messages_thread_created_idx").on(
      table.threadId,
      table.createdAt,
    ),
    toolCallIdIdx: index("messages_tool_call_id_idx").on(table.toolCallId),
  }),
);

export const memories = sqliteTable(
  "memories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: integer("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    content: text("content").notNull(),
    sourceThreadId: integer("source_thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
    tagsJson: text("tags_json", { mode: "json" }).default([]),
    embeddingJson: text("embedding_json", { mode: "json" }),
    metadataJson: text("metadata_json", { mode: "json" }).default({}),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    workspaceCreatedIdx: index("memories_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    agentIdx: index("memories_agent_idx").on(table.agentId),
    workspaceAgentIdx: index("memories_workspace_agent_idx").on(
      table.workspaceId,
      table.agentId,
    ),
  }),
);

export const skills = sqliteTable(
  "skills",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: integer("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    description: text("description"),
    instructions: text("instructions").notNull(),
    triggerPatternsJson: text("trigger_patterns_json", {
      mode: "json",
    }).default([]),
    isCommunity: integer("is_community", { mode: "boolean" }).default(false),
    publisherId: integer("publisher_id").references(() => users.id),
    approvalStatus: text("approval_status", {
      enum: ["draft", "pending", "approved", "rejected"],
    }).default("draft"),
    metadataJson: text("metadata_json", { mode: "json" }).default({}),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    workspaceIdx: index("skills_workspace_idx").on(table.workspaceId),
  }),
);

export const files = sqliteTable(
  "files",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: integer("thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storagePath: text("storage_path").notNull(),
    uploadedBy: integer("uploaded_by")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    workspaceThreadIdx: index("files_workspace_thread_idx").on(
      table.workspaceId,
      table.threadId,
    ),
    uploadedByIdx: index("files_uploaded_by_idx").on(table.uploadedBy),
  }),
);

export const favorites = sqliteTable(
  "favorites",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetType: text("target_type", {
      enum: ["thread", "agent", "skill", "memory"],
    }).notNull(),
    targetId: integer("target_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.userId, table.targetType, table.targetId],
    }),
  }),
);

export const activityEvents = sqliteTable(
  "activity_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: integer("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    eventType: text("event_type").notNull(),
    targetType: text("target_type"),
    targetId: integer("target_id"),
    metadataJson: text("metadata_json", { mode: "json" }).default({}),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    workspaceCreatedIdx: index("activity_events_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    userIdx: index("activity_events_user_idx").on(table.userId),
  }),
);

export const mcpServers = sqliteTable(
  "mcp_servers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    transportType: text("transport_type", {
      enum: ["stdio", "sse", "streamable-http"],
    }).notNull(),
    configJson: text("config_json", { mode: "json" }).notNull(),
    isEnabled: integer("is_enabled", { mode: "boolean" }).default(true),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    workspaceIdx: index("mcp_servers_workspace_idx").on(table.workspaceId),
  }),
);

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  workspaces: many(workspaces),
  // Via agents.publisherId — memories have no user FK and must not appear here.
  agents: many(agents),
  files: many(files),
  favorites: many(favorites),
}));

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  owner: one(users, { fields: [workspaces.ownerId], references: [users.id] }),
  agents: many(agents),
  threads: many(threads),
  memories: many(memories),
  files: many(files),
  activityEvents: many(activityEvents),
  mcpServers: many(mcpServers),
}));

export const agentsRelations = relations(agents, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [agents.workspaceId],
    references: [workspaces.id],
  }),
  publisher: one(users, {
    fields: [agents.publisherId],
    references: [users.id],
  }),
  threads: many(threads),
  memories: many(memories),
}));

export const threadsRelations = relations(threads, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [threads.workspaceId],
    references: [workspaces.id],
  }),
  agent: one(agents, { fields: [threads.agentId], references: [agents.id] }),
  messages: many(messages),
  files: many(files),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  thread: one(threads, {
    fields: [messages.threadId],
    references: [threads.id],
  }),
}));

export const memoriesRelations = relations(memories, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [memories.workspaceId],
    references: [workspaces.id],
  }),
  agent: one(agents, { fields: [memories.agentId], references: [agents.id] }),
  sourceThread: one(threads, {
    fields: [memories.sourceThreadId],
    references: [threads.id],
  }),
}));

export const filesRelations = relations(files, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [files.workspaceId],
    references: [workspaces.id],
  }),
  thread: one(threads, { fields: [files.threadId], references: [threads.id] }),
  uploader: one(users, { fields: [files.uploadedBy], references: [users.id] }),
}));
