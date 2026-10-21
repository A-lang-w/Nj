export interface ChatDeltaEvent {
  content: string;
}

export interface ChatDoneEvent {
  threadId: number;
  messageId?: number;
  incomplete?: boolean;
}

export interface GlobalEvent {
  type: string;
  [key: string]: unknown;
}

export type SseEventType =
  | "message.delta"
  | "message.done"
  | "thread.created"
  | "thread.message"
  | "memory.created"
  | "memory.deleted"
  | "skill.created"
  | "skill.deleted"
  | "file.uploaded"
  | "file.deleted"
  | "mcp_server.created"
  | "mcp_server.updated"
  | "mcp_server.deleted"
  | "community.skill.submitted"
  | "community.skill.approved"
  | "replay.gap"
  | "server.epoch"
  | "ping";

export interface ReplayGapEvent {
  /** Cursor the client sent, or null when the gap came from an epoch reset alone. */
  requestedId: string | null;
  /** Oldest retained id, or null when the buffer is fully evicted. */
  oldestId: string | null;
}

export interface ServerEpochEvent {
  epoch: string;
}
