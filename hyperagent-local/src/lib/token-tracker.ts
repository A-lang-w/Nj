/**
 * In-memory token usage accumulator for local-mode billing.
 *
 * Ghost CLI and other OpenAI-compatible local providers do not reliably
 * include `usage` metadata in streaming chunks. When real usage data is
 * available it is recorded directly; otherwise callers should use
 * {@link estimateAndRecordUsage} which derives an approximation from the
 * observed character count (roughly 1 token per 4 characters).
 *
 * State is keyed by userId so concurrent local accounts on one process do
 * not share billing counters. Resets on process restart (intentional: no
 * durable billing store in local mode).
 */

export interface ModelUsage {
  /** Cumulative prompt tokens consumed by this model. */
  promptTokens: number;
  /** Cumulative completion tokens consumed by this model. */
  completionTokens: number;
  /** Cumulative total tokens (prompt + completion) for this model. */
  totalTokens: number;
}

export interface UsageSummary {
  /** Aggregate prompt tokens across all models. */
  promptTokens: number;
  /** Aggregate completion tokens across all models. */
  completionTokens: number;
  /** Aggregate total tokens across all models. */
  totalTokens: number;
  /** Per-model breakdown of token consumption. */
  byModel: Record<string, ModelUsage>;
  /** ISO-8601 timestamp of the first recorded usage in this session. */
  periodStart: string | null;
  /** ISO-8601 timestamp of the most recent recorded usage. */
  periodEnd: string | null;
}

interface UserUsageState {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  byModel: Map<string, ModelUsage>;
  periodStart: Date | null;
  periodEnd: Date | null;
}

const byUser = new Map<number, UserUsageState>();

function emptyState(): UserUsageState {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    byModel: new Map(),
    periodStart: null,
    periodEnd: null,
  };
}

function stateFor(userId: number): UserUsageState {
  let state = byUser.get(userId);
  if (!state) {
    state = emptyState();
    byUser.set(userId, state);
  }
  return state;
}

/**
 * Records a token usage observation for the given user and model.
 */
export function recordUsage(
  userId: number,
  model: string,
  promptTokens: number,
  completionTokens: number,
): void {
  const state = stateFor(userId);
  const totalTokens = promptTokens + completionTokens;
  const now = new Date();

  state.promptTokens += promptTokens;
  state.completionTokens += completionTokens;
  state.totalTokens += totalTokens;

  if (!state.periodStart) {
    state.periodStart = now;
  }
  state.periodEnd = now;

  let modelEntry = state.byModel.get(model);
  if (!modelEntry) {
    modelEntry = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    state.byModel.set(model, modelEntry);
  }
  modelEntry.promptTokens += promptTokens;
  modelEntry.completionTokens += completionTokens;
  modelEntry.totalTokens += totalTokens;
}

/**
 * Estimates token counts from character lengths and records them.
 */
export function estimateAndRecordUsage(
  userId: number,
  model: string,
  promptChars: number,
  completionChars: number,
): void {
  const promptTokens = Math.max(1, Math.ceil(promptChars / 4));
  const completionTokens = Math.max(1, Math.ceil(completionChars / 4));
  recordUsage(userId, model, promptTokens, completionTokens);
}

/**
 * Returns a snapshot of cumulative token usage for the given user.
 *
 * The returned object is a deep copy; mutating it does not affect internal
 * state. Periods are null when no usage has been recorded for that user
 * since process start.
 */
export function getUsageSummary(userId: number): UsageSummary {
  const state = stateFor(userId);
  const byModel: Record<string, ModelUsage> = {};
  for (const [model, usage] of state.byModel.entries()) {
    byModel[model] = { ...usage };
  }
  return {
    promptTokens: state.promptTokens,
    completionTokens: state.completionTokens,
    totalTokens: state.totalTokens,
    byModel,
    periodStart: state.periodStart ? state.periodStart.toISOString() : null,
    periodEnd: state.periodEnd ? state.periodEnd.toISOString() : null,
  };
}
