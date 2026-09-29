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

/**
 * `value` as JSON text for the bridge.
 *
 * `value` must already be validated and plain -- finite numbers only, no
 * `undefined` array elements, no cycles -- as `copyEventParams` and
 * `validateReportPatch` guarantee. This does no validation of its own:
 * `JSON.stringify` would silently turn `NaN` into `null` and drop an
 * `undefined` member, and those are the validators' to reject, not this
 * function's to paper over.
 */
export function encodeBridgeObject(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(value);
}
