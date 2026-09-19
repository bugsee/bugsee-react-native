// Extracted from index.ts so the wrapper's event layer can derive a status
// without importing the facade -- that would be a cycle: index -> wrapper ->
// index. Nothing about the values changed; index re-exports them.

/**
 * Mirrors the SDKs' own status enum. Both platforms bring capture up off the
 * main thread, so `launch` returning is not the same as being live — poll or
 * observe this rather than assuming.
 */
export const Status = {
  Stopped: 0,
  Launching: 1,
  Launched: 2,
  Stopping: 3,
} as const;
export type Status = (typeof Status)[keyof typeof Status];
