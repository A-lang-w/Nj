export interface User {
  id: number;
  email: string;
  displayName: string | null;
  avatarPath: string | null;
  settingsJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: number;
  workspaceId: number;
  name: string;
  description: string | null;
  systemPrompt: string;
  model: string;
  temperature: number | null;
  maxTokens: number | null;
  toolsJson: unknown[];
  iconPath: string | null;
  isCommunity: boolean;
  publisherId: number | null;
  metadataJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Thread {
  id: number;
  workspaceId: number;
  agentId: number | null;
  title: string | null;
  status: "active" | "archived" | "completed";
  metadataJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: number;
  threadId: number;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCallsJson: unknown[] | null;
  toolCallId: string | null;
  tokenCount: number | null;
  model: string | null;
  createdAt: string;
}

export interface Memory {
  id: number;
  workspaceId: number;
  agentId: number | null;
  content: string;
  sourceThreadId: number | null;
  tagsJson: string[];
  embeddingJson: unknown[] | null;
  metadataJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Skill {
  id: number;
  name: string;
  description: string | null;
  instructions: string;
  triggerPatternsJson: string[];
  isCommunity: boolean;
  publisherId: number | null;
  approvalStatus: "draft" | "pending" | "approved" | "rejected";
  metadataJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface FileRecord {
  id: number;
  workspaceId: number;
  threadId: number | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  uploadedBy: number;
  createdAt: string;
}

export interface McpServer {
  id: number;
  workspaceId: number;
  name: string;
  transportType: "stdio" | "sse" | "streamable-http";
  configJson: Record<string, unknown>;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InboxSummary {
  activeThreadCount: number;
  recentActivity: ActivityEvent[];
}

export interface ActivityEvent {
  id: number;
  workspaceId: number;
  userId: number | null;
  eventType: string;
  targetType: string | null;
  targetId: number | null;
  metadataJson: Record<string, unknown>;
  createdAt: string;
}
