/**
 * Adapted from stacktrace-parser (https://github.com/errwischt/stacktrace-parser),
 * which 6.x's `stack-trace-parse.ts` was itself based on. The MIT notice below
 * is carried over verbatim, unmodified.
 *
 * MIT License
 *
 * Copyright (c) 2014-2019 Georg Tavonius
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * One parsed line of a JS stack (or a React `componentStack`). A line this
 * SDK's parser does not recognise produces no frame at all -- there is no
 * "unparsed" shape to fall back to.
 */
export interface ParsedFrame {
  raw: string;
  file: string | null;
  methodName: string | null;
  lineNumber: number | null;
  column: number | null;
}

/**
 * `error.stack` carries the error's own **message**, which is arbitrary,
 * attacker-reachable data (a server body, user input, a pretty-printed
 * dump). `buildExceptionPayload` runs synchronously on the fatal path,
 * before React Native's own handler (Phase 7 R11), so a slow parse there
 * freezes the app instead of reporting the crash. Two bounds keep every
 * regex below fed a small, fixed-size string regardless of how large the
 * real input is:
 *
 * - `STACK_MAX_INPUT_LENGTH` bounds the whole stack before it is even split
 *   into lines -- a stack with an enormous number of lines is cut here.
 * - `STACK_MAX_LINE_LENGTH` bounds each individual line before any pattern
 *   runs on it -- a single enormous line is cut here.
 *
 * A cap alone is not the guarantee it first looks like: a genuinely
 * quadratic pattern at `STACK_MAX_LINE_LENGTH` (2 KiB) still costs a few
 * milliseconds, and that cost multiplies by every line in a 64 KiB stack,
 * and again by every node in the cause chain (review N1 -- the first
 * version of this comment claimed "low single-digit milliseconds" as a
 * consequence of the cap alone, which a 64 KiB stack and a full cause
 * chain both disproved). Every pattern below is therefore also written,
 * and directly timed against multi-megabyte adversarial input (see
 * `stack.test.ts`'s "bounded against a hostile stack" cases and this
 * file's own history) to be linear in the line's length on its own, not
 * merely fast because it is short -- so the caps below bound the *total*
 * work by their product, not by one pattern's worst case surviving
 * unnoticed at small sizes. `EXCEPTION_MAX_TOTAL_STACK_LENGTH` in
 * `payload.ts` bounds the sum across every node in a cause chain plus
 * `componentStack`, for the same reason: bounding each node alone still
 * lets the total multiply by the chain's depth.
 */
export const STACK_MAX_INPUT_LENGTH = 64 * 1024;
export const STACK_MAX_LINE_LENGTH = 2 * 1024;

// Every pattern below is matched against an already-`trim()`-ed line (see
// `parseStack`), so none of them need their own leading `^\s*`/trailing
// `\s*$`. That removal is not just tidying: a `\s*` at one end, retried at
// every position a *different* flexible quantifier backtracks to, is
// exactly what made the previous versions of these patterns super-linear on
// a padded-with-spaces line. A single upfront `trim()` handles every
// leading/trailing-whitespace case once, for all four patterns, in O(line
// length).

// Chrome/V8 (and a Hermes frame served from a Metro dev-server URL, which has
// the same "at name (url:line:col)" shape): the file must start with one of
// these recognised schemes/paths, which is what lets a native/no-location
// frame ("at forEach (native)") and a real file both match one pattern. The
// name group excludes `(`: a lazy `(.*?)` there let `(` (or ` (`) followed
// by a whitelisted scheme act as a fresh candidate split, anywhere in the
// line, each needing its own O(line length) scan by the file group to fail
// -- quadratic overall (review N1; measured 4-5 ms on a crafted 2 KiB line,
// which a 64 KiB stack or a chain then multiplies well past budget). A
// frame's own method name is never expected to contain `(` (a real one,
// `eval at foo (bar.js:1:2)`, has its `(` only in the *file* half, which
// this group never touches); the fix is exact, not a lossy workaround.
const CHROME_RE =
  /^at ([^(]*?) ?\(((?:file|https?|blob|chrome-extension|native|eval|webpack|<anonymous>|\/|[a-z]:\\|\\\\).*?)(?::(\d+))?(?::(\d+))?\)?$/i;

// A Hermes release frame whose file contains parentheses -- an iOS app
// bundle such as "My App (Beta).app" -- or an empty name ("at  (address
// at ...)", the literal shape a Hermes anonymous release frame has: an
// empty name still leaves the format string's own separating space, so
// there are two spaces before the parenthesis). NODE_PAREN_RE below
// excludes parens from its file group specifically to avoid competing
// with its name group over the same characters (review N1); once the
// literal "address at " marker matches, there is no other flexible
// quantifier left for the file group to compete with, so it can safely
// allow parens here (measured linear: 0-5 ms even at 1 MiB of adversarial
// parens/colons with no valid ending). Tried before the general
// NODE_PAREN_RE, as the more specific shape (review N3; round 1's removal
// of the original, dedicated `HERMES_ADDRESS_RE` lost this case along with
// the then-redundant rest of it).
const HERMES_ADDRESS_PAREN_RE = /^at ([^\s(][^(]*?)? \((address at .*?):(\d+)(?::(\d+))?\)$/i;

// A V8/Hermes frame with no recognised scheme: "at name (file:line:col)"
// where the file is a relative bundle-internal path such as
// `index.android.bundle` or `InternalBytecode.js` (CHROME_RE's scheme
// whitelist rejects these) -- which also covers a Hermes release frame,
// "at name (address at file:line:col)", identically, when neither the name
// nor the file contain parentheses (see `HERMES_ADDRESS_PAREN_RE` above
// for when they do): the file group here is unrestricted (but for the
// parens `HERMES_ADDRESS_PAREN_RE` already tries first), so it captures
// "address at file" as one string exactly as a dedicated Hermes pattern
// would (`fileKey`/`cleanSource` then strip the "address at " prefix the
// same way). Or "at file:line:col" with no name and no parentheses at all
// (an anonymous top-level V8 frame). 6.x's `nodeRe`, split into two
// patterns rather than one with an optional " (" -- an optional
// single-character separator, tried at every position a same-shaped inner
// group could also stop at, reintroduces the same super-linear search C1
// fixes elsewhere (measured: the combined form hung past 3 s on a 1 MB
// adversarial "at /x" + spaces + "x" line with no trailing digits; each
// split half returns in under 5 ms on the same input). Tried after
// Chrome/V8 and Hermes-address-with-parens, and before JSC.
const NODE_PAREN_RE = /^at ([^\s(][^(]*?)? \(([^()]*?):(\d+)(?::(\d+))?\)$/i;
const NODE_BARE_RE = /^at ([^()]*?):(\d+)(?::(\d+))?$/i;

// JavaScriptCore: "name@file:line:col" (a name may itself contain spaces,
// as JSC's own "global code" frame does), "@file:line:col" (an anonymous
// frame -- an empty name, not one starting with whitespace), or just
// "file:line:col". Real captured JSC output has all three (review M2). The
// name, when non-empty, must start with a non-space, non-`@` character so
// it cannot start mid-run of the padding a hostile message might contain.
const JSC_RE = /^(?:([^@\s][^@]*)?@)?(\S.*?):(\d+)(?::(\d+))?$/i;

// A React `componentStack` line: "in ComponentName (at File.js:10)". Unlike
// the file-then-line-then-column groups above, whose separators are single
// literal characters, the name and the parenthesised part are separated by
// arbitrary whitespace in real output -- but that separator is `\s*`
// (matched inside the component-name group itself, then trimmed off in
// `parseComponentStack`) rather than its own quantifier between two other
// flexible groups: measured, a *separate* `\s*` there hung past 3 s on a
// 1 MB "in " + spaces + "x" line (the review's own C1 example), because it
// and the leading `in\s+` could both keep retrying the same run of spaces
// against each other. The file group has the same guard for the same
// reason: `\(at\s+` is followed by a file group whose first character must
// be non-space, so `\s+` and the file group cannot both keep re-trying the
// same run of spaces between "at" and the file either (review N1; the
// version without this guard measured 2 ms on a crafted 2 KiB line, which
// a chain of them then multiplies past budget). Both forms return in low
// single-digit milliseconds even at 1 MiB.
const COMPONENT_STACK_RE = /^in\s+([^\s(][^(]*?)?\(at\s+([^\s()][^()]*?):(\d+)(?::(\d+))?\)$/i;

const UNKNOWN = '<unknown>';

function parseChrome(line: string): ParsedFrame | null {
  const parts = CHROME_RE.exec(line);
  if (!parts) {
    return null;
  }

  // Group 2 is mandatory in CHROME_RE, so it is always captured on a match.
  const file = parts[2] as string;
  const isNative = file.indexOf('native') === 0;

  return {
    raw: line,
    file: isNative ? null : file,
    methodName: parts[1] || null,
    lineNumber: parts[3] ? Number(parts[3]) : null,
    column: parts[4] ? Number(parts[4]) : null,
  };
}

function parseNode(line: string): ParsedFrame | null {
  const addressParen = HERMES_ADDRESS_PAREN_RE.exec(line);
  if (addressParen) {
    return {
      raw: line,
      // Group 2 is mandatory in HERMES_ADDRESS_PAREN_RE, so it is always captured on a match.
      file: addressParen[2] as string,
      methodName: addressParen[1] || null,
      lineNumber: Number(addressParen[3]),
      column: addressParen[4] ? Number(addressParen[4]) : null,
    };
  }

  const paren = NODE_PAREN_RE.exec(line);
  if (paren) {
    return {
      raw: line,
      // Group 2 is mandatory in NODE_PAREN_RE, so it is always captured on a match.
      file: paren[2] as string,
      methodName: paren[1] || null,
      lineNumber: Number(paren[3]),
      column: paren[4] ? Number(paren[4]) : null,
    };
  }

  const bare = NODE_BARE_RE.exec(line);
  if (!bare) {
    return null;
  }

  return {
    raw: line,
    // Group 1 is mandatory in NODE_BARE_RE, so it is always captured on a match.
    file: bare[1] as string,
    methodName: null,
    lineNumber: Number(bare[2]),
    column: bare[3] ? Number(bare[3]) : null,
  };
}

function parseJsc(line: string): ParsedFrame | null {
  const parts = JSC_RE.exec(line);
  if (!parts) {
    return null;
  }

  // Group 2 is mandatory in JSC_RE, so it is always captured on a match.
  const file = parts[2] as string;

  // A bare match (no "@" anywhere in the line -- not even an empty name
  // before one) whose "file" contains ": " is a "Name: message" header
  // line that stripKnownHeader could not identify (its name/message no
  // longer match the stack, e.g. `message` was reassigned after the stack
  // was captured), not a real file: a real path never contains ": '
  // (review N2). `line.includes('@')` -- not `parts[1]` -- is the right
  // check: an explicit empty name ("@file:1:2", a genuine JSC anonymous
  // frame) also leaves `parts[1]` undefined, but must still be kept.
  if (!line.includes('@') && file.includes(': ')) {
    return null;
  }

  return {
    raw: line,
    file,
    methodName: parts[1] || null,
    lineNumber: Number(parts[3]),
    column: parts[4] ? Number(parts[4]) : null,
  };
}

function parseComponentStack(line: string): ParsedFrame | null {
  const parts = COMPONENT_STACK_RE.exec(line);
  if (!parts) {
    return null;
  }

  // The component-name group has no separator of its own before "(at" (see
  // COMPONENT_STACK_RE's comment), so it absorbs any whitespace before the
  // parenthesis as part of its own match; trim that off here instead.
  const name = parts[1]?.trimEnd();

  return {
    raw: line,
    // Group 2 is mandatory in COMPONENT_STACK_RE, so it is always captured on a match.
    file: parts[2] as string,
    methodName: name || UNKNOWN,
    lineNumber: Number(parts[3]),
    column: parts[4] ? Number(parts[4]) : null,
  };
}

/**
 * Parses a JS stack (or a React `componentStack`) into frames, top first.
 * Chrome/V8, a V8/Hermes frame with no recognised scheme (which also covers
 * a Hermes release "address at" frame and a Metro-URL frame identically),
 * JSC and "in X (at f:l)" lines are recognised; anything else -- the
 * "Name: message" header (stripped by the caller before this runs, not
 * here), a blank line, a line no pattern matches -- produces no frame and
 * is skipped.
 *
 * Bounded against a hostile `stack` on every axis that matters: the input
 * length, each line's length (`STACK_MAX_INPUT_LENGTH`/`STACK_MAX_LINE_LENGTH`),
 * and the number of frames produced (`maxFrames`, stopped as soon as it is
 * reached, so a stack with millions of matching lines does not keep going
 * past the caller's own cap).
 */
export function parseStack(
  stack: string,
  maxFrames: number = Number.POSITIVE_INFINITY,
): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  const bounded = stack.length > STACK_MAX_INPUT_LENGTH ? stack.slice(0, STACK_MAX_INPUT_LENGTH) : stack;

  for (const originalLine of bounded.split('\n')) {
    if (frames.length >= maxFrames) {
      break;
    }

    const raw =
      originalLine.length > STACK_MAX_LINE_LENGTH
        ? originalLine.slice(0, STACK_MAX_LINE_LENGTH)
        : originalLine;
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const frame =
      parseChrome(trimmed) ?? parseNode(trimmed) ?? parseJsc(trimmed) ?? parseComponentStack(trimmed);

    if (frame) {
      frames.push({ ...frame, raw });
    }
  }

  return frames;
}

const FILE_SCHEME_RE = /^file:\/\//;
const ADDRESS_AT_RE = /^address at /;

/**
 * Steps 1-2 of "The payload (exact)": strips a leading `file://` and then a
 * leading `address at `. This is the join key between a registration stack's
 * top frame and a crash frame's file (Task 7.3, R5) -- it is deliberately
 * less aggressive than `cleanSource`, since steps 3-5 there would not agree
 * between the two.
 */
export function fileKey(file: string): string {
  return file.replace(FILE_SCHEME_RE, '').replace(ADDRESS_AT_RE, '');
}

const IOS_APP_BUNDLE_RE = /^.*\/[^/]+\.app\//;
const IOS_DATA_CONTAINER_RE = /^\/var\/mobile\/Containers\/Data\/Application\/[^/]+\//;
const ANDROID_DATA_DIR_RE = /^\/data\/(?:data|user\/\d+)\/[^/]+\//;

/**
 * Steps 1-5 of "The payload (exact)": `fileKey`, then strips an iOS app
 * bundle path, the iOS data container and the Android data directory (where
 * CodePush keeps bundles). `null` (no file) becomes `''`.
 */
export function cleanSource(file: string | null): string {
  if (file === null) {
    return '';
  }

  return fileKey(file)
    .replace(IOS_APP_BUNDLE_RE, '')
    .replace(IOS_DATA_CONTAINER_RE, '')
    .replace(ANDROID_DATA_DIR_RE, '');
}
