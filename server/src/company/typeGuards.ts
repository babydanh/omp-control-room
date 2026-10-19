/**
 * Shared runtime type guards for company data that arrives from the wire or from disk.
 * Fields of the narrowed value are still `unknown`; check each one before use.
 */

/** A plain JSON-style object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
