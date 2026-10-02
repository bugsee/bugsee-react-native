/**
 * The one transport for an object payload that may carry `null` members:
 * JSON text, parsed natively (Android `BridgeJson`, iOS `BGSRNJSONObject`).
 *
 * Not `UnsafeObject`. React Native's iOS TurboModule conversion of an object
 * argument (`convertJSIObjectToNSDictionary` in `RCTTurboModule.mm`) skips
 * every member whose converted value is `nil`, and a JS `null` converts to
 * `nil` unless the app turns on
 * `enableModuleArgumentNSNullConversionIOS` -- off by default, and not a flag
 * a library can depend on across its 0.81 floor. So `{ summary: null }`
 * reached iOS as `{}`: "clear this" arrived as "leave it alone", while
 * Android's `ReadableMap` kept the null. As text, a null is just `null` on
 * both.
 *
 * Every object payload with nullable members uses this: event params, the
 * report patch, and Phase 5's attribute maps.
 */

const REPLACEMENT_CHARACTER = '\uFFFD';

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * `text` with every lone UTF-16 surrogate replaced by U+FFFD, and every valid
 * pair kept -- `String.prototype.toWellFormed`, for an engine without it.
 * Exported for its tests, which run on an engine that has it.
 */
export function replaceLoneSurrogates(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(i + 1))) {
      result += text.slice(i, i + 2);
      i += 1;
    } else if (isHighSurrogate(code) || isLowSurrogate(code)) {
      result += REPLACEMENT_CHARACTER;
    } else {
      result += text[i];
    }
  }
  return result;
}

/** ES2024's `toWellFormed` when the engine has it (Hermes may not), else the fallback. */
function wellFormed(text: string): string {
  const native = (text as { toWellFormed?: () => string }).toWellFormed;
  return typeof native === 'function' ? native.call(text) : replaceLoneSurrogates(text);
}

/**
 * A copy of `value` whose every string, key or value, is well-formed.
 *
 * Why: `JSON.stringify` writes a lone surrogate as the escape `\ud83d`, and
 * iOS's `NSJSONSerialization` rejects the WHOLE text for it, so a summary cut
 * mid-emoji (`text.slice(0, 100)`) would reject on iOS and resolve on
 * Android, and such an event would be dropped on iOS alone. Before this
 * transport, React Native's own string conversion turned a lone surrogate
 * into U+FFFD on both; this keeps that. Two keys that differ only in a lone
 * surrogate become the same key, and the later one wins.
 *
 * Built on a prototype-less object, so a "__proto__" key stays an ordinary
 * key rather than hitting `Object.prototype`'s setter.
 */
function wellFormedCopy(value: unknown): unknown {
  if (typeof value === 'string') {
    return wellFormed(value);
  }
  if (Array.isArray(value)) {
    return value.map(wellFormedCopy);
  }
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const copy: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(source)) {
      copy[wellFormed(key)] = wellFormedCopy(source[key]);
    }
    return copy;
  }
  return value;
}

/**
 * `value` as JSON text for the bridge, every string in it well-formed
 * (lone surrogates replaced by U+FFFD; see `wellFormedCopy`).
 *
 * `value` must already be validated and plain -- finite numbers only, no
 * `undefined` array elements, no cycles -- as `copyEventParams` and
 * `validateReportPatch` guarantee. This does no validation of its own:
 * `JSON.stringify` would silently turn `NaN` into `null` and drop an
 * `undefined` member, and those are the validators' to reject, not this
 * function's to paper over.
 */
export function encodeBridgeObject(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(wellFormedCopy(value));
}

/**
 * One JSON value for the bridge, strings well-formed the same way as
 * {@link encodeBridgeObject}. A lone surrogate becomes U+FFFD before
 * `JSON.stringify`, so iOS `NSJSONSerialization` does not reject the text.
 */
export function encodeBridgeJson(value: unknown): string {
  return JSON.stringify(wellFormedCopy(value));
}
