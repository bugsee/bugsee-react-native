/**
 * pbxproj quoted strings keep their quotes in the xcode project's object
 * model, and escapes (`\n`, `\"`, `\\`) stay as two characters. The writer
 * prints the value unchanged, so a shell script has to be stored in that
 * same shape.
 */

function unescapeBody(body: string): string {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const current = body[i];
    if (current === '\\' && i + 1 < body.length) {
      const next = body[i + 1];
      if (next === 'n') {
        out += '\n';
      } else if (next === 'r') {
        out += '\r';
      } else if (next === 't') {
        out += '\t';
      } else if (next !== undefined) {
        out += next;
      }
      i += 1;
      continue;
    }
    if (current !== undefined) {
      out += current;
    }
  }
  return out;
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
