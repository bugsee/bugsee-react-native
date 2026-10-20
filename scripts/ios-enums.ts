/**
 * Reads Objective-C enums out of an iOS SDK header.
 *
 * Exists because the option-enum fixture is extracted from the ANDROID sources
 * only, so nothing compares the two platforms' values. That gap is not
 * theoretical: iOS renumbered `BugseeLifecycleEventType` between 7.0.0-beta1
 * and beta2, and a wrapper that coerced by ordinal would have started sending
 * a different, still-valid value with no error anywhere.
 */

/** `typedef NS_ENUM(NSInteger, Name) { ... };` */
const NS_ENUM = /typedef\s+NS_(?:ENUM|OPTIONS)\s*\(\s*[A-Za-z_][\w ]*\s*,\s*(\w+)\s*\)\s*\{([^}]*)\}/g;

/** `typedef enum : NSUInteger { ... } Name;` — the name trails the body. */
const TRAILING_TYPEDEF = /typedef\s+enum\s*(?::\s*[A-Za-z_][\w ]*)?\s*\{([^}]*)\}\s*(\w+)\s*;/g;

/** `NAME = 12` or `NAME` (which continues the sequence). */
const MEMBER = /^\s*(\w+)\s*(?:=\s*(-?\d+)\s*)?$/;

/**
 * Strips comments before parsing. A commented-out enum would otherwise be read
 * as real, and a doc comment naming another enum would be read as a member.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * Drops `NS_SWIFT_NAME(...)` from a member, including a Swift name with its own
 * parentheses (`NS_SWIFT_NAME(foo(bar:))`). `BugseeCrashHandlerTypeBSD
 * NS_SWIFT_NAME(bsd) = 1` would otherwise fail MEMBER.
 */
function withoutSwiftNames(entry: string): string {
  return entry.replace(/\bNS_SWIFT_NAME\s*\((?:[^()]|\([^()]*\))*\)/g, '');
}

/**
 * Reads the members of one enum body. An entry that is not `NAME` or
 * `NAME = n` (another attribute macro, a computed value such as `(A | B)`) is
 * left out of the result and its text pushed onto `skipped`, so a caller can
 * refuse an enum it could not read whole.
 */
function members(body: string, skipped: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  // Implicit members take the previous value plus one, so the running value
  // has to be carried; reading only the explicit ones would skip members
  // entirely, which is how an enum looks like it agrees when it does not.
  let next = 0;
  for (const entry of body.split(',')) {
    if (entry.trim() === '') continue;
    const matched = MEMBER.exec(withoutSwiftNames(entry));
    if (!matched) {
      skipped.push(entry.trim());
      continue;
    }
    const name = matched[1] as string;
    const explicit = matched[2];
    const value = explicit === undefined ? next : Number(explicit);
    out[name] = value;
    next = value + 1;
  }
  return out;
}

/**
 * Every enum in `source`, as `{ EnumName: { MemberName: value } }`. Entries a
 * member could not be read from are listed per enum in `skipped`, when given.
 */
export function parseObjcEnums(
  source: string,
  skipped: Record<string, string[]> = {},
): Record<string, Record<string, number>> {
  const clean = withoutComments(source);
  const out: Record<string, Record<string, number>> = {};
  const read = (name: string, body: string): void => {
    const unread: string[] = [];
    out[name] = members(body, unread);
    if (unread.length > 0) skipped[name] = unread;
  };

  for (const [, name, body] of clean.matchAll(NS_ENUM)) {
    read(name as string, body as string);
  }
  for (const [, body, name] of clean.matchAll(TRAILING_TYPEDEF)) {
    read(name as string, body as string);
  }

  return out;
}

/**
 * One enum from `source`, read whole or not at all. Throws when the enum is
 * missing, has no members, or has a member that could not be read: a partial
 * enum would make the fixture, and every parity check built on it, quietly
 * agree with less than the SDK has.
 */
export function readObjcEnum(source: string, objcName: string): Record<string, number> {
  const skipped: Record<string, string[]> = {};
  const parsed = parseObjcEnums(source, skipped)[objcName];
  if (parsed === undefined) {
    throw new Error(`iOS enum ${objcName} not found.`);
  }
  const unread = skipped[objcName];
  if (unread !== undefined) {
    throw new Error(`iOS enum ${objcName}: could not read ${unread.map((e) => `"${e}"`).join(', ')}.`);
  }
  if (Object.keys(parsed).length === 0) {
    throw new Error(`iOS enum ${objcName} has no members.`);
  }
  return parsed;
}
