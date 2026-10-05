/**
 * What a package log line may say about something thrown: an `Error`'s class
 * name, or the type of anything else. Never its message or stack -- those are
 * whatever the throwing code put there (an app callback's own text, a value),
 * and the SDK captures console output into the report it uploads.
 *
 * Never throws. It runs inside the catch blocks that keep one failure from
 * reaching the rest (the secure measure loop, the report dispatcher, the
 * view-tree reply), and the thrown value is the app's: a `name` getter can
 * throw, and so can `instanceof` on a Proxy whose `getPrototypeOf` trap
 * throws. The first reads as `'Error'`, the second as the value's type. (The same guard
 * as `exceptions/payload.ts`'s `safeIsError`/`safeGetString`.)
 */
export function errorName(error: unknown): string {
  if (!isError(error)) {
    return error === null ? 'null' : typeof error;
  }
  try {
    const name: unknown = error.name;
    return typeof name === 'string' && name !== '' ? name : 'Error';
  } catch {
    return 'Error';
  }
}

function isError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}
