/**
 * Shared default values for agent configuration and pagination.
 *
 * Centralizes magic numbers so services, routes, and schema defaults
 * reference a single source of truth.
 */

/** Default LLM model identifier when none is specified by the caller. */
export const DEFAULT_MODEL = "claude-opus-5-5";

/** Default sampling temperature for LLM responses. */
export const DEFAULT_TEMPERATURE = 0.7;

/** Default maximum tokens for a single LLM response. */
export const DEFAULT_MAX_TOKENS = 4096;

/**
 * Default token budget for system prompt + conversation history sent to the
 * LLM. Distinct from {@link DEFAULT_MAX_TOKENS} (completion length).
 */
export const DEFAULT_CONTEXT_TOKENS = 8000;

/** Default page size when the caller omits a limit. */
export const DEFAULT_PAGE_LIMIT = 50;

/** Hard ceiling on page size to prevent unbounded queries. */
export const MAX_PAGE_LIMIT = 200;

/** Upper bound on pagination offset to keep scans bounded. */
export const MAX_PAGINATION_OFFSET = 100000;

/** Maximum length for a thread title. */
export const MAX_THREAD_TITLE_LENGTH = 1000;

/** Maximum length for a thread message body (aligned with memory content). */
export const MAX_MESSAGE_CONTENT_LENGTH = 100000;
