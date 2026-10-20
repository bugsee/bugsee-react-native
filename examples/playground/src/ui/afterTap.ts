/** Runs fn after 300 ms, so the tap handler returns first (a crash then happens outside React's handler). */
export function afterTap(fn: () => void): void {
  setTimeout(fn, 300);
}
