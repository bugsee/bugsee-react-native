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

function members(body: string): Record<string, number> {
  const out: Record<string, number> = {};
  // Implicit members take the previous value plus one, so the running value
  // has to be carried; reading only the explicit ones would skip members
  // entirely, which is how an enum looks like it agrees when it does not.
  let next = 0;
  for (const entry of body.split(',')) {
    const matched = MEMBER.exec(entry);
    if (!matched) continue;
    const name = matched[1] as string;
    const explicit = matched[2];
    const value = explicit === undefined ? next : Number(explicit);
    out[name] = value;
    next = value + 1;
  }
  return out;
}

/** Every enum in `source`, as `{ EnumName: { MemberName: value } }`. */
export function parseObjcEnums(source: string): Record<string, Record<string, number>> {
  const clean = withoutComments(source);
  const out: Record<string, Record<string, number>> = {};

  for (const [, name, body] of clean.matchAll(NS_ENUM)) {
    out[name as string] = members(body as string);
  }
  for (const [, body, name] of clean.matchAll(TRAILING_TYPEDEF)) {
    out[name as string] = members(body as string);
  }

  return out;
}
