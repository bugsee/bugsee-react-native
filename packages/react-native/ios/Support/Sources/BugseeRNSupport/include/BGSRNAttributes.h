#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Mirrors the SDK's `CUSTOM_ATTRIBUTE_SIZE_LIMIT` (design doc, Phase 5
/// verified facts): `+[Bugsee setAttribute:withValue:]` archives the value
/// with `NSKeyedArchiver` and silently drops it -- while still returning
/// `YES` -- once the archive exceeds this many bytes. Exposed so a caller (and
/// this class's own tests) can reason about the boundary without
/// hardcoding it twice.
FOUNDATION_EXPORT const NSInteger BGSRNAttributeArchiveLimit;

/// The custom-attribute and identity rules, between the JS wire shape and the
/// SDK's `+[Bugsee ...]` attribute surface. The iOS mirror of Android's
/// `AttributeBridge`.
///
/// This class links no SDK: `+setValue:forKey:setter:getter:` takes the SDK's
/// setter/getter as blocks, so it (and its tests) never need `Bugsee.h` --
/// the caller (`BugseeModule.mm`, which does import it) supplies
/// `^(k, v){ return [Bugsee setAttribute:k withValue:v]; }` and
/// `^(k){ return [Bugsee getAttribute:k]; }`.
@interface BGSRNAttributes : NSObject

/// Sets `value` for `key` through `setter`, then verifies with `getter`
/// rather than trusting the setter's own return: neither SDK's
/// `setAttribute` reports a dropped value truthfully -- iOS's own
/// `+setAttribute:withValue:` returns `YES` even when it silently drops a
/// value for size (design doc, Phase 5 verified facts) -- so a read-back is
/// the only honest signal.
///
/// `NO` from `setter` short-circuits to `NO` without calling `getter`: the
/// SDK is telling us outright nothing was set, and reading back would only
/// risk agreeing by coincidence with a stale value already there.
/// Otherwise, `YES` only when `getter(key)` is non-nil and `isEqual:` to
/// `value` afterwards.
+ (BOOL)setValue:(id)value
           forKey:(NSString *)key
           setter:(BOOL (^)(NSString *key, id value))setter
           getter:(id _Nullable (^)(NSString *key))getter;

/// The persisted attributes as JS can carry them: `string | number | boolean
/// | string[]`.
///
/// A key that is not an `NSString` is dropped along with its value. `raw`'s
/// values pass through as: an `NSString` or `NSNumber` (a `CFBoolean` kept by
/// object identity, exactly as stored -- unlike Android, iOS never widens or
/// narrows a number on the way out); an `NSArray`, kept as an array of just
/// its `NSString` elements (mirrors Android's `Set<String>` -> `List<String>`,
/// the one collection type common to both platforms' output); anything else
/// (`NSDate`, `NSData`, a nested collection, ...) has no JS representation
/// and is dropped. `nil` reads as no attributes.
+ (NSDictionary<NSString *, id> *)readable:(nullable NSDictionary *)raw;

/// The user identifier as JS should see it: `nil` and `@""` both read as
/// absent. iOS's own `+getUserIdentifier` already never returns `@""` (it
/// clears the Keychain entry on an empty `+setUserIdentifier:`), but this
/// keeps the rule explicit and in parity with Android, where an empty string
/// is stored and read back as given.
+ (nullable NSString *)identifier:(nullable NSString *)raw;

@end

NS_ASSUME_NONNULL_END
