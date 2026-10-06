/**
 * pbxproj quoted strings keep their quotes in the xcode project's object
 * model, and escapes (`\n`, `\"`, `\\`) stay as two characters. The writer
 * prints the value unchanged, so a shell script has to be stored in that
 * same shape.
 */

const ESCAPES: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t' };

/** `\x` becomes x, or the control character for n, r and t. A lone trailing `\` stays. */
function unescapeBody(body: string): string {
  return body.replace(/\\([\s\S])/g, (_, next: string) => ESCAPES[next] ?? next);
}

export function decodePbxString(stored: string): string {
  if (stored.startsWith('"') && stored.endsWith('"')) {
    return unescapeBody(stored.slice(1, -1));
  }
  return stored;
}

export function encodePbxString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}
