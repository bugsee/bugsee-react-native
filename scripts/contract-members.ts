/**
 * Member extraction for the contract-parity gate.
 *
 * The Android contracts are the reference: every capability a wrapper or an
 * embedder can reach is declared there as an interface. This reads the member
 * names off both platforms so the two can be compared, rather than the
 * comparison living in someone's head or in a document that rots.
 *
 * Names only, deliberately. Types do not survive a cross-language comparison
 * -- `int[]` against `NSData`, `Serializable` against `id` -- and pretending
 * they do produces noise that buries the real gaps. What a name comparison
 * catches is the thing that actually matters here: a capability one platform
 * offers and the other does not.
 */

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /\/\/[^\n]*/g;

function withoutComments(source: string): string {
  return source.replace(BLOCK_COMMENT, '').replace(LINE_COMMENT, '');
}

/**
 * A method declaration in a Java interface: an optional modifier and return
 * type, the name, then the parameter list. Anchored on the parenthesis so a
 * constant (`String PREFIX = "x";`) cannot match.
 */
const JAVA_METHOD =
  /^[ \t]*(?:(?:public|default|static|final)\s+)*[\w.<>,[\]? ]+?\s+(\w+)\s*\(/gm;

/** Words that read as a method but introduce a type or a control structure. */
const NOT_A_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new']);

/**
 * Method names declared by a Java interface, deduplicated.
 *
 * Overloads collapse to one entry: `setScreenshot(Bitmap)` and
 * `setScreenshot(int, Bitmap)` are one capability expressed twice, and
 * counting them separately would report a false gap against a platform that
 * spells the same capability once.
 */
export function parseJavaMembers(source: string): string[] {
  const clean = withoutComments(source)
    // Annotations can sit on their own line and carry parentheses of their
    // own, which would otherwise read as a method.
    .replace(/^[ \t]*@\w+(?:\([^)]*\))?[ \t]*$/gm, '');

  const names = new Set<string>();
  for (const [, name] of clean.matchAll(JAVA_METHOD)) {
    if (!NOT_A_METHOD.has(name as string)) names.add(name as string);
  }
  return [...names].sort();
}

/** `- (ret)first:(T)a second:(T)b` — the first selector segment names it. */
const OBJC_METHOD = /^[ \t]*[-+]\s*\([^)]*\)\s*(\w+)/gm;

/** `@property(...) Type *name;` — the last identifier before the semicolon. */
const OBJC_PROPERTY = /^[ \t]*@property\s*(?:\([^)]*\))?\s*[^;]*?(\w+)\s*;/gm;

/**
 * Member names declared by one Objective-C protocol.
 *
 * Optional members are included: `@optional` describes whether an implementer
 * must supply it, not whether the contract offers it, and the question here is
 * what the contract offers.
 *
 * Throws when the protocol is absent rather than returning an empty list. An
 * empty list would read as "this protocol has no members", which compares as a
 * total gap and looks like a finding instead of a broken lookup.
 */
export function parseObjcMembers(source: string, protocolName: string): string[] {
  const clean = withoutComments(source);
  const body = new RegExp(
    `@protocol\\s+${protocolName}\\b[^\\n]*\\n([\\s\\S]*?)@end`,
  ).exec(clean)?.[1];

  if (body === undefined) {
    throw new Error(
      `protocol ${protocolName} not found. A missing protocol must fail here ` +
        `rather than compare as an empty one, which reads as a total gap.`,
    );
  }

  const names = new Set<string>();
  for (const [, name] of body.matchAll(OBJC_METHOD)) names.add(name as string);
  for (const [, name] of body.matchAll(OBJC_PROPERTY)) names.add(name as string);
  return [...names].sort();
}
