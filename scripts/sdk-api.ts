/**
 * Extracts the public API surface of the two native SDKs: the method names of
 * the Android `Bugsee` class and the class methods of the iOS `Bugsee`
 * interface. Names only: this exists so a method a new SDK release adds cannot
 * go unnoticed, not to describe signatures.
 */

export interface SdkMethod {
  name: string;
  deprecated: boolean;
}

/**
 * A public static method declaration, read across line breaks: the modifiers, the return type and the
 * name may each sit on their own line. Reading line by line missed `public static` followed by
 * `void added() {}`, and an extraction that misses a method writes an incomplete inventory the parity
 * test then passes. Anchored at a line start, so a mention inside a comment (` * public static ...`) is
 * not a declaration; `{`, `;` and `=` are outside the type pattern, so a field or a nested class is not
 * one either.
 */
const ANDROID_DECLARATION = /^[ \t]*public\s+static\s+(?:<[^>]+>\s+)?[\w<>[\],.?\s]+?\s+(\w+)\s*\(/gm;

/** Public static methods of the Android `Bugsee` class, deduplicated across overloads. */
export function parseAndroidApi(source: string): SdkMethod[] {
  const methods = new Map<string, SdkMethod>();
  for (const match of source.matchAll(ANDROID_DECLARATION)) {
    const name = match[1] as string;
    // Only the annotations and comments directly above this method: a wider window reads
    // the previous method's @Deprecated as this one's.
    const above = source.slice(0, match.index).split('\n');
    let deprecated = false;
    for (let up = above.length - 1; up >= 0; up--) {
      const line = (above[up] as string).trim();
      if (/^@Deprecated\b/.test(line)) {
        deprecated = true;
      }
      if (line !== '' && !/^(?:@|\/\*|\*|\/\/)/.test(line)) {
        break;
      }
    }
    const previous = methods.get(name);
    // A name is deprecated only when every overload is.
    methods.set(name, { name, deprecated: previous ? previous.deprecated && deprecated : deprecated });
  }
  if (methods.size === 0) {
    throw new Error('no public static methods found; the parser missed the source');
  }
  return [...methods.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Class methods (`+`) and properties of the iOS `Bugsee` interface; the first selector part names a method. */
export function parseIosApi(header: string): SdkMethod[] {
  const start = header.search(/@interface\s+Bugsee\s*:/);
  if (start === -1) {
    throw new Error('no @interface Bugsee found; the parser missed the source');
  }
  const end = header.indexOf('@end', start);
  const body = header.slice(start, end === -1 ? undefined : end);
  const methods = new Map<string, SdkMethod>();
  for (const m of body.matchAll(/^\s*\+\s*\([^)]*\)\s*(\w+)/gm)) {
    methods.set(m[1] as string, { name: m[1] as string, deprecated: false });
  }
  for (const m of body.matchAll(/^\s*@property\b[^;]*?\b(\w+)\s*;/gm)) {
    methods.set(m[1] as string, { name: m[1] as string, deprecated: false });
  }
  if (methods.size === 0) {
    throw new Error('no methods found in @interface Bugsee; the parser missed the source');
  }
  return [...methods.values()].sort((a, b) => a.name.localeCompare(b.name));
}
