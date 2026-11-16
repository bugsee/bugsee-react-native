/**
 * Reads the launch-option accessors out of the TypeScript sources of `BugseeLaunchOptions` and its
 * platform subclasses, so a check can compare what this package declares with what the SDKs publish.
 *
 * It reads the source, not the compiled classes, because the declared TYPE of an accessor exists only
 * there. The accessors are uniform (`get x(): T | undefined { return this.$get('key'); }` and the
 * matching setter), which is what makes this a reading and not a TypeScript parser: an accessor that
 * deviates from the shape is not found, and the check then reports its option as missing rather than
 * passing it unseen.
 */

export type Owner = 'base' | 'android' | 'ios';

export interface AccessorInfo {
  name: string;
  /** The `com.bugsee.option.*` key it reads and writes. */
  key: string;
  /** The declared type without `| undefined`, e.g. `LogLevel | number`. */
  type: string;
  /** The JSDoc summary, as one line. */
  doc: string;
  /** The `@deprecated` text, when the accessor is deprecated. */
  deprecated?: string;
  hasSetter: boolean;
  owner: Owner;
}

/** A JSDoc body as one line: the leading stars go, `{@link X}` becomes `X`, `@deprecated` is split off. */
export function readDoc(raw: string | undefined): { doc: string; deprecated?: string } {
  if (raw === undefined) {
    return { doc: '' };
  }
  const text = raw
    .split('\n')
    .map((line) => line.replace(/^\s*\*+ ?/, '').trim())
    .join(' ')
    .replace(/\{@link ([^}]+)\}/g, '`$1`')
    .replace(/\s+/g, ' ')
    .trim();
  const at = text.indexOf('@deprecated');
  if (at === -1) {
    return { doc: text };
  }
  return { doc: text.slice(0, at).trim(), deprecated: text.slice(at + '@deprecated'.length).trim() };
}

/** The text as a regular expression that matches it literally. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const GETTER =
  /(?:\/\*\*([\s\S]*?)\*\/\s*)?get (\w+)\(\): ([^{]*?) \| undefined \{\s*return this\.\$get\('([^']+)'\);\s*\}/g;

export function parseAccessors(source: string, owner: Owner): AccessorInfo[] {
  const accessors: AccessorInfo[] = [];
  for (const match of source.matchAll(GETTER)) {
    const [, rawDoc, name, type, key] = match as unknown as [string, string | undefined, string, string, string];
    const setter = new RegExp(
      `set ${escapeRegExp(name)}\\(value: [^)]*\\) \\{\\s*this\\.\\$set\\('${escapeRegExp(key)}', value\\);`,
    );
    accessors.push({
      name,
      key,
      type: type.trim(),
      ...readDoc(rawDoc),
      hasSetter: setter.test(source),
      owner,
    });
  }
  return accessors;
}
