/**
 * Compares the abstract methods React Native's codegen generates against the
 * ones `BugseeModule.java` actually implements.
 *
 * This lived as a list of string literals inside check-rn-compat.sh, which
 * meant the script reported "signatures match what BugseeModule.java
 * implements" without ever opening that file — it stayed green after
 * `BugseeModule.stop` was renamed. The first replacement used sed, which was
 * worse: BSD sed has no `\s`, so on macOS the pattern ate every literal "s"
 * and the comparison silently compared nonsense.
 */

/** A method reduced to name plus parameter types — what overriding requires. */
export interface Signature {
  name: string;
  parameters: string[];
}

const DECLARATION = /(?:public|protected)\s[^;{}]*?\b([a-zA-Z_]\w*)\s*\(/g;

/**
 * The parameter list starting at `open` (the index of its `(`), or null if
 * the parentheses never balance.
 *
 * A regex cannot do this: `[^)]*` stops at the first `)`, which for a
 * parameter annotated `@Nullable(x = 1)` is the annotation's, silently
 * truncating the list.
 */
function parameterList(java: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < java.length; i += 1) {
    const c = java[i];
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return java.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Splits on commas that separate parameters, ignoring those inside generics
 * or annotation arguments. Splitting naively tears `Map<String, Object> m`
 * into two halves, and the first loses its type entirely.
 */
function splitParameters(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of list) {
    if (c === '<' || c === '(') depth += 1;
    else if (c === '>' || c === ')') depth -= 1;
    if (c === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

/**
 * Drops modifiers and the parameter's own name, keeping its type.
 *
 * "final ReadableMap options" -> "ReadableMap". A Java parameter always has
 * both a type and a name, so dropping the last token is always right.
 */
function parameterType(declaration: string): string {
  const cleaned = declaration
    .replace(/@\w+\s*(\([^()]*\))?/g, ' ')
    .replace(/\bfinal\b/g, ' ')
    .trim();
  return cleaned.split(/\s+/).slice(0, -1).join(' ');
}

export function parseSignatures(java: string, names: readonly string[]): Signature[] {
  const wanted = new Set(names);
  const found: Signature[] = [];
  DECLARATION.lastIndex = 0;
  for (const match of java.matchAll(DECLARATION)) {
    const name = match[1] as string;
    if (!wanted.has(name)) continue;
    const open = match.index + match[0].length - 1;
    const list = parameterList(java, open);
    if (list === null) continue;
    found.push({
      name,
      parameters: splitParameters(list).map(parameterType),
    });
  }
  return found;
}

export function format(signature: Signature): string {
  return `${signature.name}(${signature.parameters.join(', ')})`;
}

/** Generated signatures with no matching implementation. */
export function unimplemented(
  generated: Signature[],
  implemented: Signature[],
): string[] {
  const have = new Set(implemented.map(format));
  return generated.map(format).filter((s) => !have.has(s));
}
