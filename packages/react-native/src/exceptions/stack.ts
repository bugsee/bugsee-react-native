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

// Chrome/V8 (and a Hermes frame served from a Metro dev-server URL, which has
// the same "at name (url:line:col)" shape): the file must start with one of
// these recognised schemes/paths, which is what lets a native/no-location
// frame ("at forEach (native)") and a real file both match one pattern.
const CHROME_RE =
  /^\s*at (.*?) ?\(((?:file|https?|blob|chrome-extension|native|eval|webpack|<anonymous>|\/|[a-z]:\\|\\\\).*?)(?::(\d+))?(?::(\d+))?\)?\s*$/i;

// A Hermes release frame: "at name (address at file:line:col)". The file
// group deliberately keeps the "address at " prefix -- `fileKey`/`cleanSource`
// strip it, so the raw frame's `file` and a registration stack's top frame
// (Task 7.3) normalise the same way.
const HERMES_ADDRESS_RE = /^\s*at (.*?) \((address at .*?):(\d+):(\d+)\)\s*$/i;

// JavaScriptCore: "name@file:line:col", or just "file:line:col".
const JSC_RE = /^\s*(?:([^@]*)@)?(\S.*?):(\d+)(?::(\d+))?\s*$/i;

// A React `componentStack` line: "in ComponentName (at File.js:10)".
const COMPONENT_STACK_RE = /^\s*in\s+(.*?)\s*\(at\s+(.*?):(\d+)(?::(\d+))?\)\s*$/i;

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

function parseHermesAddress(line: string): ParsedFrame | null {
  const parts = HERMES_ADDRESS_RE.exec(line);
  if (!parts) {
    return null;
  }

  return {
    raw: line,
    // Group 2 is mandatory in HERMES_ADDRESS_RE, so it is always captured on a match.
    file: parts[2] as string,
    methodName: parts[1] || null,
    lineNumber: Number(parts[3]),
    column: Number(parts[4]),
  };
}

function parseJsc(line: string): ParsedFrame | null {
  const parts = JSC_RE.exec(line);
  if (!parts) {
    return null;
  }

  return {
    raw: line,
    // Group 2 is mandatory in JSC_RE, so it is always captured on a match.
    file: parts[2] as string,
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

  return {
    raw: line,
    // Group 2 is mandatory in COMPONENT_STACK_RE, so it is always captured on a match.
    file: parts[2] as string,
    methodName: parts[1] || UNKNOWN,
    lineNumber: Number(parts[3]),
    column: parts[4] ? Number(parts[4]) : null,
  };
}

/**
 * Parses a JS stack (or a React `componentStack`) into frames, top first.
 * Chrome/V8, Hermes (a Metro-URL frame or a release "address at" frame), JSC
 * and "in X (at f:l)" lines are recognised; anything else -- the "Name:
 * message" header, a blank line, a line no pattern matches -- produces no
 * frame and is skipped.
 */
export function parseStack(stack: string): ParsedFrame[] {
  const frames: ParsedFrame[] = [];

  for (const line of stack.split('\n')) {
    const frame =
      parseChrome(line) ?? parseHermesAddress(line) ?? parseJsc(line) ?? parseComponentStack(line);

    if (frame) {
      frames.push(frame);
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
