/**
 * The bridge privacy scanner: no promise rejection or log line in a shipped
 * package may carry a native exception's message, reason,
 * `localizedDescription`, `userInfo`, `toString()` or stack, or a
 * user-supplied VALUE (an attribute value, a report summary or description, a
 * severity value, a path, a label, a filter's input, a network URL, a log
 * line). A class name (`e.getClass().getSimpleName()`, `NSStringFromClass`,
 * `exception.name`) is allowed. So is a developer-chosen IDENTIFIER -- an
 * attribute name, a report patch key, an event name, an option key: it is
 * API surface the app already put in the report as a key, not data.
 *
 * Why native logs matter as much as rejections: the SDK captures the app's own
 * log output (logcat, NSLog) into the report it uploads, so a "just logged"
 * exception message is not contained.
 *
 * This is a tokenizer-lite textual scanner, not a compiler. String and char
 * literal CONTENT and comments are masked to spaces first (length and
 * newlines kept), so a `(` inside a literal cannot desync the matching and a
 * comment cannot trip a rule; TypeScript template interpolations stay code.
 *
 * What it checks, per language:
 *
 * Java (`.java`):
 *   - Inside a `catch`, EVERY use of the caught variable is a violation except
 *     `X.getClass()`/`X?.getClass()` (then anything) or a bare argument to an
 *     audited helper (`JAVA_ALLOWED_HELPERS`). The bridge's own validation
 *     exceptions (`BadArgument`, `BadJson`) may also use `X.getMessage()` --
 *     nothing else -- because every site that BUILDS one is itself checked
 *     (next rule). The same whitelist applies to a parameter or local declared
 *     as `Throwable`/`*Exception`/`*Error` outside a catch.
 *   - `new BadArgument(...)`/`new BadJson(...)` messages may only concatenate
 *     literals, constants, the identifier `key`, `entry.getKey()`, the audited
 *     `malformedJsonMessage(...)`, or a `BadJson`/`BadArgument` catch
 *     variable's own `getMessage()`.
 *   - `.reject(...)` arguments may only be literals, constants, the
 *     identifiers `name`/`operation`, a `*.failureMessage(...)` result, or a
 *     `BadJson`/`BadArgument` catch variable's `getMessage()`; a reject with a
 *     single non-literal argument (the `reject(Throwable)` overload) and any
 *     non-null argument past code and message are violations.
 *   - Anywhere: `printStackTrace`, `Log.getStackTraceString`, `Log.wtf`, and
 *     a `Log.x(...)` whose last argument is a bare identifier (the
 *     `(tag, msg, Throwable)` overload, which prints the message and stack).
 *
 * Objective-C / Objective-C++ (`.m`, `.mm`, `.h`):
 *   - `localizedDescription`, `userInfo`, `reason`, `localizedFailureReason`,
 *     `localizedRecoverySuggestion`, `description`, `debugDescription`,
 *     `callStackSymbols` and C++ `what()` are never read -- dot or bracket
 *     syntax, whatever the receiver is named and wherever it came from --
 *     except inside the ONE audited helper, `BGSRNErrorMessage` in
 *     `BGSRNErrorMessage.m`, which returns `localizedDescription` only for an
 *     `NSError` in one of this bridge's own domains and a fixed string for any
 *     other. There is no provenance exemption: the old one was textual and was
 *     bypassed twice.
 *   - Inside `@catch (NSException *X)`, every use of `X` other than
 *     `X.class`/`[X class]`/`X.name`/`[X name]` or a bare argument to
 *     `BGSRNRejectException` is a violation; inside a C++ `catch (... &X)`,
 *     every use other than `typeid(X)`.
 *   - A variable declared `NSError *`/`NSError **`/`NSException *` may not
 *     appear in the arguments of a log or format call (`NSLog`, `os_log*`,
 *     `RCTLog*`, `printf`, `stringWithFormat:`, `initWithFormat:`,
 *     `appendFormat:`, `reject`) except as `X.domain`, `X.code`, `X.class`,
 *     `X.name` or a bare argument to `BGSRNErrorMessage`,
 *     `BGSRNReportErrorWireCode` or `NSStringFromClass`.
 *   - `reject(code, message, error)`: the third argument is always `nil` (a
 *     non-nil `NSError` has its `userInfo` serialised to JS), and the first
 *     two may only be literals, constants, the identifiers `name`/`operation`/
 *     `code`, `BGSRNErrorMessage(...)`, `BGSRNReportErrorWireCode(...)` or
 *     `[BGSRNReportOps failureMessageForOperation:...]`.
 *   - Every `NSError` the code builds is checked where it is built, because
 *     `BGSRNErrorMessage` hands an own-domain error's description on: an
 *     `errorWithDomain:`/`initWithDomain:` construction's `userInfo` is
 *     `nil` or a dictionary literal; every `NSLocalizedDescriptionKey` is a
 *     dictionary-literal entry whose value is a string literal or a named
 *     constant (reads only inside the audited reader); a
 *     `BGSRNErrorIdentifierKey` entry holds the identifier `key`.
 *
 * TypeScript (`.ts`, `.tsx`, the packages' `src`): every argument of
 * `new XError(...)`, `badArgument(...)`, `reject(...)` and `console.x(...)`
 * may only concatenate literals, constants, `Enum.Member`, `typeof X`,
 * `describeType(X)`, `errorName(X)` and the identifier-carrying names in
 * `TS_IDENTIFIER_NAMES`, including inside `${...}`. `toReportError` and
 * `toAttributeError` are exempt: they forward a native rejection's message,
 * which the native rules above keep value-free.
 *
 * KNOWN GAPS (stated, not hidden):
 *   - Kotlin (`.kt`) and Swift (`.swift`) are NOT understood: string
 *     interpolation (`"$e"`, `"\(error)"`) is invisible to the masking, and
 *     Swift's `catch` has no pattern. So a `.kt`/`.swift` source under a
 *     scanned root fails the scan outright ("does not understand that
 *     language yet") instead of being reported clean. The only exemption is a
 *     SwiftPM manifest named exactly `Package.swift`, which is build
 *     configuration, not runtime code.
 *   - A native Log/NSLog line that is not exception-derived and not a reject
 *     is not operand-checked: a future `Log.w(TAG, "x " + value)` built from a
 *     plain user value is caught by review, not by this scanner. Likewise an
 *     untyped Java lambda parameter (`(message, error) -> ...`) is only
 *     covered by the bare-last-argument `Log` rule.
 *   - The identifier allowlists are by NAME (`key`, `name`, ...). A variable
 *     with an allowlisted name that holds a value would pass.
 *   - Reflection/KVC (`valueForKey:@"userInfo"`) and macros are not seen.
 */
import { readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

export interface Violation {
  file: string;
  line: number;
  rule: string;
  snippet: string;
}

type Language = 'java' | 'objc' | 'ts';

type Scanner = (path: string, source: string) => Violation[];

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

const blank = (text: string): string => text.replace(/[^\n]/g, ' ');

/** Characters after which a `/` starts a regex literal rather than a division. */
const REGEX_PRECEDERS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';']);

function lastSignificant(out: string): string {
  const trimmed = out.trimEnd();
  return trimmed.charAt(trimmed.length - 1);
}

/**
 * Where the literal opened at `source[start]` ends: just past its closing
 * `quote`, or -- unterminated -- at the line break or the end of the source.
 * A string, char or regex literal never spans a line.
 */
function literalEnd(source: string, start: number, quote: string, inClassAware: boolean): number {
  let j = start + 1;
  let inClass = false;
  while (j < source.length) {
    const ch = source.charAt(j);
    if (ch === '\n') return j;
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (inClassAware && ch === '[') inClass = true;
    if (inClassAware && ch === ']') inClass = false;
    if (ch === quote && !inClass) return j + 1;
    j += 1;
  }
  return source.length;
}

/** A literal's text with its CONTENT blanked: the opening and any closing delimiter kept. */
function maskedLiteral(source: string, start: number, stop: number): string {
  const open = source.charAt(start);
  const body = source.slice(start + 1, stop);
  const closed = stop - start >= 2 && source.charAt(stop - 1) === open;
  return open + (closed ? blank(body.slice(0, -1)) + open : blank(body));
}

/**
 * Masks `source[from..)` until an unmatched `}` (when `stopAtBrace`) or the
 * end. Returns the masked text and the index it stopped at (an unmatched `}`
 * is not consumed).
 */
function maskFrom(source: string, from: number, lang: Language, stopAtBrace: boolean): [string, number] {
  let out = '';
  let i = from;
  let depth = 0;
  while (i < source.length) {
    const ch = source.charAt(i);
    const two = source.slice(i, i + 2);
    let stop = i + 1;
    if (two === '//') {
      const end = source.indexOf('\n', i);
      stop = end === -1 ? source.length : end;
      out += blank(source.slice(i, stop));
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(i, stop));
    } else if (ch === '"' || ch === "'") {
      stop = literalEnd(source, i, ch, false);
      out += maskedLiteral(source, i, stop);
    } else if (lang === 'ts' && ch === '`') {
      const [masked, end] = maskTemplate(source, i);
      out += masked;
      stop = end;
    } else if (lang === 'ts' && ch === '/' && REGEX_PRECEDERS.has(lastSignificant(out))) {
      stop = literalEnd(source, i, '/', true);
      out += maskedLiteral(source, i, stop);
    } else {
      if (ch === '}' && stopAtBrace && depth === 0) return [out, i];
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
      out += ch;
    }
    i = stop;
  }
  return [out, i];
}

/** A template literal: its text masked, each `${...}` kept as (masked) code. */
function maskTemplate(source: string, start: number): [string, number] {
  let out = '`';
  let i = start + 1;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === '`') return [out + '`', i + 1];
    if (ch === '\\') {
      out += blank(source.slice(i, i + 2));
      i += 2;
    } else if (source.slice(i, i + 2) === '${') {
      const [code, stop] = maskFrom(source, i + 2, 'ts', true);
      out += '${' + code + source.slice(stop, stop + 1);
      i = stop + 1;
    } else {
      out += blank(ch);
      i += 1;
    }
  }
  return [out, i];
}

/** Comments and literal CONTENTS replaced by spaces: same length, same line breaks. */
export function mask(source: string, lang: Language): string {
  return maskFrom(source, 0, lang, false)[0];
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
}

/** One file being scanned: its path, its source, and the masked copy the rules match against. */
interface Source {
  path: string;
  raw: string;
  masked: string;
}

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** Index of the bracket closing the one at `text[open]`, or `text.length` when it never closes. */
function closingIndex(text: string, open: number): number {
  const opener = text.charAt(open);
  const closer = PAIRS[opener];
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === opener) depth += 1;
    if (ch === closer) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/** Splits on `separator` at bracket depth 0, trimming each part. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch in PAIRS) depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === separator && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts;
}

/** The arguments of the call whose `(` is at `text[open]`. */
const argumentsAt = (text: string, open: number): string[] =>
  splitTopLevel(text.slice(open + 1, closingIndex(text, open)), ',');

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

function violation(src: Source, start: number, end: number, rule: string): Violation {
  return {
    file: src.path,
    line: lineOf(src.masked, start),
    rule,
    snippet: src.raw.slice(start, end).replace(/\s+/g, ' ').trim(),
  };
}

/** The call head (`promise.reject`, `Log.w`) of the innermost call enclosing `idx`, or ''. */
function enclosingCallName(text: string, idx: number): string {
  let depth = 0;
  for (let i = idx - 1; i >= 0; i -= 1) {
    const ch = text.charAt(i);
    if (ch === ')') depth += 1;
    if (ch === '(') {
      if (depth === 0) return (/[\w.]*$/.exec(text.slice(0, i).trimEnd()) as RegExpExecArray)[0];
      depth -= 1;
    }
  }
  return '';
}

/** Is `text[idx, idx+len)` a whole argument: only `(`/`,` before it and `)`/`,` after? */
function isBareArgument(text: string, idx: number, len: number): boolean {
  return /[(,]\s*$/.test(text.slice(0, idx)) && /^\s*[),]/.test(text.slice(idx + len));
}

/** A bare argument to a call whose full head, or its last `.` segment, is in `names`. */
function isBareArgumentTo(text: string, idx: number, len: number, names: ReadonlySet<string>): boolean {
  if (!isBareArgument(text, idx, len)) return false;
  const head = enclosingCallName(text, idx);
  return names.has(head) || names.has(head.slice(head.lastIndexOf('.') + 1));
}

/** What may sit between a function header's `)` and its body's `{`: a Java throws clause or a TS return type. */
const BODY_OPENER = /^\s*(?:throws\s+[\w.,\s]+|:\s*[^{;]+)?\{/;

/** The `{...}` body of the first definition matching `header` (a regex source ending before `(`). */
function functionBody(masked: string, header: string): Span | undefined {
  const re = new RegExp(`${header}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const close = closingIndex(masked, m.index + m[0].length - 1);
    const brace = BODY_OPENER.exec(masked.slice(close + 1));
    if (brace) {
      const start = close + brace[0].length;
      return { start, end: closingIndex(masked, start) };
    }
  }
  return undefined;
}

const within = (spans: readonly Span[] | undefined, idx: number): boolean =>
  spans !== undefined && spans.some((s) => idx >= s.start && idx <= s.end);

// ---------------------------------------------------------------------------
// Operands: what a message may be built from
// ---------------------------------------------------------------------------

interface Policy {
  lang: Language;
  /** Variables that, by this bridge's convention, hold an identifier, never a value. */
  identifiers: ReadonlySet<string>;
  /** Site-specific allowed forms (an audited helper call, ...), given the operand's position. */
  extra: (operand: string, at: number) => boolean;
}

const STRING_LITERAL = /^(?:@?"[^"\n]*"\s*)+$|^'[^'\n]*'$/;
const NUMBER = /^-?\d+(?:\.\d+)?$/;
const KEYWORD = /^(?:null|nil|true|false|undefined)$/;
const CONSTANT = /^(?:[A-Z][A-Z0-9_]*|k[A-Z]\w*|BGSRN[A-Z]\w*)$/;
const QUALIFIED_CONSTANT = /^[A-Z]\w*\.[A-Z]\w*$/;
const CAST = /^\((?:unsigned\s+)?\w+\)\s*/;
const CLASS_NAME = /^\w+\??\.getClass\(\)\.get(?:Simple)?Name\(\)$/;
const TS_TYPE_NAME = /^(?:typeof\s+[\w.]+|(?:describeType|errorName)\([\w.]*\))$/;
const OBJC_FORMAT = /^\[NSString\s+stringWithFormat:([\s\S]*)\]$/;

/** The code of every `${...}` interpolation in a masked template literal. */
function interpolations(template: string): string[] {
  const found: string[] = [];
  let i = template.indexOf('${');
  while (i !== -1) {
    const close = closingIndex(template, i + 1);
    found.push(template.slice(i + 2, close));
    i = template.indexOf('${', close);
  }
  return found;
}

function isAllowedOperand(text: string, policy: Policy, at: number): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith('(') && closingIndex(trimmed, 0) === trimmed.length - 1) {
    return isAllowedExpression(trimmed.slice(1, -1), policy, at);
  }
  const operand = trimmed.replace(CAST, '');
  if (operand === '') return true; // a trailing comma, or no argument at all
  if ([STRING_LITERAL, NUMBER, KEYWORD, CONSTANT, QUALIFIED_CONSTANT].some((re) => re.test(operand))) return true;
  if (policy.identifiers.has(operand) || policy.extra(operand, at)) return true;
  if (policy.lang === 'java') return CLASS_NAME.test(operand);
  if (policy.lang === 'ts') {
    if (/^`[\s\S]*`$/.test(operand)) return interpolations(operand).every((code) => isAllowedExpression(code, policy, at));
    return TS_TYPE_NAME.test(operand);
  }
  const format = OBJC_FORMAT.exec(operand);
  if (format === null) return false;
  const [literal, ...args] = splitTopLevel(format[1] as string, ',');
  return STRING_LITERAL.test(literal as string) && args.every((arg) => isAllowedOperand(arg, policy, at));
}

/** Every `+`-joined operand of `expression` is allowed. */
function isAllowedExpression(expression: string, policy: Policy, at: number): boolean {
  return splitTopLevel(expression, '+').every((operand) => isAllowedOperand(operand, policy, at));
}

/**
 * Every call matching `head` (a global regex ending in `(`) with an argument
 * `policy` does not allow. A match inside `skip`, or one that is a definition
 * (its `)` followed by a body), is not a call.
 */
function checkCallArguments(src: Source, head: RegExp, policy: Policy, rule: string, skip?: readonly Span[]): Violation[] {
  const violations: Violation[] = [];
  let m: RegExpExecArray | null;
  while ((m = head.exec(src.masked))) {
    const open = m.index + m[0].length - 1;
    const close = closingIndex(src.masked, open);
    if (within(skip, m.index) || BODY_OPENER.test(src.masked.slice(close + 1))) continue;
    if (!argumentsAt(src.masked, open).every((arg) => isAllowedExpression(arg, policy, open))) {
      violations.push(violation(src, m.index, close + 1, rule));
    }
  }
  return violations;
}

function patternViolations(src: Source, patterns: ReadonlyArray<[RegExp, string]>, skip?: Span): Violation[] {
  const violations: Violation[] = [];
  for (const [re, rule] of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src.masked))) {
      if (skip === undefined || !within([skip], m.index)) violations.push(violation(src, m.index, m.index + m[0].length, rule));
    }
  }
  return violations;
}

/**
 * Every occurrence of `name` in `scope` that `isAllowed` rejects. One right
 * after `.` is a member of another receiver (`Log.e` when the variable is
 * `e`), not the variable, and is skipped.
 */
function usesOutsideWhitelist(
  src: Source,
  scope: Span,
  name: string,
  isAllowed: (text: string, idx: number, len: number) => boolean,
  rule: string,
): Violation[] {
  const violations: Violation[] = [];
  const re = new RegExp(`\\b${name}\\b`, 'g');
  re.lastIndex = scope.start;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src.masked)) && m.index < scope.end) {
    if (src.masked.charAt(m.index - 1) === '.' || isAllowed(src.masked, m.index, name.length)) continue;
    const lineStart = src.masked.lastIndexOf('\n', m.index) + 1;
    const lineEnd = src.masked.indexOf('\n', m.index);
    violations.push(violation(src, lineStart, lineEnd === -1 ? src.masked.length : lineEnd, rule));
  }
  return violations;
}

/** The inside of the bracket that ends the `head` text matched at `at` (a catch's `{`, a call's `(`). */
function blockAfter(masked: string, at: number, head: string): Span {
  const open = at + head.length - 1;
  return { start: open + 1, end: closingIndex(masked, open) };
}

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

/** The bridge's own validation exceptions, whose construction sites are checked. */
const JAVA_SAFE_TYPES = new Set(['BadArgument', 'BadJson']);

/**
 * Calls a caught/declared exception may be handed to whole. Each is audited:
 * the two reject helpers log the class name and reject with a fixed message;
 * `malformedJsonMessage` keeps only a position from the message (its body is
 * exempt, below); `diagnostics.report` is `WrapperChannelHolder`'s sink, whose
 * production implementation logs the class name only (matched by its
 * receiver-qualified name, so an unrelated `x.report(e)` is not exempt); and
 * `Bugsee.logException`/`logUnhandledException` IS the product: the JS
 * exception reported to Bugsee, not a log line or a rejection.
 */
const JAVA_ALLOWED_HELPERS = new Set([
  'rejectReportFailure',
  'rejectAttributeFailure',
  'malformedJsonMessage',
  'diagnostics.report',
  'Bugsee.logException',
  'Bugsee.logUnhandledException',
]);

/** `[file basename, method]` bodies audited by hand to read an exception's message safely. */
const JAVA_AUDITED_BODIES: ReadonlyArray<[string, string]> = [['BridgeJson.java', 'malformedJsonMessage']];

const JAVA_CATCH = /catch\s*\(\s*(?:final\s+)?([\w.]+(?:\s*\|\s*[\w.]+)*)\s+(\w+)\s*\)\s*\{/g;
const JAVA_THROWABLE_DECLARATION =
  /(?<![\w.])((?:\w+\.)*(?:\w*Exception|\w*Error|Throwable))\s+(\w+)\s*(?=[,)=;])/g;
const AFTER_CATCH_OPEN = /catch\s*\([\w.|\s]*$/;

const shortType = (type: string): string => type.split('.').pop() ?? type;

function isAllowedJavaUse(text: string, idx: number, len: number, safeType: boolean): boolean {
  const suffix = text.slice(idx + len);
  if (/^\s*\??\.getClass\(/.test(suffix)) return true;
  if (safeType && /^\s*\.getMessage\(\)/.test(suffix)) return true;
  return isBareArgumentTo(text, idx, len, JAVA_ALLOWED_HELPERS);
}

/**
 * Where a non-catch declaration at `at` is visible: the method body for a
 * parameter (none for an abstract one), else the rest of its block.
 */
function declarationScope(masked: string, at: number): Span | undefined {
  let depth = 0;
  for (let i = at - 1; i >= 0; i -= 1) {
    const ch = masked.charAt(i);
    if (ch === ')' || ch === '}') depth += 1;
    if (ch !== '(' && ch !== '{') continue;
    if (depth > 0) {
      depth -= 1;
      continue;
    }
    if (ch === '{') return { start: at, end: closingIndex(masked, i) };
    const close = closingIndex(masked, i);
    const brace = BODY_OPENER.exec(masked.slice(close + 1));
    if (brace === null) return undefined;
    const start = close + brace[0].length;
    return { start, end: closingIndex(masked, start) };
  }
  return undefined;
}

export function scanJava(path: string, raw: string): Violation[] {
  const src: Source = { path, raw, masked: mask(raw, 'java') };
  const { masked } = src;
  const audited = JAVA_AUDITED_BODIES.filter(([file]) => basename(path) === file)
    .map(([, method]) => functionBody(masked, `\\b${method}`))
    .filter((span): span is Span => span !== undefined);
  const violations: Violation[] = [];

  const safeCatches: Array<Span & { name: string }> = [];
  let m: RegExpExecArray | null;
  JAVA_CATCH.lastIndex = 0;
  while ((m = JAVA_CATCH.exec(masked))) {
    const types = (m[1] as string).split('|').map((t) => shortType(t.trim()));
    const name = m[2] as string;
    const scope = blockAfter(masked, m.index, m[0]);
    const safe = types.every((t) => JAVA_SAFE_TYPES.has(t));
    if (safe) safeCatches.push({ ...scope, name });
    violations.push(
      ...usesOutsideWhitelist(src, scope, name, (t, i, l) => isAllowedJavaUse(t, i, l, safe),
        `caught ${types.join('|')} \`${name}\` used other than by its class name or an audited helper`),
    );
  }

  JAVA_THROWABLE_DECLARATION.lastIndex = 0;
  while ((m = JAVA_THROWABLE_DECLARATION.exec(masked))) {
    const scope = declarationScope(masked, m.index);
    if (scope === undefined || AFTER_CATCH_OPEN.test(masked.slice(0, m.index)) || within(audited, scope.start)) continue;
    const name = m[2] as string;
    violations.push(
      ...usesOutsideWhitelist(src, { start: Math.max(scope.start, m.index + m[0].length), end: scope.end }, name,
        (t, i, l) => isAllowedJavaUse(t, i, l, false),
        `${shortType(m[1] as string)} \`${name}\` used other than by its class name or an audited helper`),
    );
  }

  const safeMessage = (operand: string, at: number): boolean => {
    const owner = /^(\w+)\.getMessage\(\)$/.exec(operand)?.[1];
    return safeCatches.some((c) => c.name === owner && within([c], at));
  };
  violations.push(
    ...checkCallArguments(src, /\bnew\s+(?:\w+\.)?(?:BadArgument|BadJson)\s*\(/g, {
      lang: 'java',
      identifiers: new Set(['key']),
      extra: (op, at) => op === 'entry.getKey()' || /^malformedJsonMessage\([\w\s,.()]*\)$/.test(op) || safeMessage(op, at),
    }, 'a BadArgument/BadJson message built from something other than literals and identifiers'),
    ...checkCallArguments(src, /\.reject\s*\(/g, {
      lang: 'java',
      identifiers: new Set(['name', 'operation']),
      extra: (op, at) => /^(?:\w+\.)?failureMessage\(\w+\)$/.test(op) || safeMessage(op, at),
    }, 'a reject argument other than a literal, an identifier or a fixed failure message'),
  );

  const rejectCall = /\.reject\s*\(/g;
  while ((m = rejectCall.exec(masked))) {
    const open = m.index + m[0].length - 1;
    const args = argumentsAt(masked, open);
    if ((args.length === 1 && !STRING_LITERAL.test(args[0] as string)) || args.slice(2).some((a) => a !== 'null')) {
      violations.push(violation(src, m.index, closingIndex(masked, open) + 1,
        'reject(Throwable), or a reject carrying more than a code and a message'));
    }
  }

  const logCall = /\bLog\.\w+\s*\(/g;
  while ((m = logCall.exec(masked))) {
    const open = m.index + m[0].length - 1;
    const args = argumentsAt(masked, open);
    if (args.length >= 3 && /^[A-Za-z_]\w*$/.test(args[args.length - 1] as string)) {
      violations.push(violation(src, m.index, closingIndex(masked, open) + 1,
        'Log call with a bare Throwable last argument (prints its message and stack)'));
    }
  }

  violations.push(
    ...patternViolations(src, [
      [/\.printStackTrace\s*\(/g, 'printStackTrace()'],
      [/\bLog\.getStackTraceString\s*\(/g, 'Log.getStackTraceString(...)'],
      [/\bLog\.wtf\s*\(/g, 'Log.wtf(...)'],
    ]),
  );
  return violations;
}

// ---------------------------------------------------------------------------
// Objective-C / Objective-C++
// ---------------------------------------------------------------------------

/** The one audited reader of `localizedDescription`/`userInfo`: this function, in this file. */
const OBJC_AUDITED_FILE = 'BGSRNErrorMessage.m';
const OBJC_AUDITED_FUNCTION = 'BGSRNErrorMessage';

/** `X.member` or `[X member]`, but not a `member:` selector label. */
const objcRead = (member: string): RegExp => new RegExp(`(?:\\.\\s*|\\[\\s*[\\w.]+\\s+)${member}\\b(?!\\s*:)`, 'g');

const OBJC_ERROR_READS: ReadonlyArray<[RegExp, string]> = [
  [objcRead('localizedDescription'), 'localizedDescription read outside BGSRNErrorMessage'],
  [objcRead('userInfo'), 'userInfo read outside BGSRNErrorMessage'],
];

const OBJC_ALWAYS_WRONG: ReadonlyArray<[RegExp, string]> = [
  [objcRead('reason'), 'NSException reason read'],
  [/\blocalizedFailureReason\b/g, 'localizedFailureReason read'],
  [/\blocalizedRecoverySuggestion\b/g, 'localizedRecoverySuggestion read'],
  [objcRead('debugDescription'), 'debugDescription read'],
  [objcRead('description'), 'description read'],
  [/\bcallStack(?:Symbols|ReturnAddresses)\b/g, 'exception call stack read'],
  [/\.\s*what\s*\(\s*\)/g, 'std::exception::what() read'],
];

const OBJC_CATCH = /@catch\s*\(\s*NSException\s*\*\s*(\w+)\s*\)\s*\{/g;
const CPP_CATCH = /\bcatch\s*\(\s*(?:const\s+)?[\w:]+\s*&\s*(\w+)\s*\)\s*\{/g;
const OBJC_ERROR_DECLARATION =
  /\bNS(?:Error|Exception)\s*\*+\s*(?:(?:_Nullable|_Nonnull|__autoreleasing|nullable)\s*\**\s*)*\)?\s*(\w+)/g;
const OBJC_FORMAT_SINKS = /\b(?:NSLog|os_log\w*|RCTLog\w*|printf|reject)\s*\(|\b(?:stringWithFormat|initWithFormat|appendFormat)\s*:/g;
const OBJC_ERROR_HELPERS = new Set(['BGSRNErrorMessage', 'BGSRNReportErrorWireCode', 'NSStringFromClass']);
const OBJC_REJECT_HELPERS = new Set(['BGSRNRejectException']);
const OBJC_TYPE_MEMBERS = /^(?:class|name|domain|code)\b/;

function isAllowedObjcUse(text: string, idx: number, len: number, helpers: ReadonlySet<string>): boolean {
  const suffix = text.slice(idx + len).trimStart();
  if (suffix.startsWith('.') && OBJC_TYPE_MEMBERS.test(suffix.slice(1).trimStart())) return true;
  if (/\[\s*$/.test(text.slice(0, idx)) && /^(?:class|name|domain|code)\s*\]/.test(suffix)) return true;
  return isBareArgumentTo(text, idx, len, helpers);
}

function isAllowedCppUse(text: string, idx: number, len: number): boolean {
  return isBareArgument(text, idx, len) && enclosingCallName(text, idx) === 'typeid';
}

/** The argument span of a format sink matched at `at`: `(...)` for a C call, up to the closing `]` for a selector. */
function sinkArguments(masked: string, at: number, head: string): Span {
  if (head.endsWith('(')) return blockAfter(masked, at, head);
  let depth = 0;
  let i = at;
  while (i < masked.length) {
    const ch = masked.charAt(i);
    if (ch === '[' || ch === '(') depth += 1;
    if (ch === ']' || ch === ')') {
      if (depth === 0) break;
      depth -= 1;
    }
    i += 1;
  }
  return { start: at + head.length, end: i };
}

/** The value of the dictionary entry whose key ends at `at` (`KEY : value`), or undefined when `at` is not an entry key. */
function entryValue(masked: string, at: number): string | undefined {
  const colon = /^\s*:/.exec(masked.slice(at));
  if (colon === null) return undefined;
  const start = at + colon[0].length;
  let depth = 0;
  for (let i = start; i < masked.length; i += 1) {
    const ch = masked.charAt(i);
    if (ch in PAIRS) depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return masked.slice(start, i).trim();
      depth -= 1;
    }
    if (ch === ',' && depth === 0) return masked.slice(start, i).trim();
  }
  return masked.slice(start).trim();
}

/** The `userInfo:` argument of the message send a `...WithDomain:` match at `at` belongs to. */
function userInfoArgument(masked: string, at: number): string | undefined {
  let depth = 0;
  let end = at;
  while (end < masked.length) {
    const ch = masked.charAt(end);
    if (ch in PAIRS) depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth -= 1;
    }
    end += 1;
  }
  const send = masked.slice(at, end);
  const label = /\buserInfo\s*:/.exec(send);
  return label === null ? undefined : send.slice(label.index + label[0].length).trim();
}

const DESCRIPTION_POLICY: Policy = { lang: 'objc', identifiers: new Set(), extra: () => false };
const IDENTIFIER_POLICY: Policy = { lang: 'objc', identifiers: new Set(['key']), extra: () => false };

/**
 * Every `NSError` construction, checked where it is built: `BGSRNErrorMessage`
 * hands an own-domain error's description on, so that description must be
 * visibly value-free wherever, and however, the error is made.
 */
function errorConstructions(src: Source, reader: Span | undefined): Violation[] {
  const { masked } = src;
  const violations: Violation[] = [];
  let m: RegExpExecArray | null;
  const construction = /\b(?:errorWithDomain|initWithDomain)\s*:/g;
  while ((m = construction.exec(masked))) {
    const info = userInfoArgument(masked, m.index);
    if (info !== undefined && info !== 'nil' && !info.startsWith('@{')) {
      violations.push(violation(src, m.index, m.index + m[0].length,
        'an NSError built with a userInfo the scanner cannot see (nil or a dictionary literal only)'));
    }
  }
  const description = /\bNSLocalizedDescriptionKey\b/g;
  while ((m = description.exec(masked))) {
    if (reader !== undefined && within([reader], m.index)) continue;
    const value = entryValue(masked, m.index + m[0].length);
    if (value === undefined || !isAllowedOperand(value, DESCRIPTION_POLICY, m.index)) {
      violations.push(violation(src, m.index, m.index + m[0].length,
        'an NSError description that is not a string literal or a named constant'));
    }
  }
  const identifier = /\bBGSRNErrorIdentifierKey\s*:/g;
  while ((m = identifier.exec(masked))) {
    const value = entryValue(masked, m.index + m[0].length - 1) as string;
    if (!isAllowedOperand(value, IDENTIFIER_POLICY, m.index)) {
      violations.push(violation(src, m.index, m.index + m[0].length,
        'a BGSRNErrorIdentifierKey entry that is not the identifier `key`'));
    }
  }
  return violations;
}

export function scanObjC(path: string, raw: string): Violation[] {
  const src: Source = { path, raw, masked: mask(raw, 'objc') };
  const { masked } = src;
  const helper = basename(path) === OBJC_AUDITED_FILE ? functionBody(masked, `\\b${OBJC_AUDITED_FUNCTION}`) : undefined;
  const violations: Violation[] = [
    ...patternViolations(src, OBJC_ERROR_READS, helper),
    ...patternViolations(src, OBJC_ALWAYS_WRONG),
  ];

  let m: RegExpExecArray | null;
  OBJC_CATCH.lastIndex = 0;
  while ((m = OBJC_CATCH.exec(masked))) {
    const name = m[1] as string;
    violations.push(
      ...usesOutsideWhitelist(src, blockAfter(masked, m.index, m[0]), name, (t, i, l) => isAllowedObjcUse(t, i, l, OBJC_REJECT_HELPERS),
        `caught NSException \`${name}\` used other than by its class/name or BGSRNRejectException`),
    );
  }
  CPP_CATCH.lastIndex = 0;
  while ((m = CPP_CATCH.exec(masked))) {
    const name = m[1] as string;
    violations.push(
      ...usesOutsideWhitelist(src, blockAfter(masked, m.index, m[0]), name, isAllowedCppUse,
        `caught C++ exception \`${name}\` used other than by typeid()`),
    );
  }

  // An NSError/NSException object never reaches a log, format or reject call whole.
  const errorNames = new Set<string>();
  OBJC_ERROR_DECLARATION.lastIndex = 0;
  while ((m = OBJC_ERROR_DECLARATION.exec(masked))) errorNames.add(m[1] as string);
  OBJC_FORMAT_SINKS.lastIndex = 0;
  while ((m = OBJC_FORMAT_SINKS.exec(masked))) {
    const span = sinkArguments(masked, m.index, m[0]);
    for (const name of errorNames) {
      violations.push(
        ...usesOutsideWhitelist(src, span, name,
          (t, i, l) => t.charAt(i - 1) === '&' || isAllowedObjcUse(t, i, l, OBJC_ERROR_HELPERS),
          `NSError/NSException \`${name}\` formatted into a log, format or reject call`),
      );
    }
  }

  const rejectCall = /\breject\s*\(/g;
  while ((m = rejectCall.exec(masked))) {
    const open = m.index + m[0].length - 1;
    const args = argumentsAt(masked, open);
    if (args.length === 3 && args[2] !== 'nil') {
      violations.push(violation(src, m.index, closingIndex(masked, open) + 1,
        "reject's third argument is not nil (RN serialises the NSError's userInfo into JS)"));
    }
  }

  violations.push(
    ...checkCallArguments(src, /\breject\s*\(/g, {
      lang: 'objc',
      identifiers: new Set(['name', 'operation', 'code']),
      extra: (op) => /^(?:BGSRNErrorMessage|BGSRNReportErrorWireCode)\(\w+\)$/.test(op) ||
        /^\[BGSRNReportOps\s+failureMessageForOperation:(?:operation|@"[^"]*")\]$/.test(op),
    }, 'a reject argument other than a literal, an identifier or an audited message'),
  );

  violations.push(...errorConstructions(src, helper));
  return violations;
}

// ---------------------------------------------------------------------------
// TypeScript
// ---------------------------------------------------------------------------

/**
 * Variables that, in this package's validation code, hold an identifier or a
 * type description -- never the rejected value: a field/key/option/appearance
 * name, a method name, a structural key path built from keys and indices
 * (`keyPath`; not `path`, which elsewhere is a file path -- a value), a type
 * kind, an index, the platform name.
 */
const TS_IDENTIFIER_NAMES = new Set(['name', 'key', 'field', 'method', 'kind', 'keyPath', 'index', 'i', 'platform']);

/**
 * Bodies not checked: the two that forward a native rejection's own message
 * (the native rules keep it value-free), and the `badArgument` helpers, which
 * only forward their parameter -- every CALL of `badArgument` is checked.
 */
const TS_AUDITED_FUNCTIONS = ['toReportError', 'toAttributeError', 'badArgument'];

const TS_SINKS = /\bnew\s+\w*Error\s*\(|\bbadArgument\s*\(|\breject\s*\(|\bconsole\s*\.\s*\w+\s*\(/g;

export function scanTs(path: string, raw: string): Violation[] {
  const src: Source = { path, raw, masked: mask(raw, 'ts') };
  const audited = TS_AUDITED_FUNCTIONS.map((name) => functionBody(src.masked, `\\bfunction\\s+${name}`))
    .filter((span): span is Span => span !== undefined);
  return checkCallArguments(src, TS_SINKS, { lang: 'ts', identifiers: TS_IDENTIFIER_NAMES, extra: () => false },
    'an error or console message built from something other than literals, identifiers and type names', audited);
}

// ---------------------------------------------------------------------------
// The trees
// ---------------------------------------------------------------------------

/** Never scanned: tests, mocks, and build output a local build can leave under a root. */
export const SKIP_DIRECTORIES = new Set(['__tests__', '__mocks__', 'Tests', '.swiftpm', '.build', 'build', 'Pods', 'node_modules']);

const SCANNERS: Record<string, Scanner> = {
  '.java': scanJava,
  '.m': scanObjC,
  '.mm': scanObjC,
  '.h': scanObjC,
  '.ts': scanTs,
  '.tsx': scanTs,
};

/** Data files a scanned root holds: not runtime code. */
const NON_SOURCE_EXTENSIONS = new Set(['.resolved', '.json']);

const NOT_UNDERSTOOD = new Map([
  ['.kt', 'Kotlin'],
  ['.swift', 'Swift'],
]);

/**
 * The scanner for `file`; null for a file that is not runtime code (a data
 * file, a SwiftPM manifest named exactly `Package.swift`); or, as a string,
 * why the file cannot be scanned -- which fails the tree test.
 */
export function scannerFor(file: string): Scanner | string | null {
  const ext = extname(file);
  const scanner = SCANNERS[ext];
  if (scanner !== undefined) return scanner;
  if (basename(file) === 'Package.swift' || NON_SOURCE_EXTENSIONS.has(ext)) return null;
  const language = NOT_UNDERSTOOD.get(ext);
  if (language !== undefined) {
    return `${language} source: the raw-message scanner does not understand ${language} yet ` +
      '(string interpolation, catch syntax), so it cannot vouch for this file';
  }
  return `unknown file kind "${ext}": decide whether it is runtime code and teach the scanner`;
}

/** Every file under `dir`, skipping `SKIP_DIRECTORIES`. */
export function walk(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRECTORIES.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}
