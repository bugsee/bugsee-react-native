/**
 * Shared argument checks for `upload` and `showReportDialog`.
 *
 * Messages name the method and the field. They never include the rejected
 * value: a label or a severity string can be something the caller did not
 * mean to put in a log.
 */

/** 0 for undefined; RangeError unless an integer 1..5. A non-number is a TypeError. */
export function severityArgument(severity: unknown, method: string): number {
  if (severity === undefined) {
    return 0;
  }
  if (typeof severity !== 'number') {
    throw new TypeError(`Bugsee.${method} severity must be an integer 1..5`);
  }
  if (!Number.isInteger(severity) || severity < 1 || severity > 5) {
    throw new RangeError(`Bugsee.${method} severity must be an integer 1..5`);
  }
  return severity;
}

/** null for undefined; TypeError unless an array of strings; a fresh copy. */
export function labelsArgument(
  labels: unknown,
  method: string,
): string[] | null {
  if (labels === undefined) {
    return null;
  }
  if (!Array.isArray(labels)) {
    throw new TypeError(`Bugsee.${method} labels must be an array of strings`);
  }
  for (const label of labels) {
    if (typeof label !== 'string') {
      throw new TypeError(`Bugsee.${method} labels must be an array of strings`);
    }
  }
  return [...labels];
}
