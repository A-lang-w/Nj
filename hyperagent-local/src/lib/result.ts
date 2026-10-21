/**
 * Tagged Result type for explicit error handling per AGENTS.md.
 * Preserves partial facts and meaningful failure reasons without exceptions.
 */

export type Result<T, E = DomainError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function Ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function Err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * Base domain error hierarchy. All service-layer errors extend this class
 * so callers can discriminate failures by tag rather than string matching.
 */
export abstract class DomainError extends Error {
  abstract readonly tag: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ValidationError extends DomainError {
  readonly tag = "ValidationError" as const;
}

export class ResourceNotFoundError extends DomainError {
  readonly tag = "ResourceNotFoundError" as const;
}

export class CapacityError extends DomainError {
  readonly tag = "CapacityError" as const;
}

export class StorageError extends DomainError {
  readonly tag = "StorageError" as const;
}
