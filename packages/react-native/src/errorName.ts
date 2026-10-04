/**
 * What a package log line may say about something thrown: an `Error`'s class
 * name, or the type of anything else. Never its message or stack -- those are
 * whatever the throwing code put there (an app callback's own text, a value),
 * and the SDK captures console output into the report it uploads.
 */
export function errorName(error: unknown): string {
  if (error instanceof Error) {
    const { name } = error as { name: unknown };
    return typeof name === 'string' && name !== '' ? name : 'Error';
  }
  return error === null ? 'null' : typeof error;
}
