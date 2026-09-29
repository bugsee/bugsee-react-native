#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSErrorDomain const BGSRNJSONErrorDomain;

/// The JSON object `json` holds, as Foundation: `NSDictionary`, `NSArray`,
/// `NSString`, `NSNumber` (an integral literal as an integer number, a
/// fraction or exponent as a double, `true`/`false` as the CFBoolean
/// singletons) and `NSNull` for every `null` -- kept, as a key that is there.
///
/// The iOS end of the one transport object payloads cross the bridge as
/// (`encodeBridgeObject` in `src/bridge/json.ts`). Not an `NSDictionary`
/// argument: React Native's TurboModule conversion of one
/// (`convertJSIObjectToNSDictionary`) skips every member whose value is JS
/// `null` unless an app-level feature flag is on, so "clear this" arrived as
/// "leave this alone".
///
/// nil, with an error in `BGSRNJSONErrorDomain`, when `json` is nil or not
/// exactly one JSON object: a syntax error, another kind of value, or
/// trailing text.
FOUNDATION_EXPORT NSDictionary<NSString *, id> *_Nullable BGSRNJSONObject(NSString *_Nullable json,
                                                                         NSError **error);

NS_ASSUME_NONNULL_END
