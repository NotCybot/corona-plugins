/**
 * What corona's host functions resolve to on failure: they answer `{ message }`
 * instead of throwing. Standard modules (`process`, `net`, `fetch`, `fs`) throw.
 */
export type Failure = { message: string };

export function failed(value: unknown): value is Failure {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'message' in value
  );
}

/** `value` without its failure, which is thrown, so one `try` covers both conventions. */
export function ok<T>(value: T): Exclude<T, Failure> {
  if (failed(value)) throw new Error(value.message);
  return value as Exclude<T, Failure>;
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
